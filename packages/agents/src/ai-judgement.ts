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
    PATTERN_LENGTH,
    SLOT_INTERFERENCES,
    STATION_SLOTS,
    legalPaths,
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
     * entirely - block where it is significantly detrimental to them.
     */
    channelClosed: 2.0,
    /**
     * A base post move that frees a boxed-in player: before it, at most one
     * channel out of their reachable stations had an open slot; after it,
     * more do -  consider base post moves particularly when blocked.
     */
    escape: 4.0,
    /**
     * An arrow that doubles a link your path depends on: a step of your
     * longest legal path currently carried by a single arrow - Double up
     * as early as possible, especially where a sequence depends on one arrow.
     */
    doubleUp: 2.5,
    /**
     * An arrow placed on a centre spoke that does neither of the two jobs a
     * centre move should do: it is not a possible final step of your
     * path (pointing into the centre, in the pattern's last colour), and it
     * takes nothing from the opponent.
     */
    idleCentre: -2.0,
} as const;

/** One agent's bonus weights: MOVE_BONUS with any per-agent overrides applied */
export type MoveBonus = { -readonly [K in keyof typeof MOVE_BONUS]: number };

/** "Boxed in": this many open channels or fewer out of your territory. */
export const BOXED_IN = 1;

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
    /** Open channels out of my reachable stations before any root move. */
    readonly myOpenChannels: number;
    /**
     * Steps of my longest legal path carried by exactly one arrow, as
     * `${from}>${to}:${colour}` keys — the links one opponent move could cut.
     */
    readonly mySingleLinks: ReadonlySet<string>;
    /** This agent's bonus weights (MOVE_BONUS unless overridden, e.g. for A/B runs). */
    readonly bonus: MoveBonus;
}

/** Computed once per turn, before the search. */
export function buildRootContext(
    state: FinityGameState,
    me: PlayerColor,
    bonus: Partial<MoveBonus> = {},
): RootContext {
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
        myOpenChannels: openChannels(state, me),
        mySingleLinks: singleArrowLinks(state, me),
        bonus: { ...MOVE_BONUS, ...bonus },
    };
}

const linkKey = (from: StationName, to: StationName, color: string): string => `${from}>${to}:${color}`;

/**
 * Steps of `color`'s longest legal path that rest on a single arrow. Step i
 * of a path from the base post uses an arrow of colour pathPattern[i]; a step
 * is fragile when only one arrow of that colour runs that way in the pair.
 */
export function singleArrowLinks(state: FinityGameState, color: PlayerColor): Set<string> {
    const out = new Set<string>();
    const paths = legalPaths(state, color);
    if (paths.length === 0) return out;
    const longest = paths.reduce((a, b) => (b.length > a.length ? b : a));

    for (let i = 0; i + 1 < longest.length; i++) {
        const from = longest[i];
        const to = longest[i + 1];
        const colour = state.pathPattern[i];
        const ch = STATION_SLOTS[from]?.[to];
        if (!ch) continue;
        let n = 0;
        for (const id of [ch.L, ch.C, ch.R]) {
            const p = state.board.slots[id]?.contains;
            if (p && p.type === 'arrow' && p.fromStation === from && p.toStation === to && p.color === colour) n++;
        }
        if (n === 1) out.add(linkKey(from, to, colour));
    }

    return out;
}

/** double up early, above all where a sequence depends on one arrow. */
export function doubleUpValue(ctx: RootContext, move: MoveAction): number {
    const add = move.pieceToAdd;
    if (move.type !== 'place' || !add || add.type !== 'arrow') return 0;

    return ctx.mySingleLinks.has(linkKey(add.fromStation, add.toStation, add.color)) ? ctx.bonus.doubleUp : 0;
}

/**
 * a move to the centre should either help complete your own path or
 * block the opponent. An arrow on a centre spoke is a possible final step only
 * if it points into the centre in the pattern's last colour; otherwise it has
 * to earn its place by blocking (`impact` > 0).
 */
export function centerValue(ctx: RootContext, before: FinityGameState, move: MoveAction, impact: number): number {
    const add = move.pieceToAdd;
    if (move.type !== 'place' || !add || add.type !== 'arrow') return 0;
    if (add.fromStation !== 'C' && add.toStation !== 'C') return 0;

    const finalStep = add.toStation === 'C' && add.color === before.pathPattern[PATTERN_LENGTH - 1];
    return finalStep || impact > 0 ? 0 : ctx.bonus.idleCentre;
}

/**
 * Channels (station pairs) leading out of `color`'s reachable stations that still have
 * at least one open slot - the directions they can still build in
 */
export function openChannels(state: FinityGameState, color: PlayerColor): number {
    const seen = new Set<number>();
    let open = 0;
    for (const from of reachableStations(state, color)) {
        const neighbors = STATION_SLOTS[from];
        if (!neighbors) continue;
        for (const to of Object.keys(neighbors) as StationName[]) {
            const ch = neighbors[to];
            if (!ch || !state.board.stations[to]) continue;
            const base = Math.min(ch.L, ch.C, ch.R);
            if (seen.has(base)) continue;
            seen.add(base);
            if ([base, base + 1, base + 2].some((id) => isOpen(state, id))) open++;
        }
    }

    return open;
}

/**
 * base post moves are especially worth considering when you are
 * blocked. Rewards a relocation that takes a boxed-in player (at most
 * BOXED_IN open channels) to more room than they had.
 */
export function escapeValue(ctx: RootContext, after: FinityGameState): number {
    if (ctx.myOpenChannels > BOXED_IN) return 0;

    return openChannels(after, ctx.me) > ctx.myOpenChannels ? MOVE_BONUS.escape : 0;
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
        case 'arrow': {
            const impact = blockImpact(ctx, before, move);
            return impact + doubleUpValue(ctx, move) + centerValue(ctx, before, move, impact);
        }
        case 'blocker':
            return blockImpact(ctx, before, move);
        case 'basePost':
            return escapeValue(ctx, after);
        default:
            return 0;
    }
}
