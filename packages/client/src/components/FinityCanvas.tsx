/**
 * FinityCanvas — p5.js board rendering.
 * Ported from FinityCanvas.js with react-p5.
 *
 * Reads from the new engine's FinityGameState + LayoutData.
 * Now also draws legal-target highlights for the local human's turn.
 */

import Sketch from 'react-p5';
import type p5 from 'p5';

import type { FinityGameState, GamePiece } from '@finity/engine';
import { DisplayHandler } from '../rendering/displayHandler';
import { computeLayout } from '../rendering/layout';
import type { GameImages } from '../rendering/displayHandler';
import type { LayoutData } from '../rendering/layout';
import type { BoardTarget } from '../rendering/moveInputHandler';

const PIXEL_WIDTH = 950;
const PIXEL_HEIGHT = 650;
const BG_COLOR = [0.4, 0.6, 0.5];

interface FinityCanvasProps {
  gameState: FinityGameState;
  movePreview?: GamePiece | null;
  /** Legal targets to highlight for the player on the clock. */
  highlightTargets?: BoardTarget[];
  onCanvasClick?: (x: number, y: number) => void;
  onCanvasMouseMove?: (x: number, y: number) => void;
}

let imgs: Partial<GameImages> = {};
let displayHandler: DisplayHandler | null = null;
let layout: LayoutData | null = null;
let p5Setup = false;

const FinityCanvas = ({
  gameState,
  movePreview,
  highlightTargets,
  onCanvasClick,
  onCanvasMouseMove,
}: FinityCanvasProps) => {
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
      layout = computeLayout(gameState.config.boardSize, PIXEL_WIDTH, PIXEL_HEIGHT);

      // Mouse handlers bound once here. They call the latest prop via a ref-free
      // indirection: the handler passed by PlayView reads live state through the
      // orchestrator, so binding once is safe.
      cnv.mousePressed(() => {
        if (onCanvasClick) onCanvasClick(p.mouseX, p.mouseY);
      });
      cnv.mouseMoved(() => {
        if (onCanvasMouseMove) onCanvasMouseMove(p.mouseX, p.mouseY);
      });
    }
  };

  const draw = (_p: any) => {
    if (displayHandler && layout) {
      displayHandler.display(gameState, layout, movePreview, highlightTargets);
    }
  };

  return <Sketch setup={setup} draw={draw} preload={preload} />;
};

export default FinityCanvas;
