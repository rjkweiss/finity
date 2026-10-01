/**
 * Finity Game Engine — Evaluation Heuristics
 *
 * Pure functions that score a position for a given color. Used as the leaf
 * evaluation in Minimax (2-player) and as the rollout/biasing signal in MCTS
 * (3-4 player). Higher is better for `color`.
 *
 * Five of these measure offense (how much you've built / reach / control);
 * `orphanVulnerability` is the lone defensive term — it measures fragility,
 * i.e. how easily an opponent could orphan your supported rings.
 */

import type { FinityGameState, PlayerColor, StationName } from "./types";
import { getAllArrows, occupiesHighPoint, stationControlledBy, ringCount } from "./engine";
import { analyzePaths, orphanExposure, reachableStationCount, reachableStations } from "./path-analyzer";
import { STATION_SLOTS } from "./topology";
import { layeredPlan, UNREACHABLE } from "./layered";

// =============================================================
// 1. Longest bridge path (offense)
// =============================================================

/**
 * Longest path through the arrow/bridge network from the base post, ignoring
 * ring support. Measures raw reach of the arrow structure you can travel.
 */
export const longestBridgePath = (
    state: FinityGameState,
    color: PlayerColor
): number => {
    const all = analyzePaths(state, color).all;
    let best = 0;
    for (const p of all) if (p.stations.length > best) best = p.stations.length;
    return best;
}

// =============================================================
// 2. Longest supported path (offense)
// =============================================================

/**
 * Longest legal (ring-supported) path from the base post. This is the metric
 * closest to "progress toward victory" since a full path must be supported.
 */
export const longestSupportedPath = (
    state: FinityGameState,
    color: PlayerColor
): number => {
    return analyzePaths(state, color).longest;
}

// =============================================================
// 3. Reachable station count (offense)
// =============================================================

/** Re-exported from path-analyzer, which is its single home. */
export { reachableStationCount } from "./path-analyzer";

// =============================================================
// 4. Controlled station count (offense)
// =============================================================

/** How many stations the color holds the high point on (base post or topmost ring). */
export const controlledStationCount = (
    state: FinityGameState,
    color: PlayerColor
): number => {
    let count = 0;
    for (const station of Object.values(state.board.stations)) {
        if (stationControlledBy(station) === color) count++;
    }

    return count;
}

// =============================================================
// 5. Station-pair strength (offense)
// =============================================================

/**
 * Bridges where color holds both endpoints' high points. arrow-connected station
 * pairs the color fully owns. Rewards consolidated, hard-to-contest structure
 * rather than scattered single-station presence.
 */
export const stationPairStrength = (
    state: FinityGameState,
    color: PlayerColor
): number => {
    let score = 0;
    for (const arrow of getAllArrows(state)) {
        if (occupiesHighPoint(state, color, arrow.fromStation) &&
            occupiesHighPoint(state, color, arrow.toStation)) score++;
    }

    return score;
}

// =============================================================
// 6. Orphan vulnerability (defense) — the sixth metric
// =============================================================

/**
 * How many of the color's supported ring-stations a SINGLE opponent arrow
 * removal could orphan. These are effectively the articulation arrows of the
 * color's support graph: cut one, and a ring-bearing station drops out of the
 * legal-path set and its rings would be cleared.
 *
 * Returns a distinct count of exposed stations (not exposures), so a station
 * cuttable by several arrows still counts once. HIGHER IS WORSE for `color`;
 * weight it negatively in the combined score (see `evaluate`).
 *
 */
export const orphanVulnerability = (state: FinityGameState, color: PlayerColor): number => {
    return orphanExposure(state, color);
}

// =============================================================
// Combined evaluation
// =============================================================

const channelCounts = (
    state: FinityGameState,
    color: PlayerColor
): {closed: number; doubled: number} => {
    const frontier = reachableStations(state, color);
    let closed = 0;
    let doubled = 0;

    for (const from of frontier) {
        const neighbors = STATION_SLOTS[from];
        if (!neighbors) continue;

        for (const to of Object.keys(neighbors) as StationName[]) {
            if (!state.board.stations[to]) continue;
            const triplet = neighbors[to];
            if (!triplet) continue;

            let open = 0;
            for (const slotId of [triplet.L, triplet.C, triplet.R]) {
                const slot = state.board.slots[slotId];
                if (slot && !slot.contains && !slot.blocked) open++;
            }

            if (open === 0) closed++;
            else if (open >= 2) doubled++;
        }
    }

    return { closed, doubled };
};

