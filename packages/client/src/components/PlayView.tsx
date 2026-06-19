/**
 * PlayView — main game screen.
 * Ported from the original App.js game_container layout.
 */

import { useState } from 'react';
import type { FinityGameState, PlayerColor } from '@finity/engine';
import { currentPlayer } from '@finity/engine';
import FinityCanvas from './FinityCanvas';
import PlayerPanel from './PlayerPanel';

interface PlayViewProps {
  gameState: FinityGameState;
  setGameState: (state: FinityGameState) => void;
}

export default function PlayView({ gameState, setGameState }: PlayViewProps) {
  const current = currentPlayer(gameState);
  const colors = gameState.config.playerColors;

  const handleCanvasClick = (x: number, y: number) => {
    // TODO: wire to MoveInputHandler → LocalHumanAgent
    console.log('Canvas click:', x, y);
  };

  const handleMouseMove = (x: number, y: number) => {
    // TODO: wire to move preview generation
  };

  return (
    <div className="play-view">
      <div id="game_container">
        <div id="players_1_3">
          {colors[0] && (
            <PlayerPanel
              color={colors[0]}
              isTurn={current === colors[0]}
              winners={gameState.winners}
            />
          )}
          {colors[3] ? (
            <PlayerPanel
              color={colors[3]}
              isTurn={current === colors[3]}
              winners={gameState.winners}
            />
          ) : colors[2] ? (
            <PlayerPanel
              color={colors[2]}
              isTurn={current === colors[2]}
              winners={gameState.winners}
            />
          ) : null}
        </div>

        <div id="finity">
          <FinityCanvas
            gameState={gameState}
            onCanvasClick={handleCanvasClick}
            onCanvasMouseMove={handleMouseMove}
          />
        </div>

        <div id="players_2_4">
          {colors[1] && (
            <PlayerPanel
              color={colors[1]}
              isTurn={current === colors[1]}
              winners={gameState.winners}
            />
          )}
          {colors[3] && colors[2] && (
            <PlayerPanel
              color={colors[2]}
              isTurn={current === colors[2]}
              winners={gameState.winners}
            />
          )}
        </div>
      </div>

      <div className="evaluation-bar">
        <span>Turn: {current}</span>
        <span>Move: {gameState.moveHistory.length}</span>
        <span>Pattern: {gameState.pathPattern.join(' ')}</span>
        <span>Status: {gameState.playStatus}</span>
      </div>
    </div>
  );
}
