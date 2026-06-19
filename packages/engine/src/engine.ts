/**
 * Finity Game Engine — Core
 *
 * Pure functions only. No side effects, no DOM, no randomness.
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
    ValidationResult,
    PlayerColor,
    ArrowColor,
    StationName,
    Channel,
    GamePiece,
} from './types';

import {
    isArrow, isRing, isBlocker, isBasePost,
} from './types';

import {
    buildTopology,
    STATION_SLOTS,
    STATIONS_BY_PLAYER_COUNT,
    START_STATIONS,
    toStationName,
    getSlotInterferences,
    getSlotNeighbors,
} from './topology';

import {
    reachableStations,
    hasFullPath
} from './pathAnalyzer';

// =============================================================
// Game Creation
// =============================================================

/**
 * Create a new game from a config.
 * pathPattern must be provided (the engine doesn't generate randomness).
 * The caller is responsible for generating the path pattern.
 */
export function createGame(
    config: GameConfig,
    pathPattern: ArrowColor[],
): FinityGameState {
    const { playerColors, boardSize } = config;
    const topology = buildTopology(boardSize);
    const board = createInitialBoard(topology.stations, playerColors, topology.startStations);

    return {
        version: 1,
        gsId: '',  // assigned externally (by orchestrator or DB)
        config,
        board,
        turnIndex: 0,
        playStatus: 'playing',
        moveHistory: [],
        winners: [],
        pathPattern,
        turnsSinceRingChange: 0,
        zobristHash: '0',  // TODO: compute initial hash
    };
}

/**
 * Create the initial board state with base posts and center rings.
 */
