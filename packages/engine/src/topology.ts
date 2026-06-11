/**
 * Finity Game Engine — Board Topology
 *
 * Static, precomputed board data. No rendering, no pixel positions.
 * All data here is immutable after construction.
 *
 * Three naming systems for stations:
 *   Coordinate: "-1,0" (internal math)
 *   Compass:    "NW"   (human-facing)
 *   Numeric:    6      (ring-ordered, compact)
 */

import type {
    StationName,
    StationCoord,
    StationNumber,
    Channel,
    BoardTopology,
} from './types';

// =============================================================
// Station Naming — Bidirectional Mappings
// =============================================================

/** Coordinate → Compass name */
export const COORD_TO_NAME: Record<StationCoord, StationName> = {
    '0,0': 'C',
    '-1,1': 'N',
    '0,1': 'NE',
    '1,0': 'SE',
    '1,-1': 'S',
    '0,-1': 'SW',
    '-1,0': 'NW',
    '-1,-1': 'W',
    '1,1': 'E',
    '-2,1': 'FNW',
    '-1,2': 'FNE',
    '2,-1': 'FSE',
    '1,-2': 'FSW',
};

/** Compass name → Coordinate */
export const NAME_TO_COORD: Record<StationName, StationCoord> = Object.fromEntries(
    Object.entries(COORD_TO_NAME).map(([k, v]) => [v, k])
) as Record<StationName, StationCoord>;

/** Compass name → Numeric ID (ring-ordered) */
export const NAME_TO_NUMBER: Record<StationName, StationNumber> = {
    C: 0, N: 1, NE: 2, SE: 3, S: 4, SW: 5, NW: 6,
    FNW: 7, FNE: 8, E: 9, FSE: 10, FSW: 11, W: 12,
};

/** Numeric ID → Compass name */
export const NUMBER_TO_NAME: Record<StationNumber, StationName> = Object.fromEntries(
    Object.entries(NAME_TO_NUMBER).map(([k, v]) => [v, k])
) as Record<StationNumber, StationName>;

/** Convert any station identifier to compass name */
export function toStationName(id: StationCoord | StationName | StationNumber): StationName {
    if (typeof id === 'number') return NUMBER_TO_NAME[id as StationNumber];
    if (id in COORD_TO_NAME) return COORD_TO_NAME[id as StationCoord];
    return id as StationName; // already a compass name
}

/** Convert compass name to coordinate */
export function toCoord(name: StationName): StationCoord {
    return NAME_TO_COORD[name];
}

// =============================================================
// Board Configurations Per Player Count
// =============================================================

/** Which stations exist for each player count (always includes Center) */
export const STATIONS_BY_PLAYER_COUNT: Record<number, StationName[]> = {
    2: ['C', 'N', 'NE', 'SE', 'S', 'SW', 'NW', 'W', 'E'],
    3: ['C', 'N', 'NE', 'SE', 'S', 'SW', 'NW', 'FNW', 'FSW'],
    4: ['C', 'N', 'NE', 'SE', 'S', 'SW', 'NW', 'W', 'E', 'FNW', 'FNE', 'FSE', 'FSW'],
};

/** Starting stations per player count (order matches player color assignment) */
export const START_STATIONS: Record<number, StationName[]> = {
    2: ['N', 'S'],
    3: ['NW', 'NE', 'S'],
    4: ['NW', 'NE', 'SE', 'SW'],
};

// =============================================================
// Slot Topology — 72 Slots
// =============================================================

/**
 * BGA channel mapping: "Right", "Left", "Middle" → 'R', 'L', 'C'
 *
 * The channel is defined relative to the from→to direction.
 * When viewed from fromStation looking toward toStation:
 *   L = left side, C = center, R = right side
 *
 * Slots between two stations are shared — the L channel from A→B
 * is the R channel from B→A (they're the same physical slot).
 */

/**
 * Station-pair to slot index mapping.
 * This is the core topology data extracted from slots.js.
 *
 * Format: STATION_SLOTS[fromStation][toStation] = { L: slotId, C: slotId, R: slotId }
 *
 * Note: the same physical slot appears in both directions with swapped L/R.
 * e.g., STATION_SLOTS['C']['N'].L === STATION_SLOTS['N']['C'].R (slot 0)
 */
