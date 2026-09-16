/**
 * Finity Game Engine — Legal Move Generation
 *
 * Faithful port of `GameState.possible_moves(color)` from the original
 * game_state.js. Produces the complete set of legal MoveActions for `color`,
 * each shaped so `applyMove` consumes it without further validation.
 *
 * Seven generators, concatenated in the original's order:
 *   ring placement, base-post move, blocker relocate, blocker remove,
 *   arrow place, arrow reverse, arrow remove.
 *
 * Every candidate is gated through the same validators `applyMove` relies on
 * (canBlockSlot, violatesReplacementRule, isRedundant, occupiesHighPoint) plus
 * reachableStations from the path analyzer, so a generated move can never be
 * rejected at apply time.
 *
 */

import type {
    FinityGameState,
    PlayerColor,
    StationName,
    MoveAction,
    ArrowColor,
} from './types';

import {
    currentPlayer,
    stationRingCount,
    topmostOpening,
    occupiesHighPoint,
    getAllArrows,
    getAllBlockers,
    canBlockSlot,
    isRedundant,
    applyMove
} from './engine';

import { applyKingmakerRestrictions } from './kingmaker';
import { filterImmediateUndo, violatesReplacementRule } from './no-undo';

import { reachableStations } from './path-analyzer';
import { STATION_SLOTS, SLOT_TO_STATIONS } from './topology';

const ARROW_COLORS: ArrowColor[] = ['b', 'w'];

/** Opponent blockers become removable once there are 20 bridges or more on the board. */
const BLOCKER_REMOVE_MIN_ARROWS = 20;

/** Each player has eight rings of each size (24 in total) */
const RING_SUPPLY_PER_SIZE = 8;

/** thirty-two bridges of each color, shared by all players */
const ARROW_SUPPLY_PER_COLOR = 32;

/** Rings of each size belonging to `color` currently on the board. Counted in
 *  one pass and hoisted out of the generator loops: these are the hottest
 *  functions in search, so per-candidate recounting is not affordable.
 */
const ringsOnBoard = (
    state: FinityGameState,
    color: PlayerColor
): Record<'s' | 'm' | 'l', number> => {
    const counts = { s: 0, m: 0, l: 0 };
    for (const station of Object.values(state.board.stations)) {
        for (const ring of station.rings) {
            if (ring && ring.color === color) counts[ring.size]++;
        }
    }
    return counts;
}

/** Bridges of each colour currently on the board. Bridges are a shared pool,
 *  not owned by a player, so this is not parameterised by PlayerColor.
 *  Counts slots directly rather than via getAllArrows, which allocates.
 */
const arrowsOnBoard = (state: FinityGameState): Record<ArrowColor, number> => {
    const counts = { b: 0, w: 0 };
    for (const slot of state.board.slots) {
        const piece = slot.contains;
        if (piece && piece.type === 'arrow') counts[piece.color]++;
    }
    return counts;
}

// =============================================================
// Public API
// =============================================================

/**
 * All legal moves for `color`. Defaults to the player whose turn it is.
 * Mirrors GameState.possible_moves(color): a flat concat of the seven
 * per-type generators below.
 */
export const possibleMoves = (
    state: FinityGameState,
    color: PlayerColor = currentPlayer(state),
): MoveAction[] => {
    const generated = [
        ...possibleRingMoves(state, color),
        ...possibleBasePostMoves(state, color),
        ...possibleBlockerMoves(state, color),
        ...possibleBlockerRemoveMoves(state, color),
        ...possibleArrowPlaceMoves(state, color),
        ...possibleArrowReverseMoves(state),
        ...possibleArrowRemoveMoves(state, color),
    ];

    return applyKingmakerRestrictions(
        state,
        color,
        generated
    );
}

/**
 * PossibleMoves PLUS the state-based no-immediate-undo rule.
 * Orchestrator and UI call legalMoves so the rule is enforced exactly where a move actually gets played
 */
export const legalMoves = (
    state: FinityGameState,
    color: PlayerColor = currentPlayer(state),
): MoveAction[] => {
    return filterImmediateUndo(state, possibleMoves(state, color), applyMove);
};

// =============================================================
// 1. Ring placement
// =============================================================