function createInitialBoard(
    stations: StationName[],
    playerColors: PlayerColor[],
    startStations: StationName[],
): BoardState {
    // Initialize all stations
    const stationMap: Record<string, StationState> = {};
    for (const name of stations) {
        stationMap[name] = {
            id: name,
            coord: '', // populated below if needed
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

    // Place initial rings on center station (one large ring per player, reverse order)
    // In the original code: players reversed, each gets a 'l' (large) ring
    // The center station rings array is [small, medium, large] but initial setup
    // pushes large rings. With 4 players, only 3 ring slots exist on center.
    // Original code pushes to the rings array which is separate from the [s,m,l] slots.
    // For the new design: center gets one large ring per player (up to 3),
    // with the last player's ring being "on top" (smallest position).
    const centerRings: [RingState | null, RingState | null, RingState | null] = [null, null, null];
    const reversedColors = [...playerColors].reverse();
    reversedColors.forEach((color, i) => {
        if (i < 3) {
            centerRings[i] = { type: 'ring', color, size: 'l' };
        }
    });
    stationMap['C'].rings = centerRings;

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
export function currentPlayer(state: FinityGameState): PlayerColor {
    return state.config.playerColors[state.turnIndex];
}

/** Check if the game is over */
export function isGameOver(state: FinityGameState): boolean {
    return state.playStatus === 'over';
}

/** Get the ring count on a station */
export function stationRingCount(station: StationState): number {
    return station.rings.filter(r => r !== null).length;
}

/** Get the topmost opening size on a station */
export function topmostOpening(station: StationState): 's' | 'm' | 'l' | null {
    if (!station.rings[0]) return 's';
    if (!station.rings[1]) return 'm';
    if (!station.rings[2]) return 'l';
    return null; // station is full
}

/** Which color controls a station (highest/innermost piece)? */
export function stationControlledBy(station: StationState): PlayerColor | null {
    if (station.basePost) return station.basePost;
    if (station.rings[0]) return station.rings[0].color;
    if (station.rings[1]) return station.rings[1].color;
    if (station.rings[2]) return station.rings[2].color;
    return null;
}

/** Does the color occupy the high point on a station? */
export function occupiesHighPoint(state: FinityGameState, color: PlayerColor, stationName: StationName): boolean {
    const station = state.board.stations[stationName];
    if (!station) return false;

    if (station.basePost && station.basePost === color) return true;
    if (!station.basePost && station.rings[0]?.color === color) return true;
    if (!station.basePost && !station.rings[0] && station.rings[1]?.color === color) return true;
    if (!station.basePost && !station.rings[0] && !station.rings[1] && station.rings[2]?.color === color) return true;
    return false;
}

/** Get all arrows currently on the board */
export function getAllArrows(state: FinityGameState): ArrowState[] {
    return state.board.slots
        .filter(s => s.contains?.type === 'arrow')
        .map(s => s.contains as ArrowState);
}

/** Get all blockers currently on the board */
export function getAllBlockers(state: FinityGameState): BlockerState[] {
    return state.board.slots
        .filter(s => s.contains?.type === 'blocker')
        .map(s => s.contains as BlockerState);
}

/** Get all rings on the board */
export function getAllRings(state: FinityGameState): (RingState & { station: StationName })[] {
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
export function arrowCount(state: FinityGameState): number {
    return state.board.slots.filter(s => s.contains?.type === 'arrow').length;
}

/** Count rings for a color */
export function ringCount(state: FinityGameState, color: PlayerColor): number {
    let count = 0;
    for (const station of Object.values(state.board.stations)) {
        for (const ring of station.rings) {
            if (ring?.color === color) count++;
        }
    }
    return count;
}

/** Get outgoing arrows from a station of a specific color */
export function outArrows(state: FinityGameState, stationName: StationName, arrowColor: ArrowColor): ArrowState[] {
    const arrows: ArrowState[] = [];
    const stationSlots = STATION_SLOTS[stationName];
    if (!stationSlots) return arrows;

    for (const [neighbor, channels] of Object.entries(stationSlots)) {
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
export function canBlockSlot(
    state: FinityGameState,
    slotId: number,
    playerColor: PlayerColor,
    moveType: 'arrow' | 'blocker',
): boolean {
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
export function isRedundant(
    state: FinityGameState,
    slotId: number,
    toStation: StationName,
    arrowColor: ArrowColor,
): boolean {
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

/** Check no-immediate-undo rule for arrow moves */
export function canMakeArrowMoveInSlot(
    state: FinityGameState,
    slotId: number,
    arrowColor: ArrowColor,
    moveType: 'place' | 'remove' | 'replace',
): boolean {
    if (state.moveHistory.length === 0) return true;

    const lastMove = state.moveHistory[state.moveHistory.length - 1].move;

    if (moveType === 'place' && lastMove.type === 'remove') {
        const removed = lastMove.pieceToRemove;
        if (removed?.type === 'arrow' && removed.color === arrowColor && removed.slotId === slotId) {
            return false;
        }
    }

    if (moveType === 'remove' && lastMove.type === 'place') {
        const added = lastMove.pieceToAdd;
        if (added?.type === 'arrow' && added.color === arrowColor && (added as ArrowState).slotId === slotId) {
            return false;
        }
    }

    if (moveType === 'replace' && lastMove.type === 'replace') {
        const added = lastMove.pieceToAdd;
        if (added?.type === 'arrow' && added.color === arrowColor && (added as ArrowState).slotId === slotId) {
            return false;
        }
    }

    return true;
}

// =============================================================
// Move Application (returns NEW state, never mutates)
// =============================================================

/**
 * Apply a move to the game state.
 * Returns a new FinityGameState. The input is NOT modified.
 */
export function applyMove(state: FinityGameState, move: MoveAction): FinityGameState {
    // Deep clone the state
    const next: FinityGameState = structuredClone(state) as unknown as FinityGameState;
    // structuredClone doesn't handle bigint in all envs; restore it
    next.zobristHash = state.zobristHash;

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
            // Arrow reversal: remove old, place new
            if (pieceToRemove) removeArrow(next, pieceToRemove as ArrowState);
            placeArrow(next, pieceToAdd);
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

    // Advance turn
    if (next.playStatus !== 'over') {
        advanceTurn(next);
    }

    return next;
}

// =============================================================
// Internal Mutation Helpers (operate on the cloned state)
// =============================================================

function placeArrow(state: FinityGameState, arrow: ArrowState): void {
    const slot = state.board.slots[arrow.slotId];
    slot.contains = { ...arrow };

    // Apply interference: block adjacent slots
    const interferences = getSlotInterferences(arrow.slotId);
    for (const interferingId of interferences) {
        state.board.slots[interferingId].blocked = true;
    }
}

function removeArrow(state: FinityGameState, arrow: ArrowState): void {
    const slot = state.board.slots[arrow.slotId];
    slot.contains = null;

    // Remove interference: unblock adjacent slots
    const interferences = getSlotInterferences(arrow.slotId);
    for (const interferingId of interferences) {
        state.board.slots[interferingId].blocked = false;
    }

    // Reevaluate ring support — orphan check for all players
    reevaluateRingSupport(state);
}

function placeRing(state: FinityGameState, ring: RingState, move: MoveAction): void {
    // target station is carried on the move (rings don't store their own station; once placed
    // position in board.stations[name].rings is the truth)
    const stationName = move.station;
    if (!stationName) return;

    const station = state.board.stations[stationName];
    if (!station) return;

    // ring's size determine its slot: [small, medium, large] => [0, 1, 2]
    // applyMove assumes the move was already validated by possibleMoves
    const sizeIndex = ring.size === 's' ? 0: ring.size === 'm' ? 1: 2;
    if (station.rings[sizeIndex]) return;  // slot already occupied
    station.rings[sizeIndex] = { type: 'ring', color: ring.color, size: ring.size };

    state.turnsSinceRingChange = 0;
}

function removeRing(state: FinityGameState, stationName: StationName, size: 's' | 'm' | 'l'): void {
    const station = state.board.stations[stationName];
    const sizeIndex = size === 's' ? 0 : size === 'm' ? 1 : 2;
    station.rings[sizeIndex] = null;
    state.turnsSinceRingChange = 0;
}

function removeBlocker(state: FinityGameState, blocker: BlockerState): void {
    state.board.slots[blocker.slotId].contains = null;
}

function placeBlockerInSlot(state: FinityGameState, blocker: BlockerState): void {
    state.board.slots[blocker.slotId].contains = { ...blocker };
}

function moveBasePost(state: FinityGameState, move: BasePostMove): void {
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

function reevaluateRingSupport(state: FinityGameState): void {
    // Check all players for orphaned rings
    for (const color of state.config.playerColors) {
        clearOrphans(state, color);
    }
}

function clearOrphans(state: FinityGameState, color: PlayerColor): void {
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

function advanceTurn(state: FinityGameState): void {
    checkVictory(state);

    if (state.playStatus === 'over') {
        state.turnIndex = -1;
        return;
    }

    const playerCount = state.config.playerColors.length;
    state.turnIndex = (state.turnIndex + 1) % playerCount;

    // Skip winners in multiplayer games
    while (state.winners.includes(state.config.playerColors[state.turnIndex])) {
        state.turnIndex = (state.turnIndex + 1) % playerCount;
    }
}

function checkVictory(state: FinityGameState): void {
    for (const color of state.config.playerColors) {
        // skip if current color is in the winner's list
        if (state.winners.includes(color)) continue;

        //  victory requires both the ring threshold and a complete supported path
        // (9 stations ending at center)
        if (ringCount(state, color) >= 7 && hasFullPath(state, color)) {
            state.winners.push(color);
        }
    }

    // Game is over when all but one player has won
    if (state.winners.length >= state.config.playerColors.length - 1) {
        state.playStatus = 'over';
    }
}
