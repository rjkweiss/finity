/**
 * Finity Game Engine — Race distance
 *
 * How many moves does a player still need to complete a path, if nobody
 * interferes? This is the quantity the whole strategy is built on, so it is
 * computed exactly over route templates rather than by a shortest-path
 * relaxation:
 *
 *   A route is a walk of 8 steps from a start station to the centre that
 *   follows the board's adjacency and never enters the centre early. On the
 *   2-player board there are 492-622 such walks per start station, so every
 *   one of them can be priced.
 *
 *   Price of a walk =
 *       for each DISTINCT (from, to, colour) step it needs
 *           0  an arrow already does it
 *           1  the same colour points the other way and the walk does not need
 *              that arrow as it stands (one reversal)
 *           1  an open slot in that station pair (one placement)
 *           2  a slot taken by an arrow the walk does not use (remove + place)
 *     + for each intermediate station: max(0, visits - my rings there)
 *       (infeasible if that exceeds the free ring positions, or if the station
 *        is my own base post station, where rings cannot be placed)
 *
 * The ring term counts one ring per VISIT, which is what the rules require
 * (layered.ts charges at most one per station and so reports 0 for positions
 * that are still a ring or two short).
 *
 * raceDistance() also tries every legal base-post relocation: moving the base
 * onto a station that already holds a stack is the largest single-move gain in
 * the human games (3-4 moves at once), and two of the sixteen BGA games were
 * won by it. Relocation is priced as 1 move plus the distance from the new
 * station, after removing the rings the relocation would orphan.
 *
 * Distance 0 coincides with hasFullPath on every position of the BGA corpus.
 */

import type { FinityGameState, PlayerColor, StationName } from './types';
import { STATION_SLOTS } from './topology';
import { stationControlledBy } from './engine';
import { basePostStation, reachableStations } from './path-analyzer';

export const NO_ROUTE = 99;
const STEPS = 8;

// =============================================================
// Board index (per active-station set)
// =============================================================

interface BoardIndex {
    readonly names: StationName[];
    readonly idx: Map<StationName, number>;
    readonly n: number;
    readonly center: number;
    /** (a * n + b) -> [L, C, R] slot ids, or undefined when not adjacent */
    readonly pairSlots: Array<readonly number[] | undefined>;
    readonly adj: number[][];
}

const BOARD_CACHE = new Map<string, BoardIndex>();

const boardIndex = (state: FinityGameState): BoardIndex => {
    const names = (Object.keys(state.board.stations) as StationName[]).slice().sort();
    const key = names.join(',');
    const hit = BOARD_CACHE.get(key);
    if (hit) return hit;

    const n = names.length;
    const idx = new Map<StationName, number>();
    names.forEach((s, i) => idx.set(s, i));
    const pairSlots: Array<readonly number[] | undefined> = new Array(n * n);
    const adj: number[][] = names.map(() => []);
    for (const a of names) {
        const nb = STATION_SLOTS[a] ?? {};
        for (const b of Object.keys(nb) as StationName[]) {
            if (!idx.has(b)) continue;
            const ch = nb[b]!;
            pairSlots[idx.get(a)! * n + idx.get(b)!] = [ch.L, ch.C, ch.R];
            adj[idx.get(a)!].push(idx.get(b)!);
        }
    }
    const bi: BoardIndex = { names, idx, n, center: idx.get('C' as StationName)!, pairSlots, adj };
    BOARD_CACHE.set(key, bi);
    return bi;
};

// =============================================================
// Walk templates (per board, start station and pattern)
// =============================================================

interface WalkTable {
    readonly count: number;
    /** count * 9 station indices */
    readonly stations: Int8Array;
    /** ring visits: for walk w, entries [visitStart[w], visitStart[w+1]) of (station, visits) pairs */
    readonly visitStart: Int32Array;
    readonly visitStation: Int8Array;
    readonly visitCount: Int8Array;
    /** distinct step requirements, encoded (a * n + b) * 2 + colour */
    readonly reqStart: Int32Array;
    readonly reqs: Int32Array;
}