export const STATION_SLOTS: Record<StationName, Partial<Record<StationName, Record<Channel, number>>>> = {
    // Center station — connects to all 6 inner ring stations
    C: {
        N: { L: 0, C: 1, R: 2 },
        NE: { L: 3, C: 4, R: 5 },
        SE: { L: 6, C: 7, R: 8 },
        S: { L: 9, C: 10, R: 11 },
        SW: { L: 12, C: 13, R: 14 },
        NW: { L: 15, C: 16, R: 17 },
    },

    // Inner ring — each connects to center, two inner neighbors, and up to two outer stations
    NW: {
        FNW: { L: 69, C: 70, R: 71 },
        N: { L: 20, C: 19, R: 18 },
        C: { L: 17, C: 16, R: 15 },
        SW: { L: 63, C: 64, R: 65 },
        W: { L: 66, C: 67, R: 68 },
    },

    N: {
        FNE: { L: 24, C: 25, R: 26 },
        NE: { L: 29, C: 28, R: 27 },
        C: { L: 2, C: 1, R: 0 },
        NW: { L: 18, C: 19, R: 20 },
        FNW: { L: 21, C: 22, R: 23 },
    },

    NE: {
        E: { L: 33, C: 34, R: 35 },
        SE: { L: 38, C: 37, R: 36 },
        C: { L: 5, C: 4, R: 3 },
        N: { L: 27, C: 28, R: 29 },
        FNE: { L: 30, C: 31, R: 32 },
    },

    SE: {
        FSE: { L: 42, C: 43, R: 44 },
        S: { L: 47, C: 46, R: 45 },
        C: { L: 8, C: 7, R: 6 },
        NE: { L: 36, C: 37, R: 38 },
        E: { L: 39, C: 40, R: 41 },
    },

    S: {
        FSW: { L: 51, C: 52, R: 53 },
        SW: { L: 56, C: 55, R: 54 },
        C: { L: 11, C: 10, R: 9 },
        SE: { L: 45, C: 46, R: 47 },
        FSE: { L: 48, C: 49, R: 50 },
    },

    SW: {
        W: { L: 60, C: 61, R: 62 },
        NW: { L: 65, C: 64, R: 63 },
        C: { L: 14, C: 13, R: 12 },
        S: { L: 54, C: 55, R: 56 },
        FSW: { L: 57, C: 58, R: 59 },
    },

    // Outer ring stations — each connects to exactly 2 inner ring stations
    W: { NW: { L: 68, C: 67, R: 66 }, SW: { L: 62, C: 61, R: 60 } },
    E: { SE: { L: 41, C: 40, R: 39 }, NE: { L: 35, C: 34, R: 33 } },
    FNW: { N: { L: 23, C: 22, R: 21 }, NW: { L: 71, C: 70, R: 69 } },
    FNE: { NE: { L: 32, C: 31, R: 30 }, N: { L: 26, C: 25, R: 24 } },
    FSE: { S: { L: 50, C: 49, R: 48 }, SE: { L: 44, C: 43, R: 42 } },
    FSW: { SW: { L: 59, C: 58, R: 57 }, S: { L: 53, C: 52, R: 51 } },
};

// =============================================================
// Slot Interference Rules
// =============================================================

/**
 * When an arrow occupies a slot, it blocks (interferes with) certain
 * adjacent slots. This prevents two arrows from occupying slots that
 * would physically overlap on the board.
 *
 * Only outer channels (L and R) cause interference.
 * Center channels (C) never interfere with anything.
 *
 * The rule: The R channel of one station pair interferes with the L
 * channel of the clockwise-adjacent pair around the shared station.
 *
 * Extracted from slots.js set_up_slot_relations()
 */
export const SLOT_INTERFERENCES: Record<number, number[]> = {
    // Around Center
    0: [17, 18],  // C-N:L ↔ C-NW:R, NW-N:R
    2: [3, 27],   // C-N:R ↔ C-NE:L, N-NE:R
    3: [2, 27],   // C-NE:L ↔ C-N:R, N-NE:R
    5: [6, 36],   // C-NE:R ↔ C-SE:L, NE-SE:R
    6: [5, 36],   // C-SE:L ↔ C-NE:R, NE-SE:R
    8: [9, 45],   // C-SE:R ↔ C-S:L, SE-S:R
    9: [8, 45],   // C-S:L ↔ C-SE:R, SE-S:R
    11: [12, 54],  // C-S:R ↔ C-SW:L, S-SW:R
    12: [11, 54],  // C-SW:L ↔ C-S:R, S-SW:R
    14: [15, 63],  // C-SW:R ↔ C-NW:L, SW-NW:R
    15: [14, 63],  // C-NW:L ↔ C-SW:R, SW-NW:R
    17: [18, 0],   // C-NW:R ↔ NW-N:R, C-N:L
    18: [17, 0],   // NW-N:R ↔ C-NW:R, C-N:L

    // Around inner ring stations
    20: [21, 71],  // NW-N:L ↔ FNW-N:R, FNW-NW:R
    21: [20, 71],  // FNW-N:R ↔ NW-N:L, FNW-NW:R
    26: [29, 30],  // FNE-N:R ↔ N-NE:L, FNE-NE:L
    27: [2, 3],    // N-NE:R ↔ C-N:R, C-NE:L
    29: [26, 30],  // N-NE:L ↔ FNE-N:R, FNE-NE:L
    30: [26, 29],  // FNE-NE:L ↔ FNE-N:R, N-NE:L
    35: [38, 39],  // E-NE:R ↔ NE-SE:L, E-SE:L
    36: [5, 6],    // NE-SE:R ↔ C-NE:R, C-SE:L
    38: [35, 39],  // NE-SE:L ↔ E-NE:R, E-SE:L
    39: [35, 38],  // E-SE:L ↔ E-NE:R, NE-SE:L
    44: [47, 48],  // FSE-SE:R ↔ SE-S:L, FSE-S:L
    45: [8, 9],    // SE-S:R ↔ C-SE:R, C-S:L
    47: [44, 48],  // SE-S:L ↔ FSE-SE:R, FSE-S:L
    48: [44, 47],  // FSE-S:L ↔ FSE-SE:R, SE-S:L
    53: [56, 57],  // FSW-S:R ↔ S-SW:L, FSW-SW:L
    54: [11, 12],  // S-SW:R ↔ C-S:R, C-SW:L
    56: [53, 57],  // S-SW:L ↔ FSW-S:R, FSW-SW:L
    57: [53, 56],  // FSW-SW:L ↔ FSW-S:R, S-SW:L
    62: [65, 66],  // W-SW:R ↔ SW-NW:L, W-NW:L
    63: [14, 15],  // SW-NW:R ↔ C-SW:R, C-NW:L
    65: [62, 66],  // SW-NW:L ↔ W-SW:R, W-NW:L
    66: [62, 65],  // W-NW:L ↔ W-SW:R, SW-NW:L
    71: [20, 21],  // FNW-NW:R ↔ NW-N:L, FNW-N:R
};

