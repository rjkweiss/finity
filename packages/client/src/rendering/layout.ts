/**
 * Board Layout — pixel positions for rendering.
 * Ported from board_setup.js station_positions() and set_up_slots().
 * Pure function of board size and canvas dimensions.
 *
 * Computes:
 *   - Station pixel positions
 *   - Slot midpoints (where arrows/blockers are drawn)
 *   - Slot to_points (arrow tip positions)
 *   - Slot rise/run (for rotation)
 */

import type { StationName, Channel } from '@finity/engine';
import { STATION_SLOTS, STATIONS_BY_PLAYER_COUNT } from '@finity/engine';

export interface SlotLayout {
  midpoint: [number, number] | null;
  toPoints: Record<string, [number, number]>;
  rise: number;
  run: number;
}

export interface LayoutData {
  stationPositions: Record<StationName, [number, number]>;
  stationSize: [number, number];
  slotLayouts: SlotLayout[];   // indexed 0-71
  canvasWidth: number;
  canvasHeight: number;
}

const ALL_STATION_POSITIONS: Record<StationName, (cx: number, cy: number, near: number, far: number, vsm: number) => [number, number]> = {
  C:   (cx, cy) => [cx, cy],
  NW:  (cx, cy, near, _, vsm) => [cx - near, cy - vsm],
  N:   (cx, cy, _, __, vsm) => [cx, cy - vsm * 2],
  NE:  (cx, cy, near, _, vsm) => [cx + near, cy - vsm],
  SE:  (cx, cy, near, _, vsm) => [cx + near, cy + vsm],
  S:   (cx, cy, _, __, vsm) => [cx, cy + vsm * 2],
  SW:  (cx, cy, near, _, vsm) => [cx - near, cy + vsm],
  W:   (cx, cy, _, far) => [cx - far, cy],
  E:   (cx, cy, _, far) => [cx + far, cy],
  FNW: (cx, cy, near, _, vsm) => [cx - near, cy - vsm * 3],
  FNE: (cx, cy, near, _, vsm) => [cx + near, cy - vsm * 3],
  FSW: (cx, cy, near, _, vsm) => [cx - near, cy + vsm * 3],
  FSE: (cx, cy, near, _, vsm) => [cx + near, cy + vsm * 3],
};

/**
 * Compute full layout data for rendering.
 * Matches the original board_setup.js positioning.
 */
export function computeLayout(
  boardSize: 2 | 3 | 4,
  canvasWidth = 950,
  canvasHeight = 650,
): LayoutData {
  const cx = 400;
  const cy = 325;
  const near = 145;
  const far = 290;
  const vsm = 83;

  // Compute station positions
  const activeStations = STATIONS_BY_PLAYER_COUNT[boardSize];
  const stationPositions: Record<string, [number, number]> = {};

  // Always include center
  stationPositions['C'] = ALL_STATION_POSITIONS['C'](cx, cy, near, far, vsm);

  for (const name of activeStations) {
    if (ALL_STATION_POSITIONS[name]) {
      stationPositions[name] = ALL_STATION_POSITIONS[name](cx, cy, near, far, vsm);
    }
  }

  // Compute slot layouts (midpoints, to_points, rise/run)
  // Ported from board_setup.js set_up_slots()
  const slotLayouts: SlotLayout[] = Array.from({ length: 72 }, () => ({
    midpoint: null,
    toPoints: {},
    rise: 0,
    run: 0,
  }));

  const seenSlots = new Set<number>();

  for (const fromName of activeStations) {
    const neighbors = STATION_SLOTS[fromName];
    if (!neighbors) continue;

    for (const [toName, channels] of Object.entries(neighbors)) {
      if (!activeStations.includes(toName as StationName) && toName !== 'C') continue;
      if (!stationPositions[fromName] || !stationPositions[toName]) continue;

      const [fromX, fromY] = stationPositions[fromName];
      const [toX, toY] = stationPositions[toName];

      const midX = (fromX + toX) / 2;
      const midY = (fromY + toY) / 2;

      const toPointX = (fromX + 1.3 * toX) / 2.3;
      const toPointY = (fromY + 1.3 * toY) / 2.3;

      const distance = 0.18;
      const rise = toY - fromY;
      const run = toX - fromX;

      for (const [ch, slotId] of Object.entries(channels as Record<string, number>)) {
        if (seenSlots.has(slotId)) continue;
        seenSlots.add(slotId);

        const layout = slotLayouts[slotId];
        layout.rise = rise;
        layout.run = run;

        if (ch === 'C') {
          layout.midpoint = [midX, midY];
          layout.toPoints[toName] = [toPointX, toPointY];
        } else if (ch === 'L') {
          layout.midpoint = [midX + distance * rise, midY - distance * run];
          layout.toPoints[toName] = [toPointX + distance * rise, toPointY - distance * run];
        } else if (ch === 'R') {
          layout.midpoint = [midX - distance * rise, midY + distance * run];
          layout.toPoints[toName] = [toPointX - distance * rise, toPointY + distance * run];
        }
      }
    }
  }

  return {
    stationPositions: stationPositions as Record<StationName, [number, number]>,
    stationSize: [200, 200],
    slotLayouts,
    canvasWidth,
    canvasHeight,
  };
}