const WALK_CACHE = new Map<string, WalkTable>();

const walkTable = (bi: BoardIndex, start: number, pattern: readonly string[]): WalkTable => {
    const key = `${bi.names.join(',')}|${start}|${pattern.join('')}`;
    const hit = WALK_CACHE.get(key);
    if (hit) return hit;

    const walks: number[][] = [];
    const path = [start];
    const dfs = (): void => {
        const k = path.length - 1;
        if (k === STEPS) {
            if (path[k] === bi.center) walks.push(path.slice());
            return;
        }
        for (const nb of bi.adj[path[k]]) {
            if ((nb === bi.center) !== (k === STEPS - 1)) continue;
            path.push(nb);
            dfs();
            path.pop();
        }
    };
    dfs();

    const count = walks.length;
    const stations = new Int8Array(count * 9);
    const visitStart = new Int32Array(count + 1);
    const reqStart = new Int32Array(count + 1);
    const vS: number[] = [];
    const vC: number[] = [];
    const rq: number[] = [];
    walks.forEach((w, wi) => {
        w.forEach((s, j) => (stations[wi * 9 + j] = s));
        const visits = new Map<number, number>();
        for (let j = 1; j < STEPS; j++) visits.set(w[j], (visits.get(w[j]) ?? 0) + 1);
        visitStart[wi] = vS.length;
        for (const [s, c] of visits) {
            vS.push(s);
            vC.push(c);
        }
        reqStart[wi] = rq.length;
        const seen = new Set<number>();
        for (let j = 0; j < STEPS; j++) {
            const code = (w[j] * bi.n + w[j + 1]) * 2 + (pattern[j] === 'b' ? 0 : 1);
            if (!seen.has(code)) {
                seen.add(code);
                rq.push(code);
            }
        }
    });
    visitStart[count] = vS.length;
    reqStart[count] = rq.length;

    const table: WalkTable = {
        count,
        stations,
        visitStart,
        visitStation: Int8Array.from(vS),
        visitCount: Int8Array.from(vC),
        reqStart,
        reqs: Int32Array.from(rq),
    };
    WALK_CACHE.set(key, table);
    return table;
};

// =============================================================
// Per-position bookkeeping
// =============================================================

interface ArrowFacts {
    /** (a * n + b) * 2 + colour -> number of such arrows */
    readonly dir: Int8Array;
    /** unordered pair (min * n + max) -> empty, unblocked slots */
    readonly open: Int8Array;
    /** unordered pair -> arrows of any colour/direction */
    readonly arrows: Int8Array;
}

const arrowFacts = (state: FinityGameState, bi: BoardIndex): ArrowFacts => {
    const n = bi.n;
    const dir = new Int8Array(n * n * 2);
    const open = new Int8Array(n * n);
    const arrows = new Int8Array(n * n);
    for (let a = 0; a < n; a++) {
        for (const b of bi.adj[a]) {
            if (b < a) continue;
            const ids = bi.pairSlots[a * n + b]!;
            for (const id of ids) {
                const sl = state.board.slots[id];
                if (!sl) continue;
                const p = sl.contains;
                if (!p) {
                    if (!sl.blocked) open[a * n + b]++;
                } else if (p.type === 'arrow') {
                    arrows[a * n + b]++;
                    const f = bi.idx.get(p.fromStation)!;
                    const t = bi.idx.get(p.toStation)!;
                    dir[(f * n + t) * 2 + (p.color === 'b' ? 0 : 1)]++;
                }
            }
        }
    }
    return { dir, open, arrows };
};

interface RingFacts {
    readonly have: Int8Array;
    readonly free: Int8Array;
}

