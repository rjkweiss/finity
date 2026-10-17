// Move judgement for the minimax agent: which moves matter, and the opening.
//
// A plan is what a player's cheapest routes (and objective path) need. A move
// is relevant when it builds my plan's needs, or occupies, reverses or removes
// the opponent's; the search only looks at relevant moves. The opening plan
// picks each player's first two moves.

import type { FinityGameState, MoveAction, PlayerColor, RouteSummary, StationName } from '@finity/engine';
import { applyMove, basePostStation, routeSummary, SLOT_TO_STATIONS } from '@finity/engine';
import { moveCategory } from './ai-common';

// =============================================================
// Plans and move relevance
// =============================================================

// Plans and move relevance for the race agent.
//
// A plan is what a player's cheapest routes need: the (from, to, colour) steps,
// the station pairs those steps run through, the stations they visit, and any
// base relocation they start with. A move is relevant when it builds one of my
// plan's needs, or occupies, reverses or removes one of the opponent's; the
// search only looks at relevant moves, which is what lets it reach depth 3-4
// in about a second instead of depth 2 over all ~150-210 legal moves.

// =============================================================
// Plans: what each player's cheapest routes need
// =============================================================

export const tripleKey = (from: string, to: string, color: string): string => `${from}>${to}:${color}`;
export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

export interface Plan {
    readonly distance: number;
    /** step requirements of near-best routes -> how many BEST routes use them */
    readonly triples: Map<string, number>;
    readonly pairs: Set<string>;
    /** intermediate stations of near-best routes -> visits on best routes */
    readonly stations: Map<StationName, number>;
    /** relocation targets of near-best routes */
    readonly starts: Set<StationName>;
    readonly relocateTo: StationName | null;
    /** (from, to, colour) steps of the objective path alone (Tony's robust route) */
    readonly objective: Set<string>;
}

export const planOf = (state: FinityGameState, s: RouteSummary): Plan => {
    const triples = new Map<string, number>();
    const pairs = new Set<string>();
    const stations = new Map<StationName, number>();
    const starts = new Set<StationName>();
    const pattern = state.pathPattern;
    const objective = new Set<string>();
    // bridges on the board, so links that are built but single can be doubled
    const onBoard = new Set<string>();
    for (const sl of state.board.slots) {
        const p = sl.contains;
        if (p && p.type === 'arrow') onBoard.add(tripleKey(p.fromStation, p.toStation, p.color));
    }
    for (const r of s.routes) {
        const best = r.cost === s.distance ? 1 : 0;
        if (r.relocated) starts.add(r.start);
        for (let i = 0; i < 8; i++) {
            const k = tripleKey(r.stations[i], r.stations[i + 1], pattern[i]);
            triples.set(k, (triples.get(k) ?? 0) + best);
            pairs.add(pairKey(r.stations[i], r.stations[i + 1]));
            if (i > 0) stations.set(r.stations[i], (stations.get(r.stations[i]) ?? 0) + best);

            // double up. A built step whose same-colour return bridge is
            // missing can be reversed or cut; the return bridge locks it.
            const back = tripleKey(r.stations[i + 1], r.stations[i], pattern[i]);
            if (r.stations[i + 1] !== 'C' && onBoard.has(k) && !onBoard.has(back) && !triples.has(back)) triples.set(back, 0);
        }
    }

    // objective path: its steps, and the doubling bridges that protect
    // them (same colour, other direction), are part of the plan too, so the
    // search looks at the moves that build the robust version of the route.
    const obj = s.objectiveRoute;
    if (obj) {
        if (obj.relocated) starts.add(obj.start);
        for (let i = 0; i < 8; i++) {
            const a = obj.stations[i], b = obj.stations[i + 1], c = pattern[i];
            const k = tripleKey(a, b, c);
            triples.set(k, (triples.get(k) ?? 0) + 1);
            objective.add(k);
            pairs.add(pairKey(a, b));
            if (i > 0) stations.set(a, (stations.get(a) ?? 0) + 1);
            if (b !== 'C') {
                const back = tripleKey(b, a, c);
                if (!triples.has(back)) triples.set(back, 0);
            }
        }
    }

    return { distance: s.distance, triples, pairs, stations, starts, relocateTo: s.relocateTo, objective };
};

// =============================================================
// Move relevance
// =============================================================

export const arrowTriple = (p: { fromStation: string; toStation: string; color: string }): string =>
    tripleKey(p.fromStation, p.toStation, p.color);