/**
 * A ring may be placed on any reachable station that has fewer than 3 rings
 * and is not the player's own base-post station. Ring size is the station's
 * topmost opening (s → m → l). No per-player supply cap (matches original).
 *
 */
const possibleRingMoves = (
    state: FinityGameState,
    color: PlayerColor
): MoveAction[] => {
    const moves: MoveAction[] = [];
    const reachable = reachableStations(state, color);
    const supply = ringsOnBoard(state, color);

    for (const name of reachable) {
        if (name === 'C') continue;
        const station = state.board.stations[name as StationName];
        if (!station) continue;
        if (stationRingCount(station) >= 3) continue;
        if (station.basePost === color) continue;

        const size = topmostOpening(station);
        if (!size) continue;

        // supply cap: a ring can only be placed if one of that size is left in hand
        if (supply[size] >= RING_SUPPLY_PER_SIZE) continue;

        moves.push({
            type: 'place',
            pieceToAdd: { type: 'ring', color, size },
            station: name as StationName,
        });
    }

    return moves;
}

// =============================================================
// 2. Base-post move
// =============================================================

/**
 * A base post may move to any empty (non-center) station such that, treating
 * that station as the new path start, at least one reachable station still
 * holds one of the player's rings (new_path_has_rings).
 */
const possibleBasePostMoves = (
    state: FinityGameState,
    color: PlayerColor
): MoveAction[] => {
    const moves: MoveAction[] = [];

    for (const name of Object.keys(state.board.stations) as StationName[]) {
        if (!canMoveBasePost(state, name, color)) continue;
        moves.push({
            type: 'replace',
            pieceToAdd: { type: 'basePost', color, toStation: name },
        });
    }

    return moves;
}

const canMoveBasePost = (
    state: FinityGameState,
    name: StationName,
    color: PlayerColor
): boolean => {
    const station = state.board.stations[name];
    if (!station) return false;
    if (station.basePost) return false;   // destination must have no base post
    if (name === 'C') return false;        // never the center

    return newPathHasRings(state, name, color);
}

const newPathHasRings = (
    state: FinityGameState,
    fromStation: StationName,
    color: PlayerColor
): boolean => {
    const reachable = reachableStations(state, color, fromStation);
    for (const name of reachable) {
        const st = state.board.stations[name as StationName];
        if (st && st.rings.some(r => r !== null && r.color === color)) return true;
    }

    return false;
}

// =============================================================
// 3. Blocker relocate
// =============================================================

/**
 * Each of the player's blockers may move to any empty slot (both endpoint
 * stations active) that passes the first-move restriction.
 *
 * CHECK W/ TONY: original checks only `contains === null` here — NOT the `blocked` interference flag —
 * so blockers may sit in interfered slots. Is this desired behavior?
 */
const possibleBlockerMoves = (
    state: FinityGameState,
    color: PlayerColor
): MoveAction[] => {
    const moves: MoveAction[] = [];
    const ownBlockers = getAllBlockers(state).filter(b => b.color === color);
    if (ownBlockers.length === 0) return moves;

    for (const slot of state.board.slots) {
        if (slot.contains !== null) continue;                 // (no blocked check — intentional)
        if (!stationsActive(state, slot.id)) continue;
        if (!canBlockSlot(state, slot.id, color, 'blocker')) continue;

        for (const old of ownBlockers) {
            moves.push({
                type: 'replace',
                pieceToRemove: old,
                pieceToAdd: { type: 'blocker', color, slotId: slot.id },
            });
        }
    }

    return moves;
}

// =============================================================
// 4. Blocker remove (opponents only, late game)
// =============================================================

/**
 * Opponent blockers may be removed only once the board holds more than
 * BLOCKER_REMOVE_MIN_ARROWS arrows.
 */
const possibleBlockerRemoveMoves = (
    state: FinityGameState,
    color: PlayerColor
): MoveAction[] => {
    const moves: MoveAction[] = [];
    if (getAllArrows(state).length < BLOCKER_REMOVE_MIN_ARROWS) return moves;

    for (const blocker of getAllBlockers(state)) {
        if (blocker.color !== color) {
            moves.push({ type: 'remove', pieceToRemove: blocker });
        }
    }

    return moves;
}

// =============================================================
// 5. Arrow place
// =============================================================