/**
 * Directions out of your reachable set that can no longer be built in
 */
export const closedChannels = (state: FinityGameState, color: PlayerColor): number => channelCounts(state, color).closed;

/** Directions with redundant capacity - not closable in one opponent move */
export const channelRedundancy = (
    state: FinityGameState,
    color: PlayerColor
): number => channelCounts(state, color).doubled;

// =============================================================
// 9-10. Distance to completion (rings)
// =============================================================

/**
 * How close a player is to completing a path, in [0, 1]. Built on the layered
 * planner's `movesToWin`, which counts missing arrows AND missing rings, so a
 * ring on the route scores directly — the legacy terms only reward a ring when
 * it happens to extend a supported path or take a high point.
 *
 * Bounded rather than linear: going from 3 moves to 2 matters far more than
 * from 12 to 11, and "no route at all" is not merely "very far".
 */
const PROGRESS_SCALE = 6;

export const progress = (state: FinityGameState, color: PlayerColor): number => {
    const m = layeredPlan(state, color).movesToWin;
    return m === UNREACHABLE ? 0 : PROGRESS_SCALE / (PROGRESS_SCALE + m);
};

/** Rings still needed along the cheapest route. Higher is worse. */
export const ringDeficit = (state: FinityGameState, color: PlayerColor): number =>
    layeredPlan(state, color).ringDeficit;


// =============================================================
// Rings on the board
// =============================================================

/**
 * the number of rings a player has on the board is a good indication of
 * who is winning. Includes the ring each player starts with on the centre,
 * matching the engine's ringCount and the seven-ring victory threshold.
 */
export const ringsOnBoard = (state: FinityGameState, color: PlayerColor): number =>
    ringCount(state, color);

/**
 * rings spread over many stations are a stronger offence, and a bigger
 * threat, than the same rings stacked on a few. Counts distinct stations
 * holding at least one of the player's rings, not counting the centre: every
 * player starts with a ring there, so it says nothing about threat.
 */
export const ringSpread = (state: FinityGameState, color: PlayerColor): number => {
    let n = 0;
    for (const [name, st] of Object.entries(state.board.stations)) {
        if (name === 'C') continue;
        if (st.rings.some((r) => r !== null && r.color === color)) n++;
    }

    return n;
};

// =============================================================
// Base post threats
// =============================================================

/**
 * Could `color` move its base post to `station` next turn?
 *
 * The engine's rule (possible-moves canMoveBasePost): the station has no base
 * post, is not the centre, and a path starting there reaches a station holding
 * one of the player's rings. The starting station counts as reached, and every
 * legal path's first step must land on a station the player has a ring on. So
 * this is exactly: the station itself holds one of the player's rings, or an
 * arrow of the pattern's first colour leads from it to a neighbour (not the
 * centre) that does. A handful of lookups, where the engine's version
 * enumerates paths; a test checks the two agree on thousands of positions.
 */
export const canRelocateBasePost = (
    state: FinityGameState,
    color: PlayerColor,
    station: StationName,
    outArrows?: ReadonlyMap<StationName, ReadonlyArray<{ to: StationName; color: string }>>,
): boolean => {
    const st = state.board.stations[station];
    if (!st || st.basePost || station === 'C') return false;

    // The destination is itself on the new path.
    if (st.rings.some((r) => r !== null && r.color === color)) return true;

    const first = state.pathPattern[0];
    const arrows = outArrows?.get(station)
        ?? getAllArrows(state)
            .filter((a) => a.fromStation === station)
            .map((a) => ({ to: a.toStation, color: a.color }));

    for (const a of arrows) {
        if (a.color !== first || a.to === 'C') continue;
        const target = state.board.stations[a.to];
        if (target?.rings.some((r) => r !== null && r.color === color)) return true;
    }

    return false;
};

const outArrowIndex = (state: FinityGameState) => {
    const index = new Map<StationName, Array<{ to: StationName; color: string }>>();
    for (const a of getAllArrows(state)) {
        const list = index.get(a.fromStation) ?? [];
        list.push({ to: a.toStation, color: a.color });
        index.set(a.fromStation, list);
    }

    return index;
};

