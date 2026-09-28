/**
 * Move-level judgement for the minimax root.
 *
 * This is about what a MOVE accomplishes, which a position
 * score cannot see: a reversal that orphans three rings and one that orphans
 * none can lead to positions the evaluation rates about the same. These
 * bonuses are added to each root move's search score, so they decide between
 * moves the search considers close without overriding a real difference.
 *
 *
 * Weights are in evaluation units and provisional — to be tuned with self-play ML weights
 */

import {
    SLOT_INTERFERENCES,
    STATION_SLOTS,
    longestLegalPathLength,
    reachableStations,
    ringCount,
    type FinityGameState,
    type MoveAction,
    type PlayerColor,
    type StationName,
} from "@finity/engine";
import { moveCategory } from "./ai-common";

export const MOVE_BONUS = {
    /**
     * Per opponent ring a reversal orphans: reversing is good when it
     * removes rings, and the number of rings should set the priority.
     */
    orphanPerRing: 3.0,
    /**
     * A reversal that extends your own legal path: a valid reason too,
     * but worth less than orphaning.
     */
    ownRoute: 1.5,
    /** A reversal that does neither: calls it a wasted move. */
    wastedReversal: -2.0,
    /** Per open slot on the opponent's frontier a block takes away. */
    blockPerSlot: 0.5,
    /**
     * Extra when a block closes a channel out of the opponent's territory
     * entirely. Tony: block where it is significantly detrimental to them.
     */
    channelClosed: 2.0,
} as const;

export interface RootContext {
    readonly me: PlayerColor;
    readonly opponents: readonly PlayerColor[];
    /** Opponents' total rings before any root move. */
    readonly oppRings: number;
    /** My longest legal path before any root move. */
    readonly myPath: number;
    /**
     * Triplets (by base slot id) connecting an opponent's reachable stations
     * to a neighbour: the channels an opponent can still build through.
     */
    readonly oppTriplets: ReadonlySet<number>;
}

/** Computed once per turn, before the search. */
export function buildRootContext(state: FinityGameState, me: PlayerColor): RootContext {
    const opponents = state.config.playerColors.filter(
        (c) => c !== me && !state.winners.includes(c)
    );
    const oppTriplets = new Set<number>();
    for (const opp of opponents) {
        for (const from of reachableStations(state, opp)) {
            const neighbours = STATION_SLOTS[from];
            if (!neighbours) continue;
            for (const to of Object.keys(neighbours) as StationName[]) {
                const ch = neighbours[to];
                if (!ch || !state.board.stations[to]) continue;
                oppTriplets.add(Math.min(ch.L, ch.C, ch.R));
            }
        }
    }

    return {
        me,
        opponents,
        oppRings: opponents.reduce((n, c) => n + ringCount(state, c), 0),
        myPath: longestLegalPathLength(state, me),
        oppTriplets,
    };
}

const isOpen = (state: FinityGameState, slotId: number): boolean => {
    const slot = state.board.slots[slotId];
    return !!slot && !slot.contains && !slot.blocked;
};

/**
 * How much a placement takes away from the opponent (Tony's "most blockable":
 * the spot where a block hurts them most). A blocker occupies one slot; an
 * arrow also shuts the slots it interferes with. Each open slot lost on an
 * opponent's frontier channel counts, and closing a channel entirely — its
 * last open slot — counts extra, because that direction is then gone.
 */
export function blockImpact(ctx: RootContext, state: FinityGameState, move: MoveAction): number {
    const add = move.pieceToAdd;
    if (!add || (add.type !== 'arrow' && add.type !== 'blocker')) return 0;
    if (add.type === 'arrow' && move.type !== 'place') return 0; // reversals take nothing new

    const taken = new Set<number>([add.slotId]);
    if (add.type === 'arrow') {
        for (const x of SLOT_INTERFERENCES[add.slotId] ?? []) taken.add(x);
    }

    // Group the slots actually lost (open now, on an opponent channel) by triplet.
    const lostByTriplet = new Map<number, number>();
    for (const slotId of taken) {
        const base = slotId - (slotId % 3);
        if (!ctx.oppTriplets.has(base) || !isOpen(state, slotId)) continue;
        lostByTriplet.set(base, (lostByTriplet.get(base) ?? 0) + 1);
    }

    let impact = 0;
    for (const [base, lost] of lostByTriplet) {
        impact += lost * MOVE_BONUS.blockPerSlot;
        let open = 0;
        for (let i = 0; i < 3; i++) if (isOpen(state, base + i)) open++;
        if (open - lost <= 0) impact += MOVE_BONUS.channelClosed;
    }

    return impact;
}

/**
 * reversal rule, graded:
 * orphans opponent rings   -> orphanPerRing x rings  (the strongest reason)
 * extends your own route   -> ownRoute               (valid, worth less)
 * neither                  -> wastedReversal          (penalised)
 * A reversal can earn both of the first two.
 */
export function reversalValue(ctx: RootContext, after: FinityGameState): number {
    const orphaned = Math.max(
        0,
        ctx.oppRings - ctx.opponents.reduce((n, c) => n + ringCount(after, c), 0)
    );
    const routeGain = longestLegalPathLength(after, ctx.me) - ctx.myPath;

    if (orphaned === 0 && routeGain <= 0) return MOVE_BONUS.wastedReversal;

    return orphaned * MOVE_BONUS.orphanPerRing + (routeGain > 0 ? MOVE_BONUS.ownRoute : 0);
}

/** Total bonus for playing `move` from `before`, reaching `after`. */
export function rootMoveBonus(
    ctx: RootContext,
    before: FinityGameState,
    after: FinityGameState,
    move: MoveAction
): number {
    switch (moveCategory(move)) {
        case 'reverse':
            return reversalValue(ctx, after);
        case 'arrow':
        case 'blocker':
            return blockImpact(ctx, before, move);
        default:
            return 0;
    }
}