const ringFacts = (state: FinityGameState, bi: BoardIndex, color: PlayerColor): RingFacts => {
    const have = new Int8Array(bi.n);
    const free = new Int8Array(bi.n);
    bi.names.forEach((name, i) => {
        for (const r of state.board.stations[name].rings) {
            if (!r) free[i]++;
            else if (r.color === color) have[i]++;
        }
    });
    return { have, free };
};

/**
 * Fragility weight of a step into each station another player controls: 1 for
 * a station they hold with their top ring, BASE_STEP_WEIGHT for the station
 * holding their base post (their control there is permanent), 0 otherwise.
 */
export const BASE_STEP_WEIGHT = 3;
const foreignControl = (state: FinityGameState, bi: BoardIndex, color: PlayerColor): Uint8Array => {
    const out = new Uint8Array(bi.n);
    bi.names.forEach((name, i) => {
        if (i === bi.center) return; // bridges into the centre cannot be removed in one move
        const st = state.board.stations[name];
        const owner = stationControlledBy(st);
        if (owner !== null && owner !== color) out[i] = st.basePost && st.basePost !== color ? BASE_STEP_WEIGHT : 1;
    });
    return out;
};

// =============================================================
// Pricing
// =============================================================

/** One priced route, for move relevance and debugging. */
export interface PricedRoute {
    readonly start: StationName;
    /** 9 station names, start first, centre last */
    readonly stations: StationName[];
    /** Moves needed, including the relocation move when `relocated` is set. */
    readonly cost: number;
    readonly relocated: boolean;
}

export interface RouteSummary {
    /** Moves to complete from the current base post (NO_ROUTE if none). */
    readonly fromBase: number;
    /** Best over the current base and every legal relocation (+1 for the move). */
    readonly distance: number;
    /** Relocation target when that is the best plan, else null. */
    readonly relocateTo: StationName | null;
    /** Distinct walks achieving `distance` (capped): route redundancy. */
    readonly bestCount: number;
    /** Of those, walks using at most 3 distinct intermediate stations (hub-and-spoke shapes). */
    readonly compactCount: number;
    /**
     * Fewest steps, over the cheapest walks, that the opponent can undo in one
     * move: a step into a station another player controls (the controller may
     * remove any bridge pointing into it), or a step whose bridge can be
     * reversed (anyone may reverse a bridge unless the same colour already runs
     * the other way in that pair, which makes the reversal redundant). Undoing
     * a step also orphans the rings beyond it, so these are standing
     * liabilities rather than settled progress. Steps into the centre are
     * exempt from removal, and are not counted. A step into the station
     * holding another player's base post counts BASE_STEP_WEIGHT, because that
     * player can remove it at any time.
     */
    readonly fragility: number;
    /**
     * Objective path cost (Tony's "objective path"): moves to complete a path
     * that could stand up to opposition - only currently open slots, no
     * station the opponent controls (base post or top ring), and every step
     * into a ringed station doubled (same colour both ways) except at most
     * one. NO_ROUTE when no such path exists. Always >= distance.
     */
    readonly objective: number;
    /** The objective path itself, or null. */
    readonly objectiveRoute: PricedRoute | null;
    /** Walks within `distance + slack` (capped), cheapest first. */
    readonly routes: PricedRoute[];
}

const COUNT_CAP = 64;
const ROUTE_CAP = 24;

interface PriceResult {
    best: number;
    bestCount: number;
    compactCount: number;
    fragility: number;
    near: Array<{ w: number; cost: number }>;
    /** Cheapest objective (robust) cost, NO_ROUTE if none; see objectiveCost(). */
    objective: number;
    /** Walk index of that objective route, or -1. */
    objectiveWalk: number;
}

