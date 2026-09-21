/**
 * Finity Game Engine — Core
 *
 * Pure consts only. No side effects, no DOM, no randomness.
 * Given the same inputs, always produces the same outputs.
 * applyMove returns a NEW state; it never mutates the input.
 */

import type {
    FinityGameState,
    GameConfig,
    BoardState,
    StationState,
    SlotState,
    ArrowState,
    RingState,
    BlockerState,
    BasePostMove,
    MoveAction,
    RecordedMove,
    PlayerColor,
    ArrowColor,
    StationName,
    Channel,
} from './types';

import {
    isArrow, isRing, isBlocker, isBasePost,
} from './types';

import {
    buildTopology,
    STATION_SLOTS,
    getSlotInterferences,
    getSlotNeighbors,
} from './topology';

import {
    reachableStations,
    hasFullPath,
    fullPathStationCount,
    bestPathStationCount,
    invalidatePathCache
} from './path-analyzer';

import { computeZobristHash } from './zobrist';
import { boardHash } from './no-undo';

// =============================================================
// Tunables
// =============================================================

/**
 * Number of full rounds without any change to the total ring count after which
 * the game is declared a draw (deadlock). Scaled by player count into a turn limit inside checkVictory
 */
export const DRAW_ROUND_LIMIT = 10;


// =============================================================
// Game Creation
// =============================================================

/**
 * Create a new game from a config.
 * pathPattern must be provided (the engine doesn't generate randomness).
 * The caller is responsible for generating the path pattern.
 */
export const createGame = (
    config: GameConfig,
    pathPattern: ArrowColor[],
): FinityGameState => {
    const { playerColors, boardSize } = config;
    const topology = buildTopology(boardSize);
    const board = createInitialBoard(topology.stations, playerColors, topology.startStations);

    const game: FinityGameState = {
        version: 1,
        gsId: '',  // assigned externally (by orchestrator or DB)
        config,
        board,
        turnIndex: 0,
        defaulted: [],
        playStatus: 'playing',
        moveHistory: [],
        winners: [],
        pathPattern,
        turnsSinceRingChange: 0,
        zobristHash: '0',
    };

    game.zobristHash = computeZobristHash(game);
    return game;
}

/**
 * Create the initial board state with base posts and center rings.
 */
const createInitialBoard = (
    stations: StationName[],
    playerColors: PlayerColor[],
    startStations: StationName[],
): BoardState => {
    // Initialize all stations
    const stationMap: Record<string, StationState> = {};
    for (const name of stations) {
        stationMap[name] = {
            id: name,
            coord: '',
            rings: [null, null, null],
            basePost: null,
        };
    }

    // Always include center
    if (!stationMap['C']) {
        stationMap['C'] = { id: 'C', coord: '0,0', rings: [null, null, null], basePost: null };
    }

    // Place base posts at start stations
    playerColors.forEach((color, i) => {
        const station = startStations[i];
        if (stationMap[station]) {
            stationMap[station].basePost = color;
        }
    });

    // Place initial rings on the center station: one large ring per player, bottom to top in reverse seating order

    const reversedColors = [...playerColors].reverse();
    stationMap['C'].rings = [
        reversedColors[0] ? { type: 'ring', color: reversedColors[0], size: 'l' } as RingState : null,
        reversedColors[1] ? { type: 'ring', color: reversedColors[1], size: 'l' } as RingState : null,
        reversedColors[2] ? { type: 'ring', color: reversedColors[2], size: 'l' } as RingState : null,
    ];

    // Initialize all 72 slots as empty
    const slots: SlotState[] = Array.from({ length: 72 }, (_, i) => ({
        id: i,
        contains: null,
        blocked: false,
    }));

    // Place initial blockers: each player gets 2 blockers on L and R channels
    // from their start station toward center
    playerColors.forEach((color, i) => {
        const startStation = startStations[i];
        const stationSlots = STATION_SLOTS[startStation];
        if (stationSlots && stationSlots['C' as StationName]) {
            const channels = stationSlots['C' as StationName] as Record<Channel, number>;
            if (channels.L !== undefined) {
                slots[channels.L].contains = { type: 'blocker', color, slotId: channels.L };
            }
            if (channels.R !== undefined) {
                slots[channels.R].contains = { type: 'blocker', color, slotId: channels.R };
            }
        }
    });

    return {
        stations: stationMap as Record<StationName, StationState>,
        slots,
    };
}

