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
 */

import type {
    FinityGameState,
    PlayerColor,
    ArrowState,
    StationName,
} from './types';


// =============================================================
// Public API
// =============================================================

const FULL_PATH_LENGTH = 9; // base post + 8 steps
const WORDS = 3; // 72 slots -> 3 x 32-bit words

// =============================================================
// Slot bitsets - used to track which bridges a path traverses
// =============================================================
type SlotSet = Uint32Array;
const EMPTY_SET: SlotSet = new Uint32Array(WORDS);

const setWith = (base: SlotSet, slotId: number): SlotSet => {
    const out = new Uint32Array(base);
    out[slotId >>> 5] |= 1 << (slotId & 31);

    return out;
};

/** In-place intersection: a &= b */
const intersectInto = (a: SlotSet, b: SlotSet): void => {
    for (let i = 0; i < WORDS; i++) a[i] &= b[i];
};

const isEmptySet = (a: SlotSet): boolean => {
    for (let i = 0; i < WORDS; i++) if (a[i] !== 0) return false;

    return true;
};

// =============================================================
// Public analysis types
// =============================================================

/** One path, plus the set of bridges it traverses */
export interface PathRecord {
    readonly stations: StationName[];
    readonly arrows: SlotSet;
}

export interface PathBundle {
    readonly all: PathRecord[]; // every path of every length, including length-1 path [start]
    readonly legal: PathRecord[]; // those from all that satisfy ring support on intermediate stations
    readonly reachable: Set<StationName>; // union of stations over legal
    readonly longest: number; // longest legal path, measured in stations (not crossings)
    readonly hasFull: boolean; // A legal 9-station path terminating at center exists
    readonly fullDistinct: number; // distinct stations on the best legal full path, 0 if none
}

// =============================================================
// Cache
// =============================================================
interface CacheEntry {
    bundle: PathBundle;
    stamp: string; // position hash the bundle was computed under
    exposure?: number; // lazily filled by orphanExposure
}

const CACHE = new WeakMap<FinityGameState, Map<string, CacheEntry>>();

/**
 * During mutation `next.zobristHash` still holds the pre-move value,
 * so anything cached mid-flight is stamped with the OLD hash;
 * applyMove refreshes zobristHash as its final act,
 * so every stale entry misses on the next read and is rebuilt.
 */
const cacheEntry = (
    state: FinityGameState,
    color: PlayerColor,
    from: StationName | null
): CacheEntry => {
    let byKey = CACHE.get(state);
    if (!byKey) {
        byKey = new Map();
        CACHE.set(state, byKey);
    }

    const key = `${color}|${from ?? ''}`;
    const existing = byKey.get(key);
    if (existing && existing.stamp === state.zobristHash) return existing;

    const entry: CacheEntry = {
        bundle: buildBundle(state, color, from),
        stamp: state.zobristHash,
    };
    byKey.set(key, entry);

    return entry;
};

/** Drop every cache bundle for one state object ->
 * called at end of applyMove, after  ZobristHash refresh
 */
export const invalidatePathCache = (state: FinityGameState): void => {
    CACHE.delete(state);
};

// =============================================================
// Core enumeration
// =============================================================
/**
 * Full path analysis for `color`, starting from `fromStation` or the player's base post.
 * Cached per state object.
 */
export const analyzePaths = (
    state: FinityGameState,
    color: PlayerColor,
    fromStation?: StationName
): PathBundle => {
    const start = fromStation ?? basePostStation(state, color);
    return cacheEntry(state, color, start).bundle;
};

const emptyBundle = (): PathBundle => {
    return { all: [], legal: [], reachable: new Set(), longest: 0, hasFull: false, fullDistinct: 0 };
};

