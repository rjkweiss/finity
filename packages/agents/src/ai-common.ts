// Shared primitives for the built-in AI agents (random, minimax, MCTS).
// Deliberately self-contained: the agents package must not import from the
// client, so the move-categorization logic here mirrors the client's
// moveInputHandler categories rather than importing them.

import { FinityGameState, MoveAction, PlayerColor, SLOT_INTERFERENCES, SLOT_TO_STATIONS } from "@finity/engine";
import { MoveAbortedError, type AbortReason, type MoveContext } from "./interface";

/** slot -> the slots whose arrow would interfere with (block) it */
const ATTACKERS: Record<number, number[]> = (() => {
    const out: Record<number, number[]> = {};
    for (const [t, blocked] of Object.entries(SLOT_INTERFERENCES)) {
        for (const x of blocked) (out[x] ??= []).push(Number(t));
    }

    return out;
})();


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

export function blockingExposure(state: FinityGameState, move: MoveAction): number {
    const add = move.pieceToAdd;
    if (move.type !== 'place' || !add || add.type !== 'arrow') return 0;

    const s = add.slotId;
    const base = s - (s % 3);
    const triplet = [base, base + 1, base + 2];
    const denied = new Set(SLOT_INTERFERENCES[s] ?? []);
    const slots = state.board.slots;
    const onBoard = (id: number): boolean => {
        const pair = SLOT_TO_STATIONS[id];
        return !!pair && !!state.board.stations[pair[0]] && !!state.board.stations[pair[1]];
    };

    let threats = 0;
    for (const x of triplet) {
        if (x === s) continue;
        const xs = slots[x];

        // only open doubling slots matter
        if (!xs || xs.contains || xs.blocked) continue;
        for (const t of ATTACKERS[x] ?? []) {
            if (triplet.includes(t) || denied.has(t) || !onBoard(t)) continue;
            const ts = slots[t];
            // opponent can't use it
            if (!ts || ts.contains || ts.blocked) continue;
            threats++;
        }
    }

    return threats;
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
// Leaf scoring shared by minimax and MCTS rollouts.
// -------------------------------------------------------------------------
export const WIN_SCORE = 1_000_000;
export const OPPONENT_WEIGHT = 0.6;

/**
 * Differential score from `me`'s perspective:
 *  my evaluation minus a weighted share of the strongest opponent's evaluation.
 */
export function differentialScore(
    state: FinityGameState,
    me: PlayerColor,
    evaluate: (s: FinityGameState, c: PlayerColor) => number,
    depthLeft = 0,
    opponentWeight: number = OPPONENT_WEIGHT
): number {
    if (state.playStatus === 'over') {
        if (state.winners.includes(me)) return WIN_SCORE + depthLeft;
        if (state.endReason === 'repetition') return -WIN_SCORE - depthLeft;
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
    return mine - (opponentWeight * best_opponent);
}