const priceWalks = (
    bi: BoardIndex,
    table: WalkTable,
    af: ArrowFacts,
    have: Int8Array,
    free: Int8Array,
    foreign: Uint8Array,
    start: number,
    bound: number,
    slack: number,
): PriceResult => {
    const n = bi.n;
    let objective = NO_ROUTE;
    let objectiveWalk = -1;
    const doubleNeed = new Int32Array(8);
    let best = bound;
    let bestCount = 0;
    let compactCount = 0;
    let fragility = 99;
    const near: Array<{ w: number; cost: number }> = [];
    const pairNeed = new Int32Array(8);
    const pairKey = new Int32Array(8);
    const pairUsed = new Int32Array(8);

    for (let w = 0; w < table.count; w++) {
        // ring deficit first: cheap, and a valid lower bound
        let rc = 0;
        let feasible = true;
        for (let v = table.visitStart[w]; v < table.visitStart[w + 1]; v++) {
            const s = table.visitStation[v];
            const d = table.visitCount[v] - have[s];
            if (d > 0) {
                if (s === start || d > free[s]) {
                    feasible = false;
                    break;
                }
                rc += d;
            }
        }
        // a walk is worth pricing if it could improve the race price or the objective
        if (!feasible || (rc > best + slack && rc >= objective)) continue;

        let ac = 0;
        let np = 0;
        let reversedAny = false;
        let reversedMask = 0; // bit r - r0: step satisfied by reversing an existing arrow
        const r0 = table.reqStart[w];
        const r1 = table.reqStart[w + 1];
        for (let r = r0; r < r1; r++) {
            const code = table.reqs[r];
            if (af.dir[code] > 0) {
                // satisfied by an existing arrow: that arrow is "used" in its pair
                const ab = code >> 1;
                const a = (ab / n) | 0;
                const b = ab - a * n;
                const pk = a < b ? a * n + b : b * n + a;
                let j = 0;
                while (j < np && pairKey[j] !== pk) j++;
                if (j === np) {
                    pairKey[np] = pk;
                    pairNeed[np] = 0;
                    pairUsed[np] = 0;
                    np++;
                }
                pairUsed[j]++;
                continue;
            }
            const ab = code >> 1;
            const c = code & 1;
            const a = (ab / n) | 0;
            const b = ab - a * n;
            const rev = (b * n + a) * 2 + c;
            if (af.dir[rev] > 0) {
                // reversible unless the walk also needs the arrow as it stands
                let needed = false;
                for (let q = r0; q < r1; q++) if (table.reqs[q] === rev) needed = true;
                if (!needed) {
                    ac += 1;
                    reversedAny = true;
                    reversedMask |= 1 << (r - r0);
                    continue;
                }
            }
            const pk = a < b ? a * n + b : b * n + a;
            let j = 0;
            while (j < np && pairKey[j] !== pk) j++;
            if (j === np) {
                pairKey[np] = pk;
                pairNeed[np] = 0;
                pairUsed[np] = 0;
                np++;
            }
            pairNeed[j]++;
        }
        let displaces = false;
        for (let j = 0; j < np && feasible; j++) {
            const need = pairNeed[j];
            if (need === 0) continue;
            const open = af.open[pairKey[j]];
            if (need <= open) {
                ac += need;
            } else {
                const extra = need - open;
                const displaceable = af.arrows[pairKey[j]] - pairUsed[j];
                if (extra > displaceable) feasible = false;
                else {
                    ac += open + 2 * extra;
                    displaces = true;
                }
            }
        }
        if (!feasible) continue;

        const cost = rc + ac;

        // Objective (Tony's "objective path"): the same walk, built so it can
        // stand up to opposition. It must use only currently open slots (no
        // displacing), must not pass through a station another player
        // controls, and every step into a ringed station must be doubled -
        // the same colour also running the other way, so neither bridge can
        // be reversed and a removed one can be replaced by reversing the
        // other - except at most one. Cost = moves to build it unopposed.
        if (!displaces && cost < objective) {
            let ok = true;
            for (let j = 1; j < 8 && ok; j++) if (foreign[table.stations[w * 9 + j]]) ok = false;
            if (ok) {
                for (let j = 0; j < np; j++) doubleNeed[j] = 0;
                let doubles = 0;
                for (let r = r0; r < r1; r++) {
                    const code = table.reqs[r];
                    const ab = code >> 1;
                    const a = (ab / n) | 0;
                    const b = ab - a * n;
                    if (b === bi.center) continue; // bridges into the centre support no ring
                    const back = (b * n + a) * 2 + (code & 1);
                    let doubled = false;
                    for (let q = r0; q < r1 && !doubled; q++) if (table.reqs[q] === back) doubled = true;
                    // an existing back arrow doubles the step, unless that very arrow is the one being reversed into place
                    if (!doubled && af.dir[back] > 0 && !(reversedAny && (reversedMask >> (r - r0)) & 1)) doubled = true;
                    if (doubled) continue;
                    const pk = a < b ? a * n + b : b * n + a;
                    let j = 0;
                    while (j < np && pairKey[j] !== pk) j++;
                    if (j === np) {
                        // pair not yet touched by this walk's placements
                        pairKey[np] = pk;
                        pairNeed[np] = 0;
                        pairUsed[np] = 0;
                        doubleNeed[np] = 0;
                        np++;
                    }
                    doubleNeed[j]++;
                    doubles++;
                }
                let undoublable = 0;
                for (let j = 0; j < np; j++) {
                    const room = af.open[pairKey[j]] - pairNeed[j];
                    if (doubleNeed[j] > room) undoublable += doubleNeed[j] - Math.max(0, room);
                }
                if (undoublable <= 1) {
                    // one step may stay single: the free one if all fit, else the one that can't be doubled
                    const obj = cost + Math.max(0, doubles - 1);
                    if (obj < objective) {
                        objective = obj;
                        objectiveWalk = w;
                    }
                }
            }
        }
        const compact = table.visitStart[w + 1] - table.visitStart[w] <= 3 ? 1 : 0;
        if (cost <= best) {
            // distinct steps the opponent can undo with one move: a reversal
            // (legal unless the same colour already runs the other way in that
            // pair - a "locked" link) or a removal (by whoever controls the tip)
            let frag = 0;
            for (let r = r0; r < r1; r++) {
                const code = table.reqs[r];
                const ab = code >> 1;
                const a = (ab / n) | 0;
                const b = ab - a * n;
                if (foreign[b]) {
                    // a base post never leaves on its own: its owner can remove
                    // this bridge whenever it matters, so it counts triple
                    frag += foreign[b];
                    continue;
                }
                const back = (b * n + a) * 2 + (code & 1);
                let locked = af.dir[back] > 0;
                for (let q = r0; q < r1 && !locked; q++) if (table.reqs[q] === back) locked = true;
                if (!locked && b !== bi.center) frag++;
            }
            if (cost < best) {
                best = cost;
                bestCount = 1;
                compactCount = compact;
                fragility = frag;
            } else {
                if (bestCount < COUNT_CAP) bestCount++;
                if (compactCount < COUNT_CAP) compactCount += compact;
                if (frag < fragility) fragility = frag;
            }
        }
        if (cost <= best + slack) near.push({ w, cost });
    }

    return { best, bestCount, compactCount, fragility, near, objective, objectiveWalk };
};