const buildBundle = (
    state: FinityGameState,
    color: PlayerColor,
    start: StationName | null
): PathBundle => {
    if (!start) return emptyBundle();

    const active = new Set(Object.keys(state.board.stations) as StationName[]);
    if (!active.has(start)) return emptyBundle();

    // index outgoing arrows per station per color once rather than rescanning STATION_SLOTS on every path extension
    const outIndex = buildOutIndex(state);

    const root: PathRecord = { stations: [start], arrows: EMPTY_SET };
    const all: PathRecord[] = [root];
    let frontier: PathRecord[] = [root];

    const pattern = state.pathPattern;
    for (let step = 0; step < pattern.length && frontier.length > 0; step++) {
        const want = pattern[step];
        const isLastStep = step === pattern.length - 1;
        const next: PathRecord[] = [];

        for (const path of frontier) {
            const tail = path.stations[path.stations.length - 1];
            const outgoing = outIndex.get(`${tail}|${want}`);
            if (!outgoing) continue;

            for (const arrow of outgoing) {
                const dest = arrow.toStation;

                // center may only ever be a path's final destination
                if (dest === 'C' && !isLastStep) continue;
                if (!active.has(dest)) continue;

                const rec: PathRecord = {
                    stations: [...path.stations, dest],
                    arrows: setWith(path.arrows, arrow.slotId),
                };
                next.push(rec);
                all.push(rec);
            }
        }

        frontier = next;
    }

    // Ring-supported filter, plus the derived summaries
    const legal: PathRecord[] = [];
    const reachable = new Set<StationName>();
    let longest = 0;
    let hasFull = false;
    let fullDistinct = 0;

    for (const path of all) {
        if (!hasEnoughRings(state, color, path.stations)) continue;
        legal.push(path);
        for (const s of path.stations) reachable.add(s);
        if (path.stations.length > longest) longest = path.stations.length;
        if (path.stations.length === FULL_PATH_LENGTH && path.stations[path.stations.length - 1] === 'C') {
            hasFull = true;

            // track distinct stations per paths for simultaneous completion tiebreak ranks on
            const distinct = new Set(path.stations).size;
            if (distinct > fullDistinct) fullDistinct = distinct;
        }
    }

    return { all, legal, reachable, longest, hasFull, fullDistinct };
};

/** station|arrowColor -> outgoing arrows */
const buildOutIndex = (state: FinityGameState): Map<string, ArrowState[]> => {
    const index = new Map<string, ArrowState[]>();
    for (const slot of state.board.slots) {
        const piece = slot.contains;
        if (!piece || piece.type !== 'arrow') continue;
        const key = `${piece.fromStation}|${piece.color}`;
        const list = index.get(key);
        if (list) list.push(piece);
        else index.set(key, [piece]);
    }

    return index;
};

/**
 * A path is ring-supported when every INTERMEDIATE station carries at least as
 * many of the player's rings as the number of times the path visits it. The
 * first station (base post) and the final station are exempt.
 */

const hasEnoughRings = (state: FinityGameState, color: PlayerColor, path: StationName[]): boolean => {
    if (path.length < 3) return true;

    const visits: Record<string, number> = {};
    for (let i = 1; i < path.length - 1; i++) {
        visits[path[i]] = (visits[path[i]] ?? 0) + 1;
    }

    for (const stationName of Object.keys(visits)) {
        const station = state.board.stations[stationName as StationName];
        if (!station) return false;
        let owned = 0;
        for (const ring of station.rings) if (ring && ring.color === color) owned++;
        if (owned < visits[stationName]) return false;
    }

    return true;
};

// =============================================================
// Public API
// =============================================================

/**
 * Find the station where a player's base post is located.
 */
export const basePostStation = (
    state: FinityGameState,
    color: PlayerColor
): StationName | null => {
    for (const [name, station] of Object.entries(state.board.stations)) {
        if (station.basePost === color) {
            return name as StationName;
        }
    }

    return null;
};

/**
 * Get all stations reachable by legal paths from the player's base post
 * (or from a specified starting station).
 */
export const reachableStations = (
    state: FinityGameState,
    color: PlayerColor,
    fromStation?: StationName,
): Set<StationName> => {
    return analyzePaths(state, color, fromStation).reachable;
}

/**
 * Check if a player has a complete winning path
 * (9 stations, ending at center).
 */