/**
 * Strategic priority of a move given my plan and the opponent's, or null when
 * it touches neither. Higher first. Cheap: no move is applied.
 */
export const moveRelevance = (m: MoveAction, mine: Plan, theirs: Plan): number | null => {
    const add = m.pieceToAdd;
    const rem = m.pieceToRemove;
    switch (moveCategory(m)) {
        case 'ring': {
            const st = m.station!;
            let v = 0;
            if (mine.stations.has(st)) v += 5 + Math.min(3, mine.stations.get(st)!);
            if (theirs.stations.has(st)) v += 3 + Math.min(2, theirs.stations.get(st)!);
            return v > 0 ? v : null;
        }
        case 'basePost': {
            const t = (add as { toStation: StationName }).toStation;
            if (t === mine.relocateTo) return 9;
            if (mine.starts.has(t)) return 4;
            return 0.5;
        }
        case 'arrow': {
            const a = add as { fromStation: string; toStation: string; color: string };
            const k = arrowTriple(a);
            if (mine.triples.has(k)) return 4 + Math.min(3, mine.triples.get(k)!);
            const pk = pairKey(a.fromStation, a.toStation);
            if (theirs.pairs.has(pk) && !theirs.triples.has(k)) return mine.pairs.has(pk) ? 2.5 : 2;
            return null;
        }
        case 'reverse': {
            const oldK = arrowTriple(rem as never);
            const newK = arrowTriple(add as never);
            let v = 0;
            if (mine.triples.has(newK)) v += 4 + Math.min(2, mine.triples.get(newK)!);
            if (theirs.triples.has(oldK)) v += 4 + Math.min(2, theirs.triples.get(oldK)!);
            if (mine.triples.has(oldK)) v -= 4;
            if (theirs.triples.has(newK)) v -= 4;
            return v > 0 ? v : null;
        }
        case 'remove': {
            if (rem && rem.type === 'blocker') {
                const [x, y] = SLOT_TO_STATIONS[rem.slotId];
                return mine.pairs.has(pairKey(x, y)) ? 3 : 0.5;
            }
            const k = arrowTriple(rem as never);
            const r = rem as { fromStation: string; toStation: string };
            let v = 0.5; // removals are few and can orphan: always worth a look
            if (theirs.triples.has(k)) v += 5;
            if (mine.triples.has(k)) v -= 5;
            if (mine.pairs.has(pairKey(r.fromStation, r.toStation))) v += 1;
            return v > 0 ? v : null;
        }
        case 'blocker': {
            const to = (add as { slotId: number }).slotId;
            const [x, y] = SLOT_TO_STATIONS[to];
            const pk = pairKey(x, y);
            if (!theirs.pairs.has(pk) || mine.pairs.has(pk)) return null;
            const from = (rem as { slotId: number }).slotId;
            const [fx, fy] = SLOT_TO_STATIONS[from];
            // freeing one of my own channels is a bonus
            return 1.5 + (mine.pairs.has(pairKey(fx, fy)) ? 1 : 0);
        }
        default:
            return null;
    }
};

// =============================================================
// Opening plan
// =============================================================

// Opening plan for the race agent: the first three moves of each player.
//
// What the BGA games show (docs/strategy/opening.md):
//   * 15 of 16 cyan openers and 11 of 16 yellow openers laid the pattern's
//     first-colour bridge from the base to an adjacent inner station, then the
//     return bridge or a bridge to the other neighbour. They are committing to
//     a compact "hub and spokes" structure next to the base.
//   * Every winning path used 3-4 stations for its 7 intermediate visits.
//   * Bridge-laying speed alone did not predict the winner (at move 6 the
//     eventual losers were slightly ahead on average); the choice of structure
//     did.
//
// So the opening picks, among the bridges that touch the base (or the station
// the first bridge reached) and shorten our own race distance, the one that keeps the most compact cheapest routes alive (routes with at
// most three distinct intermediate stations), avoids pairs the opponent's
// routes already need (contested pairs get blocked first), and only then
// prefers moves that also lengthen the opponent's race: this early, both sides
// have dozens of equally cheap routes, so a +1 against the opponent is routed
// around for free while a scattered structure is a permanent cost.
//
// Moves 2 and 3 build Tony's beachhead: the same-colour return bridge, which
// locks the first link (neither bridge can be reversed, and neither can be
// removed while I hold both ends), then a ring on the station it reaches.
// That ring can't be orphaned in one move, so the first step out of the base
// is permanent and rings can always be placed. After three moves, or as soon
// as either player is within striking range, the search takes over.