// =============================================================
// State Queries
// =============================================================

/** Get the color of the current player */
export const PATH_INDICATOR_SUPPLY: Readonly<Record<ArrowColor, number>> = { b: 6, w: 6 };

/** Length of the path pattern drawn at setup */
export const PATH_PATTERN_LENGTH = 8;

/**
 * Draw the path pattern for a game - Indicators are drawn one at a time from a shared pool of six black and six
 * white, WITHOUT replacement.
 */
export const drawPathPattern = (rng: () => number = Math.random): ArrowColor[] => {
    const pool: Record<ArrowColor, number> = { ...PATH_INDICATOR_SUPPLY };
    const pattern: ArrowColor[] = [];

    for (let i = 0; i < PATH_PATTERN_LENGTH; i++) {
        const remaining = pool.b + pool.w;
        // Exhausting the pool would mean the supply constants disagree with the
        // pattern length; fail loudly rather than emit a short pattern.
        if (remaining <= 0) {
            throw new Error('[finity] path indicator supply exhausted before the pattern was complete');
        }
        const color: ArrowColor = rng() * remaining < pool.b ? 'b' : 'w';
        pool[color]--;
        pattern.push(color);
    }

    return pattern;
};

/** Get the color of the current player */
export const currentPlayer = (state: FinityGameState): PlayerColor => {
    return state.config.playerColors[state.turnIndex];
}

/** Check if the game is over */
export const isGameOver = (state: FinityGameState): boolean => {
    return state.playStatus === 'over';
}

/** Get the ring count on a station */
export const stationRingCount = (station: StationState): number => {
    return station.rings.filter(r => r !== null).length;
}

/** Get the topmost opening size on a station */
export const topmostOpening = (
    station: StationState
): 's' | 'm' | 'l' | null => {
    if (!station.rings[0]) return 's';
    if (!station.rings[1]) return 'm';
    if (!station.rings[2]) return 'l';

    return null; // station is full
}

/** Which color controls a station (highest/innermost piece)? */
export const stationControlledBy = (
    station: StationState
): PlayerColor | null => {
    if (station.basePost) return station.basePost;
    if (station.rings[0]) return station.rings[0].color;
    if (station.rings[1]) return station.rings[1].color;
    if (station.rings[2]) return station.rings[2].color;

    return null;
}

/** Does the color occupy the high point on a station? */
export const occupiesHighPoint = (
    state: FinityGameState,
    color: PlayerColor,
    stationName: StationName
): boolean => {
    const station = state.board.stations[stationName];
    if (!station) return false;

    if (station.basePost && station.basePost === color) return true;
    if (!station.basePost && station.rings[0]?.color === color) return true;
    if (!station.basePost && !station.rings[0] && station.rings[1]?.color === color) return true;
    if (!station.basePost && !station.rings[0] && !station.rings[1] && station.rings[2]?.color === color) return true;
    return false;
}

/** Get all arrows currently on the board */
export const getAllArrows = (state: FinityGameState): ArrowState[] => {
    return state.board.slots
        .filter(s => s.contains?.type === 'arrow')
        .map(s => s.contains as ArrowState);
}

/** Get all blockers currently on the board */
export const getAllBlockers = (state: FinityGameState): BlockerState[] => {
    return state.board.slots
        .filter(s => s.contains?.type === 'blocker')
        .map(s => s.contains as BlockerState);
}

/** Get all rings on the board */
export const getAllRings = (
    state: FinityGameState
): (RingState & { station: StationName })[] => {
    const rings: (RingState & { station: StationName })[] = [];
    for (const [name, station] of Object.entries(state.board.stations)) {
        for (const ring of station.rings) {
            if (ring) {
                rings.push({ ...ring, station: name as StationName });
            }
        }
    }
    return rings;
}

/** Count arrows on the board */
export const arrowCount = (state: FinityGameState): number => {
    return state.board.slots.filter(s => s.contains?.type === 'arrow').length;
}

/** Count rings for a color */
export const ringCount = (state: FinityGameState, color: PlayerColor): number => {
    let count = 0;
    for (const station of Object.values(state.board.stations)) {
        for (const ring of station.rings) {
            if (ring?.color === color) count++;
        }
    }
    return count;
}

