/**
 * Finity Game Engine — Path Analyzer
 *
 * Pure functions for generating, filtering, and analyzing paths
 * through the arrow network. Paths are sequences of station names
 * following the game's path pattern (the 8-cone b/w sequence).
 *
 * A "full path" is 9 stations long: base post → 8 arrow steps → center.
 * Intermediate stations can be visited multiple times if the player
 * has enough rings there. The center station can only be the final
 * destination, never passed through.
 *
 * Ported from path_analyzer.js as pure functions.
 */

import type {
    FinityGameState,
    PlayerColor,
    ArrowColor,
    StationName,
} from './types';

import { outArrows } from './engine';

// =============================================================
// Public API
// =============================================================

const FULL_PATH_LENGTH = 9; // base post + 8 steps

/**
 * Find the station where a player's base post is located.
 */
export function basePostStation(state: FinityGameState, color: PlayerColor): StationName | null {
    for (const [name, station] of Object.entries(state.board.stations)) {
        if (station.basePost === color) {
            return name as StationName;
        }
    }
    return null;
}

/**
 * Get all stations reachable by legal paths from the player's base post
 * (or from a specified starting station).
 */
export function reachableStations(
    state: FinityGameState,
    color: PlayerColor,
    fromStation?: StationName,
): Set<StationName> {
    const paths = legalPaths(state, color, fromStation);
    const stations = new Set<StationName>();
    for (const path of paths) {
        for (const station of path) {
            stations.add(station);
        }
    }
    return stations;
}

/**
 * Check if a player has a complete winning path
 * (9 stations, ending at center).
 */
export function hasFullPath(state: FinityGameState, color: PlayerColor): boolean {
    const paths = legalPaths(state, color);
    return paths.some(
        path => path.length === FULL_PATH_LENGTH && path[path.length - 1] === 'C',
    );
}

/**
 * Get all legal paths from the player's base post (or a specified station).
 * Legal paths follow the path pattern AND have enough rings on intermediate stations.
 */
export function legalPaths(
    state: FinityGameState,
    color: PlayerColor,
    fromStation?: StationName,
): StationName[][] {
    const raw = rawPaths(state, color, fromStation);
    return raw.filter(path => hasEnoughRings(state, color, path));
}

/**
 * Get the length of the longest legal path from the player's base post.
 * This is a key evaluation metric for AI agents.
 */
export function longestLegalPathLength(state: FinityGameState, color: PlayerColor): number {
    const paths = legalPaths(state, color);
    if (paths.length === 0) return 0;
    return Math.max(...paths.map(p => p.length));
}

/**
 * Get the longest legal path that is also ring-supported.
 * "Supported" means every intermediate station has the player's rings.
 */
export function longestSupportedPathLength(state: FinityGameState, color: PlayerColor): number {
    const paths = legalPaths(state, color);
    if (paths.length === 0) return 0;
    return Math.max(...paths.map(p => p.length));
}

/**
 * Count reachable stations from the player's base post.
 */
export function reachableStationCount(state: FinityGameState, color: PlayerColor): number {
    return reachableStations(state, color).size;
}

// =============================================================
// Internal: Path Generation
// =============================================================

/**
 * Generate all raw paths following the path pattern (arrow colors only,
 * no ring support check). Starts from the player's base post or a
 * specified station.
 */
export function rawPaths(
    state: FinityGameState,
    color: PlayerColor,
    fromStation?: StationName,
): StationName[][] {
    const start = fromStation ?? basePostStation(state, color);
    if (!start) return [];

    const initialPath: StationName[] = [start];
    return generateRawPaths(state, [initialPath], [...state.pathPattern]);
}

/**
 * Recursively generate paths by following arrows matching the path pattern.
 *
 * This is the core algorithm ported from path_analyzer.js.
 * At each step, for each path that's at the correct length for this step,
 * find all outgoing arrows matching the current pattern color and branch.
 *
 * Note: This mutates the possiblePaths array by pushing new paths during
 * iteration (same approach as the original). Paths created in this step
 * won't be extended again because their length won't match the check
 * for subsequent pattern positions.
 */
function generateRawPaths(
    state: FinityGameState,
    possiblePaths: StationName[][],
    remainingPattern: ArrowColor[],
): StationName[][] {
    if (remainingPattern.length === 0) {
        return possiblePaths;
    }

    const currentPatternColor = remainingPattern[0];
    const expectedLength = FULL_PATH_LENGTH - remainingPattern.length;
    // Only extend paths that are at the right step
    // (expectedLength = 1 for first pattern step, 2 for second, etc.)

    const activeStations = Object.keys(state.board.stations) as StationName[];
    const pathCount = possiblePaths.length; // snapshot length before pushing

    for (let i = 0; i < pathCount; i++) {
        const path = possiblePaths[i];
        if (path.length !== expectedLength) continue;

        const lastStation = path[path.length - 1];
        const matchingArrows = outArrows(state, lastStation, currentPatternColor);

        for (const arrow of matchingArrows) {
            const dest = arrow.toStation;

            // Center can only be the FINAL destination (last pattern step)
            if (dest === 'C' && remainingPattern.length !== 1) continue;

            // Station must be active on this board
            if (!activeStations.includes(dest)) continue;

            const newPath = [...path, dest];
            possiblePaths.push(newPath);
        }
    }

    return generateRawPaths(state, possiblePaths, remainingPattern.slice(1));
}

// =============================================================
// Internal: Path Validation
// =============================================================

/**
 * Check if a path has enough rings on intermediate stations.
 *
 * For each intermediate station (not the first and not the last),
 * count how many times it's visited. The player must have at least
 * that many rings on the station.
 *
 * The first station (base post) and last station don't require rings.
 */
function hasEnoughRings(
    state: FinityGameState,
    color: PlayerColor,
    path: StationName[],
): boolean {
    if (path.length < 3) return true; // no intermediate stations

    // Count visits to each intermediate station
    const visits: Record<string, number> = {};
    const intermediateStations = path.slice(1, -1); // exclude first and last

    for (const station of intermediateStations) {
        visits[station] = (visits[station] ?? 0) + 1;
    }

    // Check ring support for each visited station
    for (const [stationName, visitCount] of Object.entries(visits)) {
        const station = state.board.stations[stationName as StationName];
        if (!station) return false;

        const playerRings = station.rings.filter(
            r => r !== null && r.color === color,
        ).length;

        if (playerRings < visitCount) return false;
    }

    return true;
}
