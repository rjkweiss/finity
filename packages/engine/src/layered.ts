/**
 * Finity Game Engine — Layered Path Planner
 *
 * Answers one question: how many moves is a player from completing a path?
 *
 * A winning path is a walk of exactly 8 arrow steps from the player's base
 * post to the centre, where step k must use an arrow of colour
 * `pathPattern[k]`, with one of the player's rings on every intermediate
 * station visited. That is a 9-layer graph (layer = step number, 0..8) over
 * the stations, small enough to search exhaustively in well under a
 * millisecond.
 *
 * The planner runs a shortest-path search over (station, layer), where each
 * step costs the moves needed to make it possible:
 *
 *   arrow of the right colour already points the right way   0
 *   same colour points the wrong way (one reversal)          1
 *   an open slot in that station pair (one placement)        1
 *   a wrong-colour arrow in the pair (removal + placement)   2
 *   a ring needed on the station we arrive at                +1
 *
 */

import type {
    FinityGameState,
    PlayerColor,
    StationName,
} from './types';
import { STATION_SLOTS, NAME_TO_NUMBER, NUMBER_TO_NAME } from './topology';
import { basePostStation } from './path-analyzer';

// =============================================================
// Constants
// =============================================================

const PATH_STEPS = 8;              // layers 0..8
const RING_SUPPLY_PER_SIZE = 8;    // mirrors possible-moves.ts
const ARROW_SUPPLY_PER_COLOR = 32; // mirrors possible-moves.ts

const COST_EXISTING = 0;
const COST_REVERSE = 1;
const COST_PLACE = 1;
const COST_DISPLACE = 2;
const COST_RING = 1;

/** Upper bound on any path's cost, for sizing the bucket queue. */
const MAX_COST = PATH_STEPS * (COST_DISPLACE + COST_RING);

export const UNREACHABLE = Infinity;

const RING_SIZES = ['s', 'm', 'l'] as const; // index matches StationState.rings

// =============================================================
// Public types
// =============================================================

export type StepKind = 'existing' | 'reverse' | 'place' | 'displace';

export interface PlanStep {
    readonly layer: number;
    readonly from: StationName;
    readonly to: StationName;
    readonly kind: StepKind;
    /** True when arriving at `to` also needs a ring placed. */
    readonly needsRing: boolean;
}

export interface LayeredPlan {
    /** Minimum moves (arrows + rings) to complete a path. Infinity if none. */
    readonly movesToWin: number;
    /** Rings still needed along the cheapest route, counting repeat visits. */
    readonly ringDeficit: number;
    /** The cheapest route, or null when none exists. For debugging and UI. */
    readonly route: ReadonlyArray<PlanStep> | null;
}

const NO_PLAN: LayeredPlan = { movesToWin: UNREACHABLE, ringDeficit: 0, route: null };

// =============================================================
// Static tables, built once at module load
// =============================================================

const N_STATIONS = 13;
const N_NODES = N_STATIONS * (PATH_STEPS + 1);
const C_IDX = NAME_TO_NUMBER.C;

/** stationIdx -> adjacent stationIdx list */
const NEIGHBOURS: number[][] = Array.from({ length: N_STATIONS }, () => []);
/** (from * N_STATIONS + to) * 3 + i -> the i-th slot of that pair, or -1 */
const PAIR_SLOTS = new Int16Array(N_STATIONS * N_STATIONS * 3).fill(-1);

for (const [from, nbrs] of Object.entries(STATION_SLOTS)) {
    const fi = NAME_TO_NUMBER[from as StationName];
    for (const [to, ch] of Object.entries(nbrs ?? {})) {
        const ti = NAME_TO_NUMBER[to as StationName];
        if (ti === undefined || !ch) continue;
        NEIGHBOURS[fi].push(ti);
        const base = (fi * N_STATIONS + ti) * 3;
        PAIR_SLOTS[base] = ch.L;
        PAIR_SLOTS[base + 1] = ch.C;
        PAIR_SLOTS[base + 2] = ch.R;
    }
}

