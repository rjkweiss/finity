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
  /** Uniform board scale (<= 1). 1 for the 2-player board (the reference framing);
   *  taller boards (3p/4p include FNW/FSW rows) shrink to fit the canvas. The
   *  DisplayHandler multiplies its fixed piece sizes (rings, posts, arrows,
   *  highlights) by this so pieces stay proportional to stations. */
  scale: number;
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
  // Base geometry (the original board_setup.js constants). These describe the
  // 2-player board at scale 1; other board sizes reuse the same proportions.
  const near = 145;
  const far = 290;
  const vsm = 83;
  const STATION_HALF = 100; // station image is 200x200, drawn centered

  const activeStations = STATIONS_BY_PLAYER_COUNT[boardSize];

  // --- Unit positions around the origin ------------------------------------
  const unitPositions: Record<string, [number, number]> = {
    C: ALL_STATION_POSITIONS['C'](0, 0, near, far, vsm),
  };
  for (const name of activeStations) {
    if (ALL_STATION_POSITIONS[name]) {
      unitPositions[name] = ALL_STATION_POSITIONS[name](0, 0, near, far, vsm);
    }
  }

  // --- Fit and center -------------------------------------------------------
  // Drawable region: full canvas minus small margins, minus the right-hand strip
  // where drawBoard renders the cone-pattern indicator column (images centered at
  // x=850, 100 wide, i.e. from x=800 on a 950 canvas -> keep the board left of it).
  const MARGIN = 10;
  const INDICATOR_STRIP = 160; // 950 - 160 = 790, clear of the column at x >= 800
  const availLeft = MARGIN;
  const availRight = canvasWidth - INDICATOR_STRIP;
  const availTop = MARGIN;
  const availBottom = canvasHeight - MARGIN;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of Object.values(unitPositions)) {
    minX = Math.min(minX, x - STATION_HALF);
    maxX = Math.max(maxX, x + STATION_HALF);
    minY = Math.min(minY, y - STATION_HALF);
    maxY = Math.max(maxY, y + STATION_HALF);
  }

  // Uniform scale, capped at 1: the 2p board already fits at scale 1 and its
  // framing is the visual reference, so it must come out pixel-identical.
  const scale = Math.min(
    1,
    (availRight - availLeft) / (maxX - minX),
    (availBottom - availTop) / (maxY - minY),
  );

  // Center the (scaled) bounding box in the drawable region.
  const cx = (availLeft + availRight) / 2 - (scale * (minX + maxX)) / 2;
  const cy = (availTop + availBottom) / 2 - (scale * (minY + maxY)) / 2;

  const stationPositions: Record<string, [number, number]> = {};
  for (const [name, [ux, uy]] of Object.entries(unitPositions)) {
    stationPositions[name] = [cx + scale * ux, cy + scale * uy];
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
    stationSize: [200 * scale, 200 * scale],
    scale,
    slotLayouts,
    canvasWidth,
    canvasHeight,
  };
}
