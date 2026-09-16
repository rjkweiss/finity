/**
 * Finity Game Engine — Anti-kingmaker restrictions (3 & 4 player games only)
 *
 *
 * Rulebook - "For 3&4 player games only":
 *
 *   "In a 3 or 4 person game, any player whose longest partial path falls more
 *    than 2 points behind the length of 2 or more other players' partial paths
 *    is subject to anti-kingmaker restrictions. This player's arrow placement,
 *    arrow reversal, and blocker placement moves are restricted to slots
 *    immediately adjacent to stations with the player's own markers (rings or
 *    base post)."
 *
 * What the rule does NOT restrict: ring placement, base-post
 * relocation, arrow removal, and blocker removal are all untouched. A
 * restricted player can still make progress; they just cannot reach across the
 * board to meddle.
 *
 */

import type { FinityGameState, MoveAction, PlayerColor, StationName } from './types';
import { SLOT_TO_STATIONS } from './topology';
import { longestPathCrossings } from './path-analyzer';

/** Gap, in crossings, beyond which a player counts as "behind" */
export const KINGMAKER_GAP = 2;

/** How many opponents must be ahead by more than KINGMAKER_GAP. */
export const KINGMAKER_MIN_LEADERS = 2;

/**
 * Is `color` currently subject to anti-kingmaker restrictions?
 * Always false in 2-player games — the rule is explicitly 3-4 player only.
 */
export const isKingmakerRestricted = (
    state: FinityGameState,
    color: PlayerColor,
): boolean => {
    const players = state.config.playerColors;
    if (players.length < 3) return false;

    const mine = longestPathCrossings(state, color); // length measured in crossings, not stations

    let leaders = 0;
    for (const other of players) {
        if (other === color) continue;
        // To check: A player who has already won is still a player for this comparison;
        // if that turns out to be wrong, need to filter on state.winners here.
        if (longestPathCrossings(state, other) - mine > KINGMAKER_GAP) leaders++;
        if (leaders >= KINGMAKER_MIN_LEADERS) return true;
    }
    return false;
}

/**
 * The set of slot ids a restricted player may place an arrow in, reverse an
 * arrow in, or move a blocker into.
 *
 * A slot qualifies when either of the two stations it connects carries one of
 * the player's rings or their base post.
 */
export const kingmakerAllowedSlots = (
    state: FinityGameState,
    color: PlayerColor,
): Set<number> => {
    const marked = new Set<StationName>();
    for (const [name, station] of Object.entries(state.board.stations)) {
        if (station.basePost === color) {
            marked.add(name as StationName);
            continue;
        }
        if (station.rings.some((r) => r !== null && r.color === color)) {
            marked.add(name as StationName);
        }
    }

    const allowed = new Set<number>();
    for (let slotId = 0; slotId < SLOT_TO_STATIONS.length; slotId++) {
        const pair = SLOT_TO_STATIONS[slotId];
        if (!pair) continue;
        if (marked.has(pair[0]) || marked.has(pair[1])) allowed.add(slotId);
    }
    return allowed;
}

/**
 * Which move categories the restriction applies to. Deliberately narrow:
 * ring placement, base-post relocation, arrow removal, and blocker removal
 * are NOT restricted by the printed rule.
 */
const isRestrictableMove = (move: MoveAction): boolean => {
    const add = move.pieceToAdd;
    if (!add) return false;
    return add.type === 'arrow' || add.type === 'blocker';
}

/** The slot a restrictable move targets. */
const targetSlot = (move: MoveAction): number | null => {
    const add = move.pieceToAdd;
    if (add && (add.type === 'arrow' || add.type === 'blocker')) return add.slotId;
    return null;
}

/**
 * Filter a generated move list down to what a restricted player may legally
 * play. Returns the input unchanged when the player is not restricted
 *
 */
export const applyKingmakerRestrictions = (
    state: FinityGameState,
    color: PlayerColor,
    moves: MoveAction[],
): MoveAction[] => {
    if (!isKingmakerRestricted(state, color)) return moves;

    const allowed = kingmakerAllowedSlots(state, color);
    return moves.filter((move) => {
        if (!isRestrictableMove(move)) return true;
        const slot = targetSlot(move);
        return slot === null || allowed.has(slot);
    });
}
