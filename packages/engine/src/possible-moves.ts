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
 * (canBlockSlot, canMakeArrowMoveInSlot, isRedundant, occupiesHighPoint) plus
 * reachableStations from the path analyzer, so a generated move can never be
 * rejected at apply time.
 *
 * NOTE FOR REVIEW — the original AI generator (GameState.possible_moves) and
 * the human UI (game_manager.generate_move_preview) DISAGREE on two points.
 * The UI is the authoritative definition of what a player may actually do, so
 * this port follows the UI (the genuinely-playable set), which differs from
 * possible_moves on:
 *   (A) Ring placement excludes center 'C'. possible_moves omitted this guard
 *       (relying on C filling up), but the UI's 'ring' branch forbids '0,0'.
 *       Without the guard the AI proposes illegal center rings once C is on a
 *       reachable path. For strict possible_moves parity, delete the marked
 *       `name === 'C'` guard below.
 *   (B) Arrow removal applies the no-undo guard. possible_moves omitted it; the
 *       UI's 'rem-arrow' branch includes can_make_arrow_move_in_slot(...,'remove').
 *       For strict possible_moves parity, delete the marked guard below.
 *
 * Worth raising with Tony: the original's AI and human move sets weren't
 * identical on these two points.
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
    canMakeArrowMoveInSlot,
} from './engine';

import { reachableStations } from './path-analyzer';
import { STATION_SLOTS, SLOT_TO_STATIONS } from './topology';

const ARROW_COLORS: ArrowColor[] = ['b', 'w'];

/** Opponent blockers become removable only past this many arrows on the board. */
const BLOCKER_REMOVE_MIN_ARROWS = 20;

// =============================================================
// Public API
// =============================================================

/**
 * All legal moves for `color`. Defaults to the player whose turn it is.
 * Mirrors GameState.possible_moves(color): a flat concat of the seven
 * per-type generators below.
 */
export function possibleMoves(
    state: FinityGameState,
    color: PlayerColor = currentPlayer(state),
): MoveAction[] {
    return [
        ...possibleRingMoves(state, color),
        ...possibleBasePostMoves(state, color),
        ...possibleBlockerMoves(state, color),
        ...possibleBlockerRemoveMoves(state, color),
        ...possibleArrowPlaceMoves(state, color),
        ...possibleArrowReverseMoves(state),
        ...possibleArrowRemoveMoves(state, color),
    ];
}

// =============================================================
// 1. Ring placement
// =============================================================

/**
 * A ring may be placed on any reachable station that has fewer than 3 rings
 * and is not the player's own base-post station. Ring size is the station's
 * topmost opening (s → m → l). No per-player supply cap (matches original).
 *
 * QUIRK (A): aligned with the UI — center 'C' is excluded. For strict
 * possible_moves parity, remove the marked `name === 'C'` guard below.
 */
function possibleRingMoves(state: FinityGameState, color: PlayerColor): MoveAction[] {
    const moves: MoveAction[] = [];
    const reachable = reachableStations(state, color);

    for (const name of reachable) {
        if (name === 'C') continue;                      // (A) UI-aligned center guard
        const station = state.board.stations[name as StationName];
        if (!station) continue;
        if (stationRingCount(station) >= 3) continue;   // station full
        if (station.basePost === color) continue;        // not your own base post

        const size = topmostOpening(station);
        if (!size) continue;                              // unreachable given <3, keeps types tight

        moves.push({
            type: 'place',
            pieceToAdd: { type: 'ring', color, size },
            station: name as StationName,                 // placeRing reads move.station
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
function possibleBasePostMoves(state: FinityGameState, color: PlayerColor): MoveAction[] {
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

function canMoveBasePost(state: FinityGameState, name: StationName, color: PlayerColor): boolean {
    const station = state.board.stations[name];
    if (!station) return false;
    if (station.basePost) return false;   // destination must have no base post
    if (name === 'C') return false;        // never the center
    return newPathHasRings(state, name, color);
}

function newPathHasRings(state: FinityGameState, fromStation: StationName, color: PlayerColor): boolean {
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
 * stations active) that passes the first-move restriction. Note the original
 * checks only `contains === null` here — NOT the `blocked` interference flag —
 * so blockers may sit in interfered slots.
 */
function possibleBlockerMoves(state: FinityGameState, color: PlayerColor): MoveAction[] {
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
function possibleBlockerRemoveMoves(state: FinityGameState, color: PlayerColor): MoveAction[] {
    const moves: MoveAction[] = [];
    if (getAllArrows(state).length <= BLOCKER_REMOVE_MIN_ARROWS) return moves;

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
function possibleArrowPlaceMoves(state: FinityGameState, color: PlayerColor): MoveAction[] {
    const moves: MoveAction[] = [];

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
                    if (isRedundant(state, slotId, toName, arrowColor)) continue;
                    if (!canMakeArrowMoveInSlot(state, slotId, arrowColor, 'place')) continue;

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
function possibleArrowReverseMoves(state: FinityGameState): MoveAction[] {
    const moves: MoveAction[] = [];

    for (const arrow of getAllArrows(state)) {
        if (isRedundant(state, arrow.slotId, arrow.fromStation, arrow.color)) continue;
        if (!canMakeArrowMoveInSlot(state, arrow.slotId, arrow.color, 'replace')) continue;

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
 * occupy.
 *
 * QUIRK (B): aligned with the UI — the no-undo guard is applied. For strict
 * possible_moves parity, remove the marked canMakeArrowMoveInSlot check below.
 */
function possibleArrowRemoveMoves(state: FinityGameState, color: PlayerColor): MoveAction[] {
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
                    piece && piece.type === 'arrow' && piece.toStation === stationName &&
                    canMakeArrowMoveInSlot(state, slotId, piece.color, 'remove')  // (B) UI-aligned no-undo
                ) {
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
function stationsActive(state: FinityGameState, slotId: number): boolean {
    const pair = SLOT_TO_STATIONS[slotId];
    if (!pair) return false;
    return pair[0] in state.board.stations && pair[1] in state.board.stations;
}
