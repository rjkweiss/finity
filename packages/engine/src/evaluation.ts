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
 *
 * NOTE ON IMPORTS: a couple of path-analyzer export names below are from our
 * prior build (legalPaths, rawPaths, reachableStations, basePostStation). If a
 * name differs in pathAnalyzer.ts, adjust the import — the logic is unaffected.
 */

import type { FinityGameState, PlayerColor, StationName, StationNumber } from "./types";
import { getAllArrows, occupiesHighPoint, stationControlledBy } from "./engine";
import { basePostStation, reachableStations, legalPaths, rawPaths } from "./path-analyzer";

// =============================================================
// 1. Longest bridge path (offense)
// =============================================================

/**
 * Longest path through the arrow/bridge network from the base post, ignoring
 * ring support. Measures raw reach of the arrow structure you can travel.
 */
export function longestBridgePath(state: FinityGameState, color: PlayerColor): number {
    const paths = rawPaths(state, color);
    if (paths.length === 0) return 0;

    return Math.max(...paths.map(path => path.length));
}

// =============================================================
// 2. Longest supported path (offense)
// =============================================================

/**
 * Longest legal (ring-supported) path from the base post. This is the metric
 * closest to "progress toward victory" since a full path must be supported.
 */
export function longestSupportedPath(state: FinityGameState, color: PlayerColor): number {
    const paths = legalPaths(state, color);
    if (paths.length === 0) return 0;

    return Math.max(...paths.map(path => path.length));
}

// =============================================================
// 3. Reachable station count (offense)
// =============================================================

/** How many distinct stations the color can reach via legal paths. */
export function reachableStationCount(state: FinityGameState, color: PlayerColor): number {
    return reachableStations(state, color).size;
}

// =============================================================
// 4. Controlled station count (offense)
// =============================================================

/** How many stations the color holds the high point on (base post or topmost ring). */
export function controlledStationCount(state: FinityGameState, color: PlayerColor): number {
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
export function stationPairStrength(state: FinityGameState, color: PlayerColor): number {
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
 * Cost: O(arrows) reachability recomputations. Fine for leaf evaluation at
 * typical board sizes; memoize per state if profiling flags it.
 */
export function orphanVulnerability(state: FinityGameState, color: PlayerColor): number {
    const base = basePostStation(state, color);
    if(!base) return 0;

    // Stations where this color currently has rings (anchored stations exempt,
    // matching clearOrphans: base-post station and center are never orphaned).
    const ringStations: StationName[] = [];
    for (const [name, station] of Object.entries(state.board.stations)) {
        if (name === base || name === 'C') continue;
        if (station.rings.some(ring => ring?.color === color)) {
            ringStations.push(name as StationName);
        }
    }
    if (ringStations.length === 0) return 0;

    const supportedNow = reachableStations(state, color);
    const exposed = new Set<StationName>();
    for (const arrow of getAllArrows(state)) {
        // probe: remove just this arrow. Path traversal reads placed arrows and
        // ring support only, so nulling the slot's contents is sufficient - no
        // need to recompute interferance here
        const probe = structuredClone(state) as FinityGameState;
        probe.board.slots[arrow.slotId].contains = null;

        const supportedAfter = reachableStations(probe, color);
        for (const station of ringStations) {
            if (supportedNow.has(station) && !supportedAfter.has(station)) {
                exposed.add(station);
            }
        }
    }

    return exposed.size;
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

/** Starting weights — tune against self-play / the BGA game data once parsers land. */
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
export function evaluate(
    state: FinityGameState,
    color: PlayerColor,
    weights: EvalWeights = DEFAULT_WEIGHTS,
): number {
    return (
        weights.longestBridgePath * longestBridgePath(state, color) +
        weights.longestSupportedPath * longestSupportedPath(state, color) +
        weights.reachableStationCount * reachableStationCount(state, color) +
        weights.controlledStationCount * controlledStationCount(state, color) +
        weights.stationPairStrength * stationPairStrength(state, color) +
        weights.orphanVulnerability * orphanVulnerability(state, color)
    );
}
