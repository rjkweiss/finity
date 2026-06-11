import { describe, it, expect } from 'vitest';
import {
  COORD_TO_NAME,
  NAME_TO_COORD,
  NAME_TO_NUMBER,
  NUMBER_TO_NAME,
  toStationName,
  toCoord,
  STATIONS_BY_PLAYER_COUNT,
  START_STATIONS,
  STATION_SLOTS,
  SLOT_INTERFERENCES,
  SLOT_NEIGHBORS,
  SLOT_TO_STATIONS,
  getSlotInterferences,
  getSlotNeighbors,
  buildTopology,
} from '../src/topology';
import type { StationName } from '../src/types';

// =============================================================
// Station Naming
// =============================================================

describe('Station naming mappings', () => {
  it('COORD_TO_NAME covers all 13 stations', () => {
    expect(Object.keys(COORD_TO_NAME)).toHaveLength(13);
  });

  it('NAME_TO_COORD covers all 13 stations', () => {
    expect(Object.keys(NAME_TO_COORD)).toHaveLength(13);
  });

  it('COORD_TO_NAME and NAME_TO_COORD are exact inverses', () => {
    for (const [coord, name] of Object.entries(COORD_TO_NAME)) {
      expect(NAME_TO_COORD[name as StationName]).toBe(coord);
    }
    for (const [name, coord] of Object.entries(NAME_TO_COORD)) {
      expect(COORD_TO_NAME[coord]).toBe(name);
    }
  });

  it('NAME_TO_NUMBER and NUMBER_TO_NAME are exact inverses', () => {
    for (const [name, num] of Object.entries(NAME_TO_NUMBER)) {
      expect(NUMBER_TO_NAME[num as keyof typeof NUMBER_TO_NAME]).toBe(name);
    }
  });

  it('numeric IDs are 0-12 with no gaps', () => {
    const nums = Object.values(NAME_TO_NUMBER).sort((a, b) => a - b);
    expect(nums).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('center station is coord "0,0", name "C", number 0', () => {
    expect(COORD_TO_NAME['0,0']).toBe('C');
    expect(NAME_TO_COORD['C']).toBe('0,0');
    expect(NAME_TO_NUMBER['C']).toBe(0);
  });

  it('toStationName converts from all three systems', () => {
    // From coordinate
    expect(toStationName('-1,1')).toBe('N');
    expect(toStationName('0,0')).toBe('C');

    // From number
    expect(toStationName(0)).toBe('C');
    expect(toStationName(1)).toBe('N');
    expect(toStationName(6)).toBe('NW');

    // From name (passthrough)
    expect(toStationName('NE' as any)).toBe('NE');
  });

  it('toCoord converts compass name to coordinate', () => {
    expect(toCoord('C')).toBe('0,0');
    expect(toCoord('N')).toBe('-1,1');
    expect(toCoord('NW')).toBe('-1,0');
    expect(toCoord('S')).toBe('1,-1');
  });
});

// =============================================================
// Board Configurations
// =============================================================

describe('Board configurations per player count', () => {
  it('2-player board has 9 stations (center + 6 inner + W + E)', () => {
    expect(STATIONS_BY_PLAYER_COUNT[2]).toHaveLength(9);
    expect(STATIONS_BY_PLAYER_COUNT[2]).toContain('C');
    expect(STATIONS_BY_PLAYER_COUNT[2]).toContain('W');
    expect(STATIONS_BY_PLAYER_COUNT[2]).toContain('E');
  });

  it('3-player board has 9 stations (center + 6 inner + FNW + FSW)', () => {
    expect(STATIONS_BY_PLAYER_COUNT[3]).toHaveLength(9);
    expect(STATIONS_BY_PLAYER_COUNT[3]).toContain('FNW');
    expect(STATIONS_BY_PLAYER_COUNT[3]).toContain('FSW');
    expect(STATIONS_BY_PLAYER_COUNT[3]).not.toContain('E');
  });

  it('4-player board has 13 stations (all)', () => {
    expect(STATIONS_BY_PLAYER_COUNT[4]).toHaveLength(13);
  });

  it('all boards include center', () => {
    for (const count of [2, 3, 4]) {
      expect(STATIONS_BY_PLAYER_COUNT[count]).toContain('C');
    }
  });

  it('2-player starts at N and S', () => {
    expect(START_STATIONS[2]).toEqual(['N', 'S']);
  });

  it('3-player starts at NW, NE, S', () => {
    expect(START_STATIONS[3]).toEqual(['NW', 'NE', 'S']);
  });

  it('4-player starts at NW, NE, SE, SW', () => {
    expect(START_STATIONS[4]).toEqual(['NW', 'NE', 'SE', 'SW']);
  });

  it('start stations match original board_setup.js', () => {
    // Original: 2-player: ["-1,1", "1,-1"] → [N, S]
    // Original: 3-player: ["-1,0", "0,1", "1,-1"] → [NW, NE, S]
    // Original: 4-player: ["-1,0", "0,1", "1,0", "0,-1"] → [NW, NE, SE, SW]
    expect(START_STATIONS[2].map(toCoord)).toEqual(['-1,1', '1,-1']);
    expect(START_STATIONS[3].map(toCoord)).toEqual(['-1,0', '0,1', '1,-1']);
    expect(START_STATIONS[4].map(toCoord)).toEqual(['-1,0', '0,1', '1,0', '0,-1']);
  });
});

// =============================================================
// Slot Topology
// =============================================================

describe('Slot topology (STATION_SLOTS)', () => {
  it('center connects to all 6 inner ring stations', () => {
    const centerNeighbors = Object.keys(STATION_SLOTS['C']!);
    expect(centerNeighbors).toContain('N');
    expect(centerNeighbors).toContain('NE');
    expect(centerNeighbors).toContain('SE');
    expect(centerNeighbors).toContain('S');
    expect(centerNeighbors).toContain('SW');
    expect(centerNeighbors).toContain('NW');
    expect(centerNeighbors).toHaveLength(6);
  });

  it('each center connection has L, C, R channels', () => {
    for (const neighbor of Object.values(STATION_SLOTS['C']!)) {
      const channels = Object.keys(neighbor!);
      expect(channels).toContain('L');
      expect(channels).toContain('C');
      expect(channels).toContain('R');
    }
  });

  it('outer stations connect to exactly 2 inner ring stations', () => {
    const outerStations: StationName[] = ['W', 'E', 'FNW', 'FNE', 'FSE', 'FSW'];
    for (const station of outerStations) {
      expect(Object.keys(STATION_SLOTS[station]!)).toHaveLength(2);
    }
  });

  it('slot IDs are in range 0-71', () => {
    const allSlotIds = new Set<number>();
    for (const neighbors of Object.values(STATION_SLOTS)) {
      for (const channels of Object.values(neighbors!)) {
        for (const slotId of Object.values(channels!)) {
          expect(slotId).toBeGreaterThanOrEqual(0);
          expect(slotId).toBeLessThan(72);
          allSlotIds.add(slotId as number);
        }
      }
    }
    // All 72 slots should be referenced
    expect(allSlotIds.size).toBe(72);
  });

  it('slots between A→B and B→A reference the same physical slots with swapped L/R', () => {
    // C→N:L should equal N→C:R (same physical slot)
    const cToN = STATION_SLOTS['C']!['N']!;
    const nToC = STATION_SLOTS['N']!['C']!;
    expect(cToN.L).toBe(nToC.R);
    expect(cToN.C).toBe(nToC.C);
    expect(cToN.R).toBe(nToC.L);
  });

  it('slot 0 is C-N:L and N-C:R (matches original slots.js)', () => {
    expect(STATION_SLOTS['C']!['N']!.L).toBe(0);
    expect(STATION_SLOTS['N']!['C']!.R).toBe(0);
  });

  it('center slot indices match original slots.js layout', () => {
    // Original: "0,0" → "-1,1" → { l: 0, c: 1, r: 2 }
    expect(STATION_SLOTS['C']!['N']!).toEqual({ L: 0, C: 1, R: 2 });
    // Original: "0,0" → "0,1" → { l: 3, c: 4, r: 5 }
    expect(STATION_SLOTS['C']!['NE']!).toEqual({ L: 3, C: 4, R: 5 });
    // Original: "0,0" → "1,0" → { l: 6, c: 7, r: 8 }
    expect(STATION_SLOTS['C']!['SE']!).toEqual({ L: 6, C: 7, R: 8 });
    // Original: "0,0" → "1,-1" → { l: 9, c: 10, r: 11 }
    expect(STATION_SLOTS['C']!['S']!).toEqual({ L: 9, C: 10, R: 11 });
    // Original: "0,0" → "0,-1" → { l: 12, c: 13, r: 14 }
    expect(STATION_SLOTS['C']!['SW']!).toEqual({ L: 12, C: 13, R: 14 });
    // Original: "0,0" → "-1,0" → { l: 15, c: 16, r: 17 }
    expect(STATION_SLOTS['C']!['NW']!).toEqual({ L: 15, C: 16, R: 17 });
  });
});

// =============================================================
// Slot Interference
// =============================================================

describe('Slot interference rules', () => {
  it('interference rules match original slots.js', () => {
    // Original: this.slots[0].interferes_with = [17, 18]
    expect(getSlotInterferences(0)).toEqual([17, 18]);
    // Original: this.slots[2].interferes_with = [3, 27]
    expect(getSlotInterferences(2)).toEqual([3, 27]);
    // Original: this.slots[5].interferes_with = [6, 36]
    expect(getSlotInterferences(5)).toEqual([6, 36]);
  });

  it('center channel slots (1, 4, 7, 10, 13, 16) have no interference', () => {
    // Center channels around the center station should not interfere
    for (const slotId of [1, 4, 7, 10, 13, 16]) {
      expect(getSlotInterferences(slotId)).toEqual([]);
    }
  });

  it('interference is symmetric (if A interferes with B, B interferes with A)', () => {
    for (const [slotStr, targets] of Object.entries(SLOT_INTERFERENCES)) {
      const slotId = Number(slotStr);
      for (const target of targets) {
        const targetInterferences = getSlotInterferences(target);
        expect(targetInterferences).toContain(slotId);
      }
    }
  });
});

// =============================================================
// Slot Neighbors
// =============================================================

describe('Slot neighbor groups', () => {
  it('every slot has exactly 2 neighbors', () => {
    for (let i = 0; i < 72; i++) {
      expect(SLOT_NEIGHBORS[i]).toHaveLength(2);
    }
  });

  it('neighbors form triplets (slots 0,1,2 are mutual neighbors)', () => {
    expect(SLOT_NEIGHBORS[0]).toEqual([1, 2]);
    expect(SLOT_NEIGHBORS[1]).toEqual([0, 2]);
    expect(SLOT_NEIGHBORS[2]).toEqual([0, 1]);
  });

  it('slot triplets are grouped by 3s (0-2, 3-5, 6-8, ...)', () => {
    for (let base = 0; base < 72; base += 3) {
      expect(SLOT_NEIGHBORS[base]).toContain(base + 1);
      expect(SLOT_NEIGHBORS[base]).toContain(base + 2);
      expect(SLOT_NEIGHBORS[base + 1]).toContain(base);
      expect(SLOT_NEIGHBORS[base + 1]).toContain(base + 2);
      expect(SLOT_NEIGHBORS[base + 2]).toContain(base);
      expect(SLOT_NEIGHBORS[base + 2]).toContain(base + 1);
    }
  });
});

// =============================================================
// Slot-to-Station Mapping
// =============================================================

describe('SLOT_TO_STATIONS mapping', () => {
  it('has entries for all 72 slots', () => {
    expect(SLOT_TO_STATIONS).toHaveLength(72);
  });

  it('each slot maps to exactly 2 stations', () => {
    for (let i = 0; i < 72; i++) {
      expect(SLOT_TO_STATIONS[i]).toHaveLength(2);
    }
  });

  it('slot 0 connects C and N', () => {
    const [a, b] = SLOT_TO_STATIONS[0];
    const stations = [a, b].sort();
    expect(stations).toEqual(['C', 'N']);
  });
});

// =============================================================
// buildTopology
// =============================================================

describe('buildTopology', () => {
  it('2-player topology has 9 stations', () => {
    const topo = buildTopology(2);
    expect(topo.stations).toHaveLength(9);
  });

  it('3-player topology has 9 stations', () => {
    const topo = buildTopology(3);
    expect(topo.stations).toHaveLength(9);
  });

  it('4-player topology has 13 stations', () => {
    const topo = buildTopology(4);
    expect(topo.stations).toHaveLength(13);
  });

  it('2-player topology does not include 4-player outer corners', () => {
    const topo = buildTopology(2);
    expect(topo.stations).not.toContain('FNW');
    expect(topo.stations).not.toContain('FNE');
    expect(topo.stations).not.toContain('FSE');
    expect(topo.stations).not.toContain('FSW');
  });

  it('topology station slot mapping only contains active stations', () => {
    const topo = buildTopology(2);
    for (const [from, neighbors] of Object.entries(topo.stationSlotMapping)) {
      expect(topo.stations).toContain(from as StationName);
      for (const to of Object.keys(neighbors)) {
        expect(topo.stations).toContain(to as StationName);
      }
    }
  });

  it('topology start stations match board size', () => {
    expect(buildTopology(2).startStations).toHaveLength(2);
    expect(buildTopology(3).startStations).toHaveLength(3);
    expect(buildTopology(4).startStations).toHaveLength(4);
  });
});
