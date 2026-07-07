/**
 * Display Handler — ported from display_handler.js
 *
 * Draws the Finity board using p5.js. Reads from the new engine's
 * FinityGameState and LayoutData instead of the old mutable objects.
 *
 * Changes from original:
 *   - Uses type fields instead of constructor.name
 *   - Reads pixel positions from LayoutData instead of game objects
 *   - Station names use compass system
 */

import type p5 from 'p5';
import type {
  FinityGameState,
  ArrowState,
  BlockerState,
  RingState,
  StationName,
  PlayerColor,
  GamePiece,
} from '@finity/engine';
import type { LayoutData } from './layout';
import type { BoardTarget } from './moveInputHandler';

export interface GameImages {
  cs: p5.Image;        // center station
  st: p5.Image;        // station
  ind_side_b: p5.Image;
  ind_side_w: p5.Image;
  ind_top_b: p5.Image;
  ind_top_w: p5.Image;
  bp: p5.Image;        // base posts sprite
  bp_prev: p5.Image;
  bl: p5.Image;        // blockers sprite
  bl_prev: p5.Image;
  rings_s: p5.Image;
  rings_s_prev: p5.Image;
  rings_m: p5.Image;
  rings_m_prev: p5.Image;
  rings_l: p5.Image;
  rings_l_prev: p5.Image;
  ab: p5.Image;        // arrow black
  ab_prev: p5.Image;
  aw: p5.Image;        // arrow white
  aw_prev: p5.Image;
}

const COLOR_CROPS: Record<string, [number, number, number, number]> = {
  red:    [0, 0, 300, 300],
  cyan:   [300, 300, 300, 300],
  purple: [0, 300, 300, 300],
  yellow: [300, 0, 300, 300],
};

const ROTATIONS: Record<string, number> = {
  up: 0,
  up_right: 1.1,
  up_left: -1.1,
  down_right: Math.PI - 1.1,
  down_left: Math.PI + 1.1,
  down: Math.PI,
};

export class DisplayHandler {
  private p: p5;
  private imgs: GameImages;
  private bgColor: number[];

  constructor(p5Instance: p5, imgs: GameImages, bgColor: number[]) {
    this.p = p5Instance;
    this.imgs = imgs;
    this.bgColor = bgColor;
  }

  display(
    state: FinityGameState,
    layout: LayoutData,
    movePreview?: GamePiece | null,
    highlights?: readonly BoardTarget[],
  ): void {
    // p5.background overloads don't accept a plain number[] spread in TS, so handle by length
    if (this.bgColor.length === 1) {
      this.p.background(this.bgColor[0]);
    } else if (this.bgColor.length === 3) {
      this.p.background(this.bgColor[0], this.bgColor[1], this.bgColor[2]);
    } else if (this.bgColor.length >= 4) {
      this.p.background(this.bgColor[0], this.bgColor[1], this.bgColor[2], this.bgColor[3]);
    } else {
      // fallback
      this.p.background(0);
    }
    this.drawBoard(state, layout);
    if (highlights && highlights.length > 0) {
      this.drawHighlights(highlights, layout);
    }
    if (movePreview) {
      this.drawMovePreview(movePreview, state, layout);
    }
  }

  /** Ring/circle markers on the legal targets the player can click this turn.
   *  Colors are in the canvas's colorMode(RGB, 1) space (0..1 channels + alpha). */
  private drawHighlights(targets: readonly BoardTarget[], layout: LayoutData): void {
    const p = this.p;
    p.push();
    p.noFill();
    p.strokeWeight(3);
    p.stroke(1, 0.82, 0.15, 0.95); // gold
    for (const t of targets) {
      let pos: [number, number] | null | undefined;
      let d: number;
      if (t.kind === 'station') {
        pos = layout.stationPositions[t.station];
        d = 70;
      } else {
        pos = layout.slotLayouts[t.slotId]?.midpoint;
        d = 34;
      }
      if (!pos) continue;
      p.ellipse(pos[0], pos[1], d, d);
    }
    p.pop();
  }


  // ===============================
  // Board Drawing
  // ===============================

  private drawBoard(state: FinityGameState, layout: LayoutData): void {
    // Draw stations
    for (const [name, station] of Object.entries(state.board.stations)) {
      const pos = layout.stationPositions[name as StationName];
      if (!pos) continue;
      this.drawStation(name as StationName, name === 'C', pos, layout.stationSize);
    }

    // Draw path pattern indicators (reversed, bottom to top)
    const pattern = [...state.pathPattern].reverse();
    pattern.forEach((cone, ind) => {
      this.p.image(
        cone === 'b' ? this.imgs.ind_side_b : this.imgs.ind_side_w,
        850, 150 + ind * 50, 100, 70,
      );
    });

    // Top indicator on center station
    const centerPos = layout.stationPositions['C'];
    if (centerPos) {
      const topCone = state.pathPattern[state.pathPattern.length - 1];
      this.p.image(
        topCone === 'b' ? this.imgs.ind_top_b : this.imgs.ind_top_w,
        centerPos[0], centerPos[1], 100, 100,
      );
    }

    // Draw base posts
    for (const [name, station] of Object.entries(state.board.stations)) {
      if (station.basePost) {
        const pos = layout.stationPositions[name as StationName];
        if (pos) this.drawBasePost(station.basePost, pos);
      }
    }

    // Draw arrows
    for (const slot of state.board.slots) {
      if (slot.contains?.type === 'arrow') {
        this.drawArrowPiece(slot.contains as ArrowState, layout, false);
      }
    }

    // Draw blockers
    for (const slot of state.board.slots) {
      if (slot.contains?.type === 'blocker') {
        this.drawBlockerPiece(slot.contains as BlockerState, layout, false);
      }
    }

    // Draw rings
    for (const [name, station] of Object.entries(state.board.stations)) {
      const pos = layout.stationPositions[name as StationName];
      if (!pos) continue;
      for (const ring of station.rings) {
        if (ring) {
          this.drawRing(ring, pos);
        }
      }
    }
  }