// Search scratch, reused across calls. Single-threaded, and every entry is
// written before it is read within a call.
const DIST = new Float64Array(N_NODES);
const PREV = new Int32Array(N_NODES);
const PREV_KIND = new Int8Array(N_NODES);
const PREV_RING = new Int8Array(N_NODES);

const KINDS: StepKind[] = ['existing', 'reverse', 'place', 'displace'];

// =============================================================
// Cache
// =============================================================

/**
 * Keyed on the state object, stamped with its Zobrist hash. applyMove always
 * returns a fresh object, so a new position is a cache miss by construction;
 * the stamp guards against a state being mutated in place.
 */
const CACHE = new WeakMap<FinityGameState, Map<PlayerColor, { plan: LayeredPlan; stamp: string }>>();

export const layeredPlan = (
    state: FinityGameState,
    color: PlayerColor
): LayeredPlan => {
    let byColor = CACHE.get(state);
    if (!byColor) {
        byColor = new Map();
        CACHE.set(state, byColor);
    }
    const hit = byColor.get(color);
    if (hit && hit.stamp === state.zobristHash) return hit.plan;

    const plan = buildPlan(state, color);
    byColor.set(color, { plan, stamp: state.zobristHash });

    return plan;
};

/** Convenience accessor. */
export const movesToWin = (state: FinityGameState, color: PlayerColor): number =>
    layeredPlan(state, color).movesToWin;

// =============================================================
// Plan construction
// =============================================================