export const hasFullPath = (
    state: FinityGameState,
    color: PlayerColor
): boolean => {
    return analyzePaths(state, color).hasFull;
}

/**
 * Distinct stations covered by the player's best legal full path, or 0 if they have none.
 * Used only to rank players who complete on the same turn
 */
export const fullPathStationCount = (
    state: FinityGameState,
    color: PlayerColor
): number => {
    return analyzePaths(state, color).fullDistinct;
};

/**
 * Get all legal paths from the player's base post (or a specified station).
 * Legal paths follow the path pattern AND have enough rings on intermediate stations.
 */
export const legalPaths = (
    state: FinityGameState,
    color: PlayerColor,
    fromStation?: StationName,
): StationName[][] => {
    return analyzePaths(state, color, fromStation).legal.map((p) => p.stations);
}

export const rawPaths = (
    state: FinityGameState,
    color: PlayerColor,
    fromStation?: StationName
): StationName[][] => {
    return analyzePaths(state, color, fromStation).all.map((p) => p.stations);
};

/**
 * Get the length of the longest legal path from the player's base post.
 * This is a key evaluation metric for AI agents.
 */
export const longestLegalPathLength = (
    state: FinityGameState,
    color: PlayerColor
): number => {
    return analyzePaths(state, color).longest;
}

/**
 * @deprecated -- to delete once all imports are updated
 * Get the longest legal path that is also ring-supported.
 * "Supported" means every intermediate station has the player's rings.
 */
export const longestSupportedPathLength = (
    state: FinityGameState,
    color: PlayerColor
): number => {
    return analyzePaths(state, color).longest;
}

/**
 * Count reachable stations from the player's base post.
 */
export const reachableStationCount = (
    state: FinityGameState,
    color: PlayerColor
): number => {
    return analyzePaths(state, color).reachable.size;
}

/**
 * Longest legal path measured in Bridge crossings. Used by anti-kingmaker check
 */
export const longestPathCrossings = (
    state: FinityGameState,
    color: PlayerColor
): number => {
    const longest = analyzePaths(state, color).longest;
    return longest > 0 ? longest - 1: 0;
};

// =============================================================
// Orphan exposure — replaces the clone-per-arrow probe loop
// =============================================================

export const orphanExposure = (
    state: FinityGameState,
    color: PlayerColor
): number => {
    const base = basePostStation(state, color);
    if (!base) return 0;

    const entry = cacheEntry(state, color, base);
    if (entry.exposure !== undefined) return entry.exposure;

    const { legal, reachable } = entry.bundle;

    // stations holding this color's rings. The base-post station and the center are never orphaned, matching clearOrphans
    const ringStations: StationName[] = [];
    for (const [name, station] of Object.entries(state.board.stations)) {
        if (name === base || name === 'C') continue;
        if (!reachable.has(name as StationName)) continue;
        if(station.rings.some((r) => r !== null && r.color === color)) {
            ringStations.push(name as StationName);
        }
    }

    if (ringStations.length === 0) {
        entry.exposure = 0;
        return 0;
    }

    // running intersection of traversed bridge sets per candidate station
    const cut = new Map<StationName, SlotSet | null>();
    const watch = new Set(ringStations);

    for (const path of legal) {
        // A station appearing twice in one path still intersects once
        let seen: Set<StationName> | null = null;
        for (const s of path.stations) {
            if (!watch.has(s)) continue;
            if (seen === null) seen = new Set();
            if (seen.has(s)) continue;
            seen.add(s);

            const current = cut.get(s);
            if (current === undefined) {
                cut.set(s, new Uint32Array(path.arrows));
            } else if (current !== null) {
                intersectInto(current, path.arrows);
                if (isEmptySet(current)) cut.set(s, null);
            }
        }
    }

    let exposed = 0;
    for (const s of ringStations) {
        const c = cut.get(s);
        if (c && !isEmptySet(c)) exposed++;
    }

    entry.exposure = exposed;
    return exposed;
};