/** Get outgoing arrows from a station of a specific color */
export const outArrows = (
    state: FinityGameState,
    stationName: StationName,
    arrowColor: ArrowColor
): ArrowState[] => {
    const arrows: ArrowState[] = [];
    const stationSlots = STATION_SLOTS[stationName];
    if (!stationSlots) return arrows;

    for (const [_neighbor, channels] of Object.entries(stationSlots)) {
        for (const [_channel, slotId] of Object.entries(channels as Record<string, number>)) {
            const slot = state.board.slots[slotId];
            if (
                slot.contains?.type === 'arrow' &&
                slot.contains.fromStation === stationName &&
                slot.contains.color === arrowColor
            ) {
                arrows.push(slot.contains);
            }
        }
    }

    return arrows;
}

// =============================================================
// Move Validation Helpers
// =============================================================

/** Check if placing in a slot would violate first-move restrictions */
export const canBlockSlot = (
    state: FinityGameState,
    slotId: number,
    playerColor: PlayerColor,
    moveType: 'arrow' | 'blocker',
): boolean => {
    // First move restriction only applies on the very first move
    if (state.moveHistory.length > 0) return true;

    const activeStations = Object.keys(state.board.stations) as StationName[];

    for (const stationName of activeStations) {
        const station = state.board.stations[stationName];

        // Check stations with opponent base posts
        if (station.basePost && station.basePost !== playerColor) {
            const stationSlots = STATION_SLOTS[stationName];
            if (!stationSlots) continue;

            for (const [_neighbor, channels] of Object.entries(stationSlots)) {
                for (const [_ch, sId] of Object.entries(channels as Record<string, number>)) {
                    if (sId === slotId) return false;
                    if (moveType === 'arrow') {
                        const interferences = getSlotInterferences(sId);
                        if (interferences.includes(slotId)) return false;
                    }
                }
            }
        }
    }

    return true;
}

/** Check if an arrow is redundant (same color+direction in a neighbor slot) */
export const isRedundant = (
    state: FinityGameState,
    slotId: number,
    toStation: StationName,
    arrowColor: ArrowColor,
): boolean => {
    const neighbors = getSlotNeighbors(slotId);
    for (const neighborId of neighbors) {
        const neighbor = state.board.slots[neighborId];
        if (
            neighbor.contains?.type === 'arrow' &&
            neighbor.contains.toStation === toStation &&
            neighbor.contains.color === arrowColor
        ) {
            return true;
        }
    }
    return false;
}


// =============================================================
// Move Application (returns NEW state, never mutates)
// =============================================================

/**
 * Apply a move to the game state.
 * Returns a new FinityGameState. The input is NOT modified.
 */
export const applyMove = (
    state: FinityGameState,
    move: MoveAction
): FinityGameState => {
    // Deep clone the state
    const next: FinityGameState = structuredClone(state) as unknown as FinityGameState;
    next.prevBoardHash = boardHash(state);
    next.turnsSinceRingChange = state.turnsSinceRingChange + 1;

    const { type, pieceToAdd, pieceToRemove } = move;

    if (type === 'place') {
        if (pieceToAdd && isArrow(pieceToAdd)) {
            placeArrow(next, pieceToAdd);
        } else if (pieceToAdd && isRing(pieceToAdd)) {
            placeRing(next, pieceToAdd, move);
        }
    } else if (type === 'remove') {
        if (pieceToRemove && pieceToRemove.type === 'arrow') {
            removeArrow(next, pieceToRemove as ArrowState);
        } else if (pieceToRemove && pieceToRemove.type === 'blocker') {
            removeBlocker(next, pieceToRemove as BlockerState);
        }
    } else if (type === 'replace') {
        if (pieceToAdd && isArrow(pieceToAdd)) {
            // Arrow reversal: remove old, place new, Then sweep orphans once against the finished board
            if (pieceToRemove) removeArrow(next, pieceToRemove as ArrowState, false);
            placeArrow(next, pieceToAdd);
            reevaluateRingSupport(next);
        } else if (pieceToAdd && isBlocker(pieceToAdd)) {
            // Blocker move: remove from old slot, place in new
            if (pieceToRemove) removeBlocker(next, pieceToRemove as BlockerState);
            placeBlockerInSlot(next, pieceToAdd);
        } else if (pieceToAdd && isBasePost(pieceToAdd)) {
            moveBasePost(next, pieceToAdd);
        }
    }

    // Record the move
    const recorded: RecordedMove = {
        move,
        color: currentPlayer(next),
        timestamp: Date.now(),
        moveIndex: next.moveHistory.length,
    };

    next.moveHistory = [...next.moveHistory, recorded];

    // Deadlock / draw bookkeeping
    if (move.type === 'place' && move.pieceToAdd?.type === 'ring') {
        next.turnsSinceRingChange = 0;
    }


    // Advance turn
    if (next.playStatus !== 'over') {
        advanceTurn(next);
    }

    // Refresh the position hash last, so side-to-move (turnIndex) is final
    next.zobristHash = computeZobristHash(next);
    invalidatePathCache(next); // bundles cached mid-mutation are now unreachable

    return next;
}