/**
 * Slot neighbor groups — slots in the same triplet (between the same two stations).
 * Extracted from slots.js set_up_slot_relations().
 */
export const SLOT_NEIGHBORS: number[][] = Array.from({ length: 24 }, (_, i) => {
    const base = i * 3;
    return [
        [base + 1, base + 2],     // slot 0 of triplet
        [base, base + 2],         // slot 1 of triplet
        [base, base + 1],         // slot 2 of triplet
    ];
}).flat();

/**
 * Get the interference list for a slot (empty array if no interferences)
 */
export function getSlotInterferences(slotId: number): number[] {
    return SLOT_INTERFERENCES[slotId] ?? [];
}

/**
 * Get the neighbor slots (same station-pair triplet)
 */
export function getSlotNeighbors(slotId: number): number[] {
    return SLOT_NEIGHBORS[slotId] ?? [];
}

// =============================================================
// Slot-Station Mapping
// =============================================================

/**
 * For each slot, which two stations does it connect?
 * Built from STATION_SLOTS at module load time.
 */
export const SLOT_TO_STATIONS: [StationName, StationName][] = buildSlotStationMap();

function buildSlotStationMap(): [StationName, StationName][] {
    const result: [StationName, StationName][] = new Array(72);
    const seen = new Set<number>();

    for (const [from, neighbors] of Object.entries(STATION_SLOTS)) {
        for (const [to, channels] of Object.entries(neighbors as Record<StationName, Record<Channel, number>>)) {
            for (const slotId of Object.values(channels)) {
                if (!seen.has(slotId)) {
                    result[slotId] = [from as StationName, to as StationName];
                    seen.add(slotId);
                }
            }
        }
    }

    return result;
}

// =============================================================
// Topology Builder
// =============================================================

/**
 * Build the complete topology for a given player count.
 * This is called once per game setup and the result is immutable.
 */
export function buildTopology(playerCount: 2 | 3 | 4): BoardTopology {
    const stations = STATIONS_BY_PLAYER_COUNT[playerCount];
    const startStations = START_STATIONS[playerCount];

    // Filter station slots to only include active stations
    const stationSlotMapping: BoardTopology['stationSlotMapping'] = {} as any;
    for (const station of stations) {
        const neighbors = STATION_SLOTS[station];
        if (neighbors) {
            const filtered: Partial<Record<StationName, Partial<Record<Channel, number>>>> = {};
            for (const [neighbor, channels] of Object.entries(neighbors)) {
                if (stations.includes(neighbor as StationName)) {
                    filtered[neighbor as StationName] = channels as Partial<Record<Channel, number>>;
                }
            }
            stationSlotMapping[station] = filtered as Record<StationName, Partial<Record<Channel, number>>>;
        }
    }

    // Collect active slot IDs
    const activeSlots = new Set<number>();
    for (const neighbors of Object.values(stationSlotMapping)) {
        for (const channels of Object.values(neighbors)) {
            for (const slotId of Object.values(channels as Record<string, number>)) {
                activeSlots.add(slotId);
            }
        }
    }

    // Build interference and neighbor maps for active slots
    const slotInterferences: number[][] = new Array(72).fill(null).map((_, i) =>
        activeSlots.has(i) ? (SLOT_INTERFERENCES[i] ?? []).filter(s => activeSlots.has(s)) : []
    );

    const slotNeighbors: number[][] = new Array(72).fill(null).map((_, i) =>
        activeSlots.has(i) ? SLOT_NEIGHBORS[i].filter(s => activeSlots.has(s)) : []
    );

    const slotStations = SLOT_TO_STATIONS;

    return {
        stations,
        startStations,
        stationSlotMapping,
        slotInterferences,
        slotNeighbors,
        slotStations,
    };
}
