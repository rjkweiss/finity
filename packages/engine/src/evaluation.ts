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

import type { FinityGameState, PlayerColor } from "./types";
import { getAllArrows, occupiesHighPoint, stationControlledBy } from "./engine";
import { analyzePaths, orphanExposure, reachableStationCount } from "./path-analyzer";

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
export interface EvalWeights {
    longestBridgePath: number;
    longestSupportedPath: number;
    reachableStationCount: number;
    controlledStationCount: number;
    stationPairStrength: number;
    orphanVulnerability: number; // if negative, vulnerability is bad
}

/** Starting weights — tune against self-play(later -> ML tuned on headless self-play) */
export const DEFAULT_WEIGHTS: EvalWeights = {
    longestBridgePath: 1.0,
    longestSupportedPath: 3.0,
    reachableStationCount: 1.5,
    controlledStationCount: 2.0,
    stationPairStrength: 1.0,
    orphanVulnerability: -2.5,
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
        weights.orphanVulnerability * orphanVulnerability(state, color)
    );
}