/**
 * For every empty, unblocked slot (both endpoints active) passing the
 * first-move restriction, both arrow colors and the directed (from → to)
 * orientation implied by the slot's owning station, kept if non-redundant
 * and not an immediate undo.
 */
const possibleArrowPlaceMoves = (
    state: FinityGameState,
    color: PlayerColor
): MoveAction[] => {
    const moves: MoveAction[] = [];

    // Hoisted: arrowsOnBoard scans all 72 slots and supply cannot change within a single generation pass
    const onBoard = arrowsOnBoard(state);
    const exhausted: Record<ArrowColor, boolean> = {
        b: onBoard.b >= ARROW_SUPPLY_PER_COLOR,
        w: onBoard.w >= ARROW_SUPPLY_PER_COLOR,
    };

    if (exhausted.b && exhausted.w) return moves;

    for (const fromName of Object.keys(state.board.stations) as StationName[]) {
        const fromSlots = STATION_SLOTS[fromName];
        if (!fromSlots) continue;

        for (const toName of Object.keys(fromSlots) as StationName[]) {
            if (!(toName in state.board.stations)) continue;
            const channels = fromSlots[toName] as Record<string, number>;

            for (const channel of Object.keys(channels)) {
                const slotId = channels[channel];
                const slot = state.board.slots[slotId];
                if (slot.contains !== null || slot.blocked) continue;
                if (!canBlockSlot(state, slotId, color, 'arrow')) continue;

                for (const arrowColor of ARROW_COLORS) {
                    if (exhausted[arrowColor]) continue;
                    if (isRedundant(state, slotId, toName, arrowColor)) continue;
                    if (violatesReplacementRule(state, slotId, arrowColor)) continue;

                    moves.push({
                        type: 'place',
                        pieceToAdd: {
                            type: 'arrow',
                            color: arrowColor,
                            fromStation: fromName,
                            toStation: toName,
                            slotId,
                        },
                    });
                }
            }
        }
    }

    return moves;
}

// =============================================================
// 6. Arrow reverse
// =============================================================

/**
 * Any arrow may be reversed (swap from/to, same color, same slot) if the
 * reversed direction is non-redundant and it isn't an immediate undo.
 * Redundancy is checked against the post-reversal destination, i.e. the
 * arrow's current fromStation.
 */
const possibleArrowReverseMoves = (state: FinityGameState): MoveAction[] => {
    const moves: MoveAction[] = [];

    for (const arrow of getAllArrows(state)) {
        if (isRedundant(state, arrow.slotId, arrow.fromStation, arrow.color)) continue;

        moves.push({
            type: 'replace',
            pieceToRemove: arrow,
            pieceToAdd: {
                type: 'arrow',
                color: arrow.color,
                fromStation: arrow.toStation,
                toStation: arrow.fromStation,
                slotId: arrow.slotId,
            },
        });
    }

    return moves;
}

// =============================================================
// 7. Arrow remove
// =============================================================

/**
 * The player may remove arrows that point INTO a station whose high point they
 * occupy.  Bridges pointing into the center are excluded.
 */
const possibleArrowRemoveMoves = (
    state: FinityGameState,
    color: PlayerColor
): MoveAction[] => {
    const moves: MoveAction[] = [];

    for (const stationName of Object.keys(state.board.stations) as StationName[]) {
        if (!occupiesHighPoint(state, color, stationName)) continue;

        const slots = STATION_SLOTS[stationName];
        if (!slots) continue;

        for (const toName of Object.keys(slots) as StationName[]) {
            const channels = slots[toName] as Record<string, number>;
            for (const channel of Object.keys(channels)) {
                const slotId = channels[channel];
                const piece = state.board.slots[slotId].contains;
                if (
                    piece && piece.type === 'arrow' && piece.toStation === stationName
                ) {
                    // A bridge leading to the center station cannot be removed in one move
                    // it can be reversed and then removed later
                    if (piece.toStation === 'C') continue;
                    moves.push({ type: 'remove', pieceToRemove: piece });
                }
            }
        }
    }

    return moves;
}

// =============================================================
// Internal
// =============================================================

/** Both stations a slot connects are active on the current board. */
const stationsActive = (state: FinityGameState, slotId: number): boolean => {
    const pair = SLOT_TO_STATIONS[slotId];
    if (!pair) return false;
    return pair[0] in state.board.stations && pair[1] in state.board.stations;
}