// =============================================================
// Internal Mutation Helpers (operate on the cloned state)
// =============================================================

const placeArrow = (state: FinityGameState, arrow: ArrowState): void => {
    const slot = state.board.slots[arrow.slotId];
    slot.contains = { ...arrow };

    // Apply interference: block adjacent slots
    const interferences = getSlotInterferences(arrow.slotId);
    for (const interferingId of interferences) {
        state.board.slots[interferingId].blocked = true;
    }
}

/**
 * sweepOrphans pass false when this removal is one half of a compound move (arrow reversal).
 */
const removeArrow = (
    state: FinityGameState,
    arrow: ArrowState,
    sweepOrphans = true
): void => {
    const slot = state.board.slots[arrow.slotId];
    slot.contains = null;

    // Remove interference: unblock adjacent slots
    const interferences = getSlotInterferences(arrow.slotId);
    for (const interferingId of interferences) {
        state.board.slots[interferingId].blocked = false;
    }

    // Reevaluate ring support — orphan check for all players
    if (sweepOrphans) reevaluateRingSupport(state);
}

const placeRing = (
    state: FinityGameState,
    ring: RingState,
    move: MoveAction
): void => {
    // target station is carried on the move (rings don't store their own station; once placed
    // position in board.stations[name].rings is the truth)
    const stationName = move.station;
    if (!stationName) return;

    const station = state.board.stations[stationName];
    if (!station) return;

    // ring's size determine its slot: [small, medium, large] => [0, 1, 2]
    // applyMove assumes the move was already validated by possibleMoves
    const sizeIndex = ring.size === 's' ? 0 : ring.size === 'm' ? 1 : 2;
    if (station.rings[sizeIndex]) return;  // slot already occupied
    station.rings[sizeIndex] = { type: 'ring', color: ring.color, size: ring.size };

    state.turnsSinceRingChange = 0;
}

const removeRing = (
    state: FinityGameState,
    stationName: StationName,
    size: 's' | 'm' | 'l'
): void => {
    const station = state.board.stations[stationName];
    const sizeIndex = size === 's' ? 0 : size === 'm' ? 1 : 2;
    station.rings[sizeIndex] = null;
    state.turnsSinceRingChange = 0;
}

const removeBlocker = (state: FinityGameState, blocker: BlockerState): void => {
    state.board.slots[blocker.slotId].contains = null;
}

const placeBlockerInSlot = (state: FinityGameState, blocker: BlockerState): void => {
    state.board.slots[blocker.slotId].contains = { ...blocker };
}

const moveBasePost = (state: FinityGameState, move: BasePostMove): void => {
    // Remove base post from current station
    for (const station of Object.values(state.board.stations)) {
        if (station.basePost === move.color) {
            station.basePost = null;
            break;
        }
    }

    // Place on new station
    state.board.stations[move.toStation].basePost = move.color;

    // Reevaluate ring support after base post move
    reevaluateRingSupport(state);
}

const reevaluateRingSupport = (state: FinityGameState): void => {
    // Check all players for orphaned rings
    for (const color of state.config.playerColors) {
        clearOrphans(state, color);
    }
}

const clearOrphans = (state: FinityGameState, color: PlayerColor): void => {
    // A ring is "orphaned" when its station can no longer be reached by any legal
    // path from the player's base post. Removing an arrow, reversing one, or
    // moving a base post can sever support, so this runs after every structural change
    const supported = reachableStations(state, color);
    for (const [name, station] of Object.entries(state.board.stations)) {
        if (name === 'C') continue;
        if (supported.has(name as StationName)) continue;

        for (let i = 0; i < station.rings.length; i++) {
            const ring = station.rings[i];
            if (ring && ring.color === color) {
                station.rings[i] = null;
                state.turnsSinceRingChange = 0;
            }
        }
    }
}