/**
 * check every base post move the opponent could make, and prejudice
 * highly against letting them land on a station you control — a base post
 * takes the high point, so it would capture the station.
 *
 * Counts stations whose high point is `color`'s that some opponent could
 * relocate onto next turn. Higher is worse.
 */
export const baseThreatsAgainst = (state: FinityGameState, color: PlayerColor): number => {
    const arrows = outArrowIndex(state);
    const opponents = state.config.playerColors.filter((c) => c !== color && !state.winners.includes(c));
    let n = 0;
    for (const [name, st] of Object.entries(state.board.stations) as [StationName, typeof state.board.stations[StationName]][]) {
        if (stationControlledBy(st) !== color) continue;
        if (opponents.some((o) => canRelocateBasePost(state, o, name, arrows))) n++;
    }

    return n;
};

/**
 * The same threat in the other direction: base post moves as a form of
 * attack. Counts opponent-controlled stations `color` could relocate onto.
 */
export const baseThreatsBy = (state: FinityGameState, color: PlayerColor): number => {
    const arrows = outArrowIndex(state);
    let n = 0;
    for (const [name, st] of Object.entries(state.board.stations) as [StationName, typeof state.board.stations[StationName]][]) {
        const owner = stationControlledBy(st);
        if (!owner || owner === color) continue;
        if (canRelocateBasePost(state, color, name, arrows)) n++;
    }

    return n;
};
export interface EvalWeights {
    longestBridgePath: number;
    longestSupportedPath: number;
    reachableStationCount: number;
    controlledStationCount: number;
    stationPairStrength: number;
    orphanVulnerability: number; // if negative, vulnerability is bad
    closedChannels: number;
    channelRedundancy: number;
    progress: number; // closeness to a complete path; rewards rings directly
    ringDeficit: number; // negative: rings still to place on the route
    ringsOnBoard: number; // rings on the board show who is winning
    ringSpread: number;  // rings across many stations are a threat
    baseThreatsAgainst: number; // stations the opponent's base post could capture
    baseThreatsBy: number; // stations your base post could capture
}

/** Starting weights — tune against self-play(later -> ML tuned on headless self-play) */
export const DEFAULT_WEIGHTS: EvalWeights = {
    longestBridgePath: 2.0,         // previous val: 1.0
    longestSupportedPath: 6.0,      // previous val: 3.0,
    reachableStationCount: 1.5,
    controlledStationCount: 2.0,
    stationPairStrength: 2.0,       // previous val: 1.0
    orphanVulnerability: -2.5,
    closedChannels: -2.0,           // previous val: -4.0
    channelRedundancy: 1.5,
    progress: 40.0,                // previous val: 20.0
    ringDeficit: -1.0,
    ringsOnBoard: 1.5,
    ringSpread: 1.0,
    baseThreatsAgainst: -6.0, // prejudice this highly
    baseThreatsBy: 1.5,
};

/**
 * One-sided positional score for `color` (higher = better for color).
 * For 2-player Minimax, the usual driver is `evaluate(state, me) -
 * evaluate(state, opponent)`; this keeps the term computation in one place.
 */
export const evaluate = (
    state: FinityGameState,
    color: PlayerColor,
    weights: EvalWeights = DEFAULT_WEIGHTS,
): number => {
    return (
        weights.longestBridgePath * longestBridgePath(state, color) +
        weights.longestSupportedPath * longestSupportedPath(state, color) +
        weights.reachableStationCount * reachableStationCount(state, color) +
        weights.controlledStationCount * controlledStationCount(state, color) +
        weights.stationPairStrength * stationPairStrength(state, color) +
        weights.orphanVulnerability * orphanVulnerability(state, color) +
        weights.closedChannels * closedChannels(state, color) +
        weights.channelRedundancy * channelRedundancy(state, color) +
        weights.progress * progress(state, color) +
        weights.ringDeficit * ringDeficit(state, color) +
        weights.ringsOnBoard * ringsOnBoard(state, color) +
        weights.ringSpread * ringSpread(state, color) +
        weights.baseThreatsAgainst * baseThreatsAgainst(state, color) +
        weights.baseThreatsBy + baseThreatsBy(state, color)
    );
}