/** Own moves played from the opening plan. */
export const OPENING_MOVES = 3;
/** The plan stands down once either race distance is this short. */
const OPENING_MIN_DISTANCE = 8;

export const openingMove = (
    state: FinityGameState,
    color: PlayerColor,
    legal: MoveAction[],
    mine: RouteSummary,
    theirs: RouteSummary,
): MoveAction | null => {
    const played = state.moveHistory.filter((r) => r.color === color).length;
    if (played >= OPENING_MOVES) return null;
    if (mine.distance < OPENING_MIN_DISTANCE || theirs.distance < OPENING_MIN_DISTANCE) return null;

    const opp = state.config.playerColors.find((c) => c !== color)!;
    const theirPlan = planOf(state, theirs);
    const base = basePostStation(state, color);
    if (!base) return null;

    if (played >= 1) {
        const lock = beachheadMove(state, color, base, legal);
        if (lock) return lock;
        if (played >= 2) return null;
    }

    // The fan: bridges touch the base, or the station our first bridge reached.
    const anchors = new Set<StationName>([base]);
    for (const r of state.moveHistory) {
        const p = r.move.pieceToAdd;
        if (r.color === color && r.move.type === 'place' && p?.type === 'arrow') {
            anchors.add(p.fromStation);
            anchors.add(p.toStation);
        }
    }
    anchors.delete('C' as StationName);

    let best: MoveAction | null = null;
    let bestScore = -Infinity;
    for (const m of legal) {
        if (m.type !== 'place' || m.pieceToAdd?.type !== 'arrow') continue;
        const a = m.pieceToAdd;
        if (!anchors.has(a.fromStation) && !anchors.has(a.toStation)) continue;
        const child = applyMove(state, m);
        const s = routeSummary(child, color, 0, true);
        if (s.distance >= mine.distance) continue; // the plan must make progress

        const contested = theirPlan.pairs.has(pairKey(a.fromStation, a.toStation)) ? 1 : 0;
        const oppGain = routeSummary(child, opp, 0, true).distance - theirs.distance;
        // a bridge into the centre this early is a commitment to one exit; keep it for later
        const centre = a.toStation === 'C' || a.fromStation === 'C' ? 1 : 0;

        const score =
            10 * (mine.distance - s.distance) +
            3 * Math.log2(1 + s.compactCount) +
            1 * Math.log2(1 + s.bestCount) +
            0.5 * oppGain -
            3 * contested -
            2 * centre;
        if (score > bestScore) {
            bestScore = score;
            best = m;
        }
    }
    return best;
};

/**
 * the first bridge from the base (colour
 * c, to station x), its return bridge x -> base in colour c, then a ring on x.
 * A missing first bridge is re-laid first. Null when the beachhead is done or
 * can't be built.
*/
const beachheadMove = (
    state: FinityGameState,
    color: PlayerColor,
    base: StationName,
    legal: MoveAction[]
): MoveAction | null => {
    const first = state.moveHistory.find((r) =>
        r.color === color && r.move.type === 'place' &&
        r.move.pieceToAdd?.type === 'arrow' &&
        r.move.pieceToAdd.fromStation === base);

    const a = first?.move.pieceToAdd;
    if (!a || a.type !== 'arrow' || a.toStation === 'C') return null;
    const x = a.toStation;
    const has = (from: StationName, to: StationName): boolean =>
        state.board.slots.some((sl) => sl.contains?.type === 'arrow' && sl.contains.fromStation === from && sl.contains.toStation === to && sl.contains.color === a.color);
    const place = (from: StationName, to: StationName): MoveAction | undefined =>
        legal.find((m) => m.type === 'place' && m.pieceToAdd?.type === 'arrow' &&
            m.pieceToAdd.fromStation === from && m.pieceToAdd.toStation === to && m.pieceToAdd.color === a.color);
    if (!has(base, x)) return place(base, x) ?? null;
    if (!has(x, base)) return place(x, base) ?? null;
    // my ring must take x's high point, or it isn't safe
    if (state.board.stations[x].rings[0] !== null) return null;
    return legal.find((m) => m.type === 'place' && m.pieceToAdd?.type === 'ring' && m.station === x) ?? null;
};