// =============================================================
// Turn Management
// =============================================================

const advanceTurn = (state: FinityGameState): void => {
    checkVictory(state);

    if (state.playStatus === 'over') {
        state.turnIndex = -1;
        return;
    }

    const playerCount = state.config.playerColors.length;
    state.turnIndex = (state.turnIndex + 1) % playerCount;

    // Skip winners in multiplayer games - also any defaulters
    while (isFinished(state, state.config.playerColors[state.turnIndex])) {
        state.turnIndex = (state.turnIndex + 1) % playerCount;
    }
}

export const isFinished = (state: FinityGameState, color: PlayerColor): boolean =>
    state.winners.includes(color) || state.defaulted.includes(color);

/** Players still taking turns. */
export const continuingPlayers = (state: FinityGameState): PlayerColor[] =>
    state.config.playerColors.filter((c) => !isFinished(state, c));

/**
 * The shared tiebreak - Ranks players by distinct stations covered on their
 * best path, then by rings on the board. Returns ordered groups; a group with
 * more than one member is a genuine tie and stays level rather than being
 * broken arbitrarily.
 */
const rankByTiebreak = (
    state: FinityGameState,
    players: PlayerColor[],
    metric: (state: FinityGameState, color: PlayerColor) => number
): PlayerColor[][] => {
    const scored = players.map((color) => ({
        color,
        distinct: metric(state, color),
        rings: ringCount(state, color),
    })).sort((x, y) => (y.distinct - x.distinct) || (y.rings - x.rings));

    const groups: PlayerColor[][] = [];
    for (const entry of scored) {
        const top = groups[groups.length - 1];
        const prev = top ? scored[scored.findIndex((s) => s.color === top[0])] : null;
        if (prev && prev.distinct === entry.distinct && prev.rings === entry.rings) {
            top.push(entry.color);
        } else {
            groups.push([entry.color]);
        }
    }

    return groups;
}

/**
 * Final standings: finishers in order, then remaining players by tiebreak,
 *  then defaulters last.
 */
const buildRanking = (state: FinityGameState): PlayerColor[][] => {
    const ranking: PlayerColor[][] = state.winners.map((w) => [w]);

    const rest = state.config.playerColors.filter(
        (c) => !state.winners.includes(c) && !state.defaulted.includes(c)
    );
    if (rest.length > 0) {
        ranking.push(...rankByTiebreak(state, rest, bestPathStationCount));
    }
    if (state.defaulted.length > 0) ranking.push([...state.defaulted]);

    return ranking;
}

const checkVictory = (state: FinityGameState): void => {
    // A single move can complete paths for more than one player at once, because bridges are shared resources
    // simultaneous completions must be ranked rather than pushed in player order
    const newWinners: PlayerColor[] = [];

    for (const color of state.config.playerColors) {
        // skip if current color is in the winner's list
        if (state.winners.includes(color)) continue;

        //  victory requires both the ring threshold and a complete supported path
        // (9 stations ending at center)
        if (ringCount(state, color) >= 7 && hasFullPath(state, color)) {
            newWinners.push(color);
        }
    }

    if (newWinners.length === 1) {
        state.winners.push(newWinners[0]);
    } else if (newWinners.length > 1) {
        // player with more distinct stations wins on a tie break
        const ranked = newWinners.map((color) => ({
            color,
            distinct: fullPathStationCount(state, color),
            rings: ringCount(state, color),
        })).sort((x, y) => (y.distinct - x.distinct) || (y.rings - x.rings));

        for (const entry of ranked) state.winners.push(entry.color);
    }

    // Game is over when all but one player has won
    if (state.winners.length >= state.config.playerColors.length - 1) {
        state.playStatus = 'over';
        state.endReason = state.winners.length > 0 ? 'path_complete' : 'forced_draw';
        return;
    }

    // deadlock / draw - if the board has gone too long with no change in
    // the total ring count, no one can make progress
    const drawTurnLimit = DRAW_ROUND_LIMIT * state.config.playerColors.length;
    if (state.turnsSinceRingChange >= drawTurnLimit) {
        state.playStatus = 'over';
        state.endReason = 'forced_draw';
    }
}
