// Shared primitives for the built-in AI agents (random, minimax, MCTS).
// Deliberately self-contained: the agents package must not import from the
// client, so the move-categorization logic here mirrors the client's
// moveInputHandler categories rather than importing them.

import type { FinityGameState, MoveAction, PlayerColor } from "@finity/engine";
import { MoveAbortedError, type AbortReason, type MoveContext } from "./interface";

// -------------------------------------------------------------------------
// Move Categorization
// -------------------------------------------------------------------------

export type MoveCategory =
    | 'ring'
    | 'basePost'
    | 'reverse'  // an arrow 'replaced' onto its own slot flips direction
    | 'arrow'    // a fresh arrow placement
    | 'blocker'
    | 'remove';

/**
 * Coarse category for a move, keyed on the piece discriminant
 * matching the reconciliation done in the client's moveInputHandler
 */
export function moveCategory(move: MoveAction): MoveCategory {
    if (move.type === 'remove') return 'remove';

    const add = move.pieceToAdd;
    if (!add) return 'remove';
    switch(add.type) {
        case 'ring':
            return 'ring';
        case 'basePost':
            return 'basePost';
        case 'arrow':
            // reversal is modeled as a 'replace' of an arrow by an arrow on the same slot;
            // a fresh placement is a 'place'
            return move.type === 'replace' ? 'reverse': 'arrow';
        case 'blocker':
            return 'blocker';
        default:
            return 'remove';
    }
}

// -------------------------------------------------------------------------
// Category weights (tunable). Favor progress-making pieces (rings, base posts)
// over positional fiddling (arrows, blockers), per the design's "weighted
// random favoring rings and base posts".
// -------------------------------------------------------------------------
export type CategoryWeights = Record<MoveCategory, number>;

export const DEFAULT_CATEGORY_WEIGHTS: CategoryWeights = {
    ring: 8,
    basePost: 3,
    reverse: 2,
    arrow: 1,
    blocker: 1,
    remove: 1
}

// -------------------------------------------------------------------------
// RNG — injectable so agents/tests can be made deterministic.
// -------------------------------------------------------------------------
export type Rng = () => number;  // returns [0, 1)

export const defaultRng: Rng = Math.random;

/**
 * Mulberry32 - small, seedable PRNG for reproducible agents / tests
 */
export function seededRng(seed: number): Rng {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^(a >>> 15), 1 | a);
        t = (t + Math.imul(t^(t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}

/**
 * Pick one item by weight. Assumes at least one item and non-negative weights
 */
export function weightedPick<T>(items: T[], weightOf: (item: T) => number, rng: Rng): T {
    let total = 0;
    for (const it of items) total += Math.max(0, weightOf(it));
    if (total <= 0) return items[Math.floor(rng() * items.length)];
    let r = rng() * total;
    for (const it of items) {
        r -= Math.max(0, weightOf(it));
        if (r <= 0) return it;
    }

    return items[items.length - 1];
}

// -------------------------------------------------------------------------
// Abort / deadline plumbing
// -------------------------------------------------------------------------
/**
 * Sentinel thrown internally when a search runs out of time
 */
export class SearchDeadlineReached extends Error {
    constructor() {
        super('search deadline reached');
        this.name = 'SearchDeadlineReached';
    }
}

/**
 * Throw MoveAbortedError if the orchestrator has cancelled this move
 */
export function throwIfAborted(ctx: MoveContext): void {
    if (ctx.signal.aborted) {
        throw new MoveAbortedError(ctx.signal.reason as AbortReason | undefined);
    }
}

// -------------------------------------------------------------------------
// Position key for transposition tables. The engine's zobristHash is currently
// a stub ('0'), so agents compute their own compact key from board contents +
// side to move. Not cryptographic — just stable and collision-cheap.
// -------------------------------------------------------------------------
export function positionKey(state: FinityGameState): string {
    const board = state.board;
    let s = `t${state.turnIndex};`;

    // stations: ring occupancy by color initial per size slot, plus base post
    for (const name of Object.keys(board.stations).sort()) {
        const st = board.stations[name as keyof typeof board.stations];
        const r = st.rings
            .map((ring) => (ring ? ring.color[0] : '.'))
            .join('');
        s += `${name}: ${r}${st.basePost ? st.basePost[0]: '.'}`;
    }

    // slots: type + color + orientation for arrows
    for (const slot of board.slots) {
        const c = slot.contains;
        if (!c) {
            s += '_';
        } else if (c.type === 'arrow') {
            s += `a${c.color}${c.fromStation}>${c.toStation}`;
        } else {
            s += `k${c.color[0]}`;
        }
    }

    return s;
}

// -------------------------------------------------------------------------
// Leaf scoring shared by minimax and MCTS rollouts.
// -------------------------------------------------------------------------
export const WIN_SCORE = 1_000_000;

/**
 * Zero-sum differential score from `me`'s perspective:
 *  my evaluation minus the strongest opponent's evaluation.
 * Terminal states return large (plus minus) values so the search prefers real wins over
 * heuristic gains, and prefers faster wins via the small depth nudge
 */
export function differentialScore(
    state: FinityGameState,
    me: PlayerColor,
    evaluate: (s: FinityGameState, c: PlayerColor) => number,
    depthLeft = 0
): number {
    if (state.playStatus === 'over') {
        if (state.winners.includes(me)) return WIN_SCORE + depthLeft;
        if (state.winners.length > 0) return -WIN_SCORE - depthLeft;
        return 0; // draw / deadlock
    }

    const mine = evaluate(state, me);
    let best_opponent = -Infinity;
    for (const c of state.config.playerColors) {
        if (c === me) continue;
        const v = evaluate(state, c)
        if (v > best_opponent) best_opponent = v;
    }

    if (best_opponent === -Infinity) best_opponent = 0;
    return mine - best_opponent;
}
