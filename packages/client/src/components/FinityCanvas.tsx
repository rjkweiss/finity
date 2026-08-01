/**
 * FinityCanvas — p5.js board rendering.
 * Ported from FinityCanvas.js with react-p5.
 *
 * Reads from the new engine's FinityGameState + LayoutData.
 * Now also draws legal-target highlights for the local human's turn.
 */
import { useEffect } from 'react';
import Sketch from 'react-p5';
import type p5 from 'p5';

import type { FinityGameState, GamePiece } from '@finity/engine';
import { DisplayHandler } from '../rendering/displayHandler';
import type { GameImages } from '../rendering/displayHandler';
import type { LayoutData } from '../rendering/layout';
import type { BoardTarget } from '../rendering/moveInputHandler';

const PIXEL_WIDTH = 950;
const PIXEL_HEIGHT = 650;
const BG_COLOR = [0.4, 0.6, 0.5];

interface FinityCanvasProps {
  gameState: FinityGameState;
  /** Geometry for the CURRENT board size. Owned by the parent (PlayView computes it) */
  layout: LayoutData;
  movePreview?: GamePiece | null;
  /** Legal targets to highlight for the player on the clock. */
  highlightTargets?: BoardTarget[];
  onCanvasClick?: (x: number, y: number) => void;
  onCanvasMouseMove?: (x: number, y: number) => void;
}

let imgs: Partial<GameImages> = {};
let displayHandler: DisplayHandler | null = null;
let p5Setup = false;

// p5 canvas event handlers are registered ONCE in setup()
let clickHandlerRef: ((x: number, y: number) => void) | null = null;
let moveHandlerRef: ((x: number, y: number) => void) | null = null;

const FinityCanvas = ({
  gameState,
  layout,
  movePreview,
  highlightTargets,
  onCanvasClick,
  onCanvasMouseMove,
}: FinityCanvasProps) => {
  // The p5 wiring lives in module-level singletons
  // react-p5 should remove its p5 instance when THIS component unmounts
  useEffect(() => () => {
    p5Setup = false;
    displayHandler = null;
    clickHandlerRef = null;
    moveHandlerRef = null;
  }, []);

  // Keep the once-bound p5 event closures pointed at THIS render's props
  clickHandlerRef = onCanvasClick ?? null;
  moveHandlerRef = onCanvasMouseMove ?? null;

  const preload = (p: any) => {
    const load = (path: string, key: keyof GameImages) => {
      p.loadImage(path, (img: any) => {
        (imgs as any)[key] = img;
      });
    };

    load('img/center_station.png', 'cs');
    load('img/station.png', 'st');
    load('img/indicator_black_side.png', 'ind_side_b');
    load('img/indicator_white_side.png', 'ind_side_w');
    load('img/indicator_black_top.png', 'ind_top_b');
    load('img/indicator_white_top.png', 'ind_top_w');
    load('img/base_posts.png', 'bp');
    load('img/base_posts_preview.png', 'bp_prev');
    load('img/blockers.png', 'bl');
    load('img/blockers_preview.png', 'bl_prev');
    load('img/rings_small.png', 'rings_s');
    load('img/rings_small_preview.png', 'rings_s_prev');
    load('img/rings_medium.png', 'rings_m');
    load('img/rings_medium_preview.png', 'rings_m_prev');
    load('img/rings_large.png', 'rings_l');
    load('img/rings_large_preview.png', 'rings_l_prev');
    load('img/arrow_black.png', 'ab');
    load('img/arrow_black_preview.png', 'ab_prev');
    load('img/arrow_white.png', 'aw');
    load('img/arrow_white_preview.png', 'aw_prev');
  };

  const setup = (p: any, canvasParentRef: Element) => {
    if (!p5Setup) {
      p5Setup = true;

      const cnv = p.createCanvas(PIXEL_WIDTH, PIXEL_HEIGHT).parent(canvasParentRef);
      p.colorMode(p.RGB, 1);
      p.background(BG_COLOR[0], BG_COLOR[1], BG_COLOR[2]);
      p.imageMode(p.CENTER);

      displayHandler = new DisplayHandler(p, imgs as GameImages, BG_COLOR);

      // Mouse handlers bound once here. They call the latest prop via a ref-free
      // indirection: the handler passed by PlayView reads live state through the
      // orchestrator, so binding once is safe.

      // When no scaling is in effect, the ratio is exactly 1, so this is a no-op
      const toCanvasCoords = (mx: number, my: number): [number, number] => {
        const rect = (cnv as any).elt?.getBoundingClientRect?.();
        if (!rect || rect.width === 0 || rect.height === 0) return [mx, my];
        return [mx * (PIXEL_WIDTH / rect.width), my * (PIXEL_HEIGHT / rect.height)];
      };

      cnv.mousePressed(() => {
        const [x, y] = toCanvasCoords(p.mouseX, p.mouseY);
        clickHandlerRef?.(x, y);
      });

      cnv.mouseMoved(() => {
        const [x, y] = toCanvasCoords(p.mouseX, p.mouseY);
        moveHandlerRef?.(x, y);
      });
    }
  };

  const draw = (_p: any) => {
    if (displayHandler) {
      displayHandler.display(gameState, layout, movePreview, highlightTargets);
    }
  };

  return <Sketch setup={setup} draw={draw} preload={preload} />;
};

export default FinityCanvas;