  // ===============================
  // Individual Piece Drawing
  // ===============================

  private drawStation(
    name: StationName, isCenter: boolean,
    pos: [number, number], size: [number, number],
  ): void {
    const img = isCenter ? this.imgs.cs : this.imgs.st;
    this.p.image(img, pos[0], pos[1], ...size);

    // Station label
    this.p.textSize(28);
    this.p.textAlign(this.p.CENTER, this.p.CENTER);
    this.p.fill(0, 0, 0, 0.4);
    this.p.text(name, pos[0], pos[1] - 50);
  }

  private drawRing(ring: RingState, stationPos: [number, number]): void {
    const sizeKey = `rings_${ring.size}` as keyof GameImages;
    const img = this.imgs[sizeKey] as p5.Image;
    if (!img) return;

    const crop = COLOR_CROPS[ring.color];
    if (!crop) return;

    this.p.image(img, stationPos[0], stationPos[1], 100, 100, ...crop);
  }

  private drawBasePost(color: PlayerColor, stationPos: [number, number]): void {
    const crop = COLOR_CROPS[color];
    if (!crop) return;
    this.p.image(this.imgs.bp, stationPos[0], stationPos[1], 100, 100, ...crop);
  }

  private drawArrowPiece(arrow: ArrowState, layout: LayoutData, isPreview: boolean): void {
    const slotLayout = layout.slotLayouts[arrow.slotId];
    if (!slotLayout?.midpoint) return;

    const fromPos = layout.stationPositions[arrow.fromStation];
    const toPos = layout.stationPositions[arrow.toStation];
    if (!fromPos || !toPos) return;

    const img = isPreview
      ? (arrow.color === 'b' ? this.imgs.ab_prev : this.imgs.aw_prev)
      : (arrow.color === 'b' ? this.imgs.ab : this.imgs.aw);
    img.resize(90, 90);

    const rise = toPos[1] - fromPos[1];
    const run = toPos[0] - fromPos[0];
    const angle = ROTATIONS[angleLabel(rise, run)] ?? 0;

    const [mx, my] = slotLayout.midpoint;
    this.p.translate(mx, my);
    this.p.rotate(angle);
    this.p.image(img, 0, 0);
    this.p.rotate(-angle);
    this.p.translate(-mx, -my);
  }

  private drawBlockerPiece(blocker: BlockerState, layout: LayoutData, isPreview: boolean): void {
    const slotLayout = layout.slotLayouts[blocker.slotId];
    if (!slotLayout?.midpoint) return;

    const img = isPreview ? this.imgs.bl_prev : this.imgs.bl;
    const crop = COLOR_CROPS[blocker.color];
    if (!crop) return;

    const angle = ROTATIONS[angleLabel(slotLayout.rise, slotLayout.run)] ?? 0;
    const [mx, my] = slotLayout.midpoint;

    this.p.translate(mx, my);
    this.p.rotate(angle);
    this.p.image(img, 0, 0, 100, 100, ...crop);
    this.p.rotate(-angle);
    this.p.translate(-mx, -my);
  }

  // ===============================
  // Move Preview
  // ===============================

  private drawMovePreview(piece: GamePiece, state: FinityGameState, layout: LayoutData): void {
    if (piece.type === 'ring') {
      // Ring preview needs a station position — for now skip
      // (requires MovePreview type with station context)
    } else if (piece.type === 'basePost') {
      const pos = layout.stationPositions[piece.toStation];
      if (pos) {
        const crop = COLOR_CROPS[piece.color];
        if (crop) {
          this.p.image(this.imgs.bp_prev, pos[0], pos[1], 100, 100, ...crop);
        }
      }
    } else if (piece.type === 'arrow') {
      this.drawArrowPiece(piece as ArrowState, layout, true);
    } else if (piece.type === 'blocker') {
      this.drawBlockerPiece(piece as BlockerState, layout, true);
    }
  }
}

// ===============================
// Helpers
// ===============================

function angleLabel(rise: number, run: number): string {
  if (rise > 0) {
    if (run > 0) return 'down_right';
    if (run < 0) return 'down_left';
    return 'down';
  } else if (rise < 0) {
    if (run > 0) return 'up_right';
    if (run < 0) return 'up_left';
    return 'up';
  } else {
    if (run > 0) return 'right';
    if (run < 0) return 'left';
  }
  return 'up';
}