const toRoute = (bi: BoardIndex, table: WalkTable, w: number, cost: number, relocated: boolean): PricedRoute => {
    const stations: StationName[] = [];
    for (let j = 0; j < 9; j++) stations.push(bi.names[table.stations[w * 9 + j]]);
    return { start: stations[0], stations, cost, relocated };
};

/**
 * Route summary for `color`. `slack` keeps routes up to that many moves worse
 * than the best (used to decide which moves are relevant); `relocation`
 * switches the base-post relocation check on (default) or off.
 */
export const routeSummary = (
    state: FinityGameState,
    color: PlayerColor,
    slack = 0,
    relocation = true,
): RouteSummary => {
    const bi = boardIndex(state);
    const baseName = basePostStation(state, color);
    if (!baseName) {
        return { fromBase: NO_ROUTE, distance: NO_ROUTE, relocateTo: null, bestCount: 0, compactCount: 0, fragility: 0, objective: NO_ROUTE, objectiveRoute: null, routes: [] };
    }
    const base = bi.idx.get(baseName)!;
    const af = arrowFacts(state, bi);
    const rf = ringFacts(state, bi, color);
    const foreign = foreignControl(state, bi, color);

    const directTable = walkTable(bi, base, state.pathPattern);
    const direct = priceWalks(bi, directTable, af, rf.have, rf.free, foreign, base, NO_ROUTE, slack);
    let objective = direct.objective;
    let objectiveRoute: PricedRoute | null = direct.objectiveWalk >= 0 ? toRoute(bi, directTable, direct.objectiveWalk, direct.objective, false) : null;
    let distance = direct.best;
    let bestCount = direct.bestCount;
    let compactCount = direct.compactCount;
    let fragility = direct.fragility;
    let relocateTo: StationName | null = null;
    const candidates: Array<{ table: WalkTable; w: number; cost: number; relocated: boolean }> =
        direct.near.map((x) => ({ table: walkTable(bi, base, state.pathPattern), w: x.w, cost: x.cost, relocated: false }));

    if (relocation) {
        for (let t = 0; t < bi.n; t++) {
            if (t === base || t === bi.center) continue;
            const st = state.board.stations[bi.names[t]];
            if (st.basePost) continue;
            // a relocation is a move: it can only help when 1 + lower bound < best
            if (1 >= distance + slack && 1 >= objective) break;

            const reach = reachableStations(state, color, bi.names[t]);
            // legality: the new start must still reach one of the player's rings
            let legal = false;
            const have = new Int8Array(bi.n);
            const free = new Int8Array(rf.free);
            for (let s = 0; s < bi.n; s++) {
                if (rf.have[s] === 0) continue;
                if (reach.has(bi.names[s])) {
                    have[s] = rf.have[s];
                    if (s !== bi.center) legal = true;
                } else {
                    free[s] += rf.have[s]; // orphaned by the relocation
                }
            }
            if (!legal) continue;

            const table = walkTable(bi, t, state.pathPattern);
            // after the move my base post holds t's high point
            const was = foreign[t];
            foreign[t] = 0;
            const res = priceWalks(bi, table, af, have, free, foreign, t, distance - 1 + slack, slack);
            foreign[t] = was;
            if (res.objectiveWalk >= 0 && res.objective + 1 < objective) {
                objective = res.objective + 1;
                objectiveRoute = toRoute(bi, table, res.objectiveWalk, objective, true);
            }
            const total = res.best + 1;
            if (total < distance) {
                distance = total;
                bestCount = res.bestCount;
                compactCount = res.compactCount;
                fragility = res.fragility;
                relocateTo = bi.names[t];
            } else if (total === distance) {
                bestCount = Math.min(COUNT_CAP, bestCount + res.bestCount);
                compactCount = Math.min(COUNT_CAP, compactCount + res.compactCount);
                fragility = Math.min(fragility, res.fragility);
            }
            for (const x of res.near) candidates.push({ table, w: x.w, cost: x.cost + 1, relocated: true });
        }
    }

    const routes = candidates
        .filter((c) => c.cost <= distance + slack)
        .sort((a, b) => a.cost - b.cost)
        .slice(0, ROUTE_CAP)
        .map((c) => toRoute(bi, c.table, c.w, c.cost, c.relocated));

    return { fromBase: direct.best, distance, relocateTo, bestCount, compactCount, fragility: fragility === 99 ? 0 : fragility, objective, objectiveRoute, routes };
};

/** Moves to complete a path, counting rings per visit and base relocation. */
export const raceDistance = (state: FinityGameState, color: PlayerColor): number =>
    routeSummary(state, color, 0, true).distance;