const buildPlan = (state: FinityGameState, color: PlayerColor): LayeredPlan => {
    const start = basePostStation(state, color);
    const pattern = state.pathPattern;
    if (!start || pattern.length !== PATH_STEPS) return NO_PLAN;

    const slots = state.board.slots;

    // Outgoing arrows, indexed (stationIdx * 2 + colourIdx) -> [toIdx, ...]
    const out: Array<number[] | undefined> = new Array(N_STATIONS * 2);
    let blackOnBoard = 0;
    let whiteOnBoard = 0;
    for (const slot of slots) {
        const p = slot.contains;
        if (!p || p.type !== 'arrow') continue;
        if (p.color === 'b') blackOnBoard++;
        else whiteOnBoard++;
        const fi = NAME_TO_NUMBER[p.fromStation];
        const ti = NAME_TO_NUMBER[p.toStation];
        const key = fi * 2 + (p.color === 'b' ? 0 : 1);
        (out[key] ??= []).push(ti);
    }
    const supplyFull = [blackOnBoard >= ARROW_SUPPLY_PER_COLOR, whiteOnBoard >= ARROW_SUPPLY_PER_COLOR];

    // Ring bookkeeping for this player.
    const used: Record<'s' | 'm' | 'l', number> = { s: 0, m: 0, l: 0 };
    const ringHave = new Int8Array(N_STATIONS);
    const ringPlaceable = new Uint8Array(N_STATIONS);
    const exists = new Uint8Array(N_STATIONS);

    for (const st of Object.values(state.board.stations)) {
        for (const r of st.rings) if (r && r.color === color) used[r.size]++;
    }
    for (const [name, st] of Object.entries(state.board.stations)) {
        const idx = NAME_TO_NUMBER[name as StationName];
        exists[idx] = 1;
        let have = 0;
        let placeable = 0;
        st.rings.forEach((r, i) => {
            if (r && r.color === color) have++;
            // A free position of a size we still hold in supply.
            if (!r && used[RING_SIZES[i]] < RING_SUPPLY_PER_SIZE) placeable = 1;
        });
        ringHave[idx] = have;
        ringPlaceable[idx] = placeable;
    }

    /** Cheapest way to get an arrow of colour ci pointing fi -> ti, or -1. */
    const stepCost = (fi: number, ti: number, ci: number): number => {
        const base = (fi * N_STATIONS + ti) * 3;
        if (PAIR_SLOTS[base] < 0) return -1;

        const fwd = out[fi * 2 + ci];
        if (fwd && fwd.includes(ti)) return COST_EXISTING << 4;       // kind 0

        const back = out[ti * 2 + ci];
        if (back && back.includes(fi)) return (COST_REVERSE << 4) | 1; // kind 1

        if (supplyFull[ci]) return -1;
        let wrongColour = false;
        for (let i = 0; i < 3; i++) {
            const slot = slots[PAIR_SLOTS[base + i]];
            if (!slot) continue;
            if (!slot.contains && !slot.blocked) return (COST_PLACE << 4) | 2; // kind 2
            const p = slot.contains;
            if (p && p.type === 'arrow' && (p.color === 'b' ? 0 : 1) !== ci) wrongColour = true;
        }

        return wrongColour ? (COST_DISPLACE << 4) | 3 : -1;             // kind 3
    };

    // Bucket-queue Dijkstra over node = layer * N_STATIONS + station.
    const startIdx = NAME_TO_NUMBER[start];
    DIST.fill(UNREACHABLE);
    DIST[startIdx] = 0;
    const buckets: number[][] = Array.from({ length: MAX_COST + 1 }, () => []);
    buckets[0].push(startIdx);

    let goal = -1;
    let goalCost = UNREACHABLE;

    search: for (let c = 0; c <= MAX_COST; c++) {
        const bucket = buckets[c];
        for (let b = 0; b < bucket.length; b++) {
            const node = bucket[b];
            if (DIST[node] < c) continue;
            const k = (node / N_STATIONS) | 0;
            const si = node - k * N_STATIONS;

            if (k === PATH_STEPS) {
                if (si === C_IDX) {
                    goal = node;
                    goalCost = c;
                    break search;
                }
                continue;
            }

            const ci = pattern[k] === 'b' ? 0 : 1;
            const last = k === PATH_STEPS - 1;

            for (const ti of NEIGHBOURS[si]) {
                if (!exists[ti]) continue;
                // The centre may only be the final station of the path.
                if ((ti === C_IDX) !== last) continue;

                const packed = stepCost(si, ti, ci);
                if (packed < 0) continue;

                let ring = 0;
                if (!last && ringHave[ti] < 1) {
                    if (!ringPlaceable[ti]) continue; // saturated: corridor denied
                    ring = COST_RING;
                }

                const nc = c + (packed >> 4) + ring;
                if (nc > MAX_COST) continue;
                const next = (k + 1) * N_STATIONS + ti;
                if (nc < DIST[next]) {
                    DIST[next] = nc;
                    PREV[next] = node;
                    PREV_KIND[next] = packed & 0xf;
                    PREV_RING[next] = ring;
                    buckets[nc].push(next);
                }
            }
        }
    }

    if (goal < 0) return NO_PLAN;

    // Reconstruct the route.
    const route: PlanStep[] = [];
    for (let node = goal; node !== startIdx; node = PREV[node]) {
        const p = PREV[node];
        const k = (p / N_STATIONS) | 0;
        route.unshift({
            layer: k,
            from: NUMBER_TO_NAME[(p - k * N_STATIONS) as 0],
            to: NUMBER_TO_NAME[(node - (k + 1) * N_STATIONS) as 0],
            kind: KINDS[PREV_KIND[node]],
            needsRing: PREV_RING[node] === 1,
        });
    }

    // The search charges at most one ring per station, but a route may visit
    // a station more than once and needs one ring per visit. Recount.
    const visits = new Map<StationName, number>();
    for (let i = 0; i < route.length - 1; i++) {
        visits.set(route[i].to, (visits.get(route[i].to) ?? 0) + 1);
    }
    let ringDeficit = 0;
    for (const [station, n] of visits) {
        const have = ringHave[NAME_TO_NUMBER[station]];
        if (n > have) ringDeficit += n - have;
    }

    return { movesToWin: goalCost, ringDeficit, route };
};
