/**
 * FinityCanvas — p5.js board rendering.
 * Ported from FinityCanvas.js with react-p5.
 *
 * Reads from the new engine's FinityGameState + LayoutData
 * instead of the old mutable GameManager.
 */

import React from 'react';
import Sketch from 'react-p5';
import type p5 from 'p5';

import type { FinityGameState, GamePiece } from '@finity/engine';
import { DisplayHandler } from '../rendering/displayHandler';
import { computeLayout } from '../rendering/layout';
import type { GameImages } from '../rendering/displayHandler';
import type { LayoutData } from '../rendering/layout';

const PIXEL_WIDTH = 950;
const PIXEL_HEIGHT = 650;
const BG_COLOR = [0.4, 0.6, 0.5];

interface FinityCanvasProps {
  gameState: FinityGameState;
  movePreview?: GamePiece | null;
  onCanvasClick?: (x: number, y: number) => void;
  onCanvasMouseMove?: (x: number, y: number) => void;
}

let imgs: Partial<GameImages> = {};
let displayHandler: DisplayHandler | null = null;
let layout: LayoutData | null = null;
let p5Setup = false;

const FinityCanvas: React.FC<FinityCanvasProps> = ({
  gameState,
  movePreview,
  onCanvasClick,
  onCanvasMouseMove,
}) => {
  const preload = (p: any) => {
    const load = (path: string, key: keyof GameImages) => {
      p.loadImage(path, (img: any) => {
        (imgs as any)[key] = img;
      });
    };

    // Stations
    load('img/center_station.png', 'cs');
    load('img/station.png', 'st');

    // Path indicators
    load('img/indicator_black_side.png', 'ind_side_b');
    load('img/indicator_white_side.png', 'ind_side_w');
    load('img/indicator_black_top.png', 'ind_top_b');
    load('img/indicator_white_top.png', 'ind_top_w');

    // Base posts
    load('img/base_posts.png', 'bp');
    load('img/base_posts_preview.png', 'bp_prev');

    // Blockers
    load('img/blockers.png', 'bl');
    load('img/blockers_preview.png', 'bl_prev');

    // Rings
    load('img/rings_small.png', 'rings_s');
    load('img/rings_small_preview.png', 'rings_s_prev');
    load('img/rings_medium.png', 'rings_m');
    load('img/rings_medium_preview.png', 'rings_m_prev');
    load('img/rings_large.png', 'rings_l');
    load('img/rings_large_preview.png', 'rings_l_prev');

    // Arrows
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

      // Mouse handlers on canvas (not as props — avoids double-firing)
      cnv.mousePressed(() => {
        if (onCanvasClick) {
          onCanvasClick(p.mouseX, p.mouseY);
        }
      });

      cnv.mouseMoved(() => {
        if (onCanvasMouseMove) {
          onCanvasMouseMove(p.mouseX, p.mouseY);
        }
      });
    }
  };

  const draw = (p: any) => {
    if (displayHandler && layout) {
      displayHandler.display(gameState, layout, movePreview);
    }
  };

  return <Sketch setup={setup} draw={draw} preload={preload} />;
};

export default FinityCanvas;
