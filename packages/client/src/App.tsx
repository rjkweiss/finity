/**
 * App — root component.
 * Ported from the original class-based App.js to functional React.
 */

import { useState } from 'react';
import { createGame } from '@finity/engine';
import type { FinityGameState } from '@finity/engine';
import Header from './components/Header';
import PlayView from './components/PlayView';

type View = 'play' | 'agents' | 'history' | 'lobby';

export default function App() {
  const [activeView, setActiveView] = useState<View>('play');

  const [gameState, setGameState] = useState<FinityGameState>(() =>
    createGame(
      { playerColors: ['cyan', 'yellow', 'red', 'purple'], boardSize: 4 },
      ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'],
    ),
  );

  const handleReset = () => {
    setGameState(
      createGame(
        gameState.config,
        ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'], // TODO: random pattern
      ),
    );
  };

  return (
    <div className="App">
      <Header
        activeView={activeView}
        onNavigate={setActiveView}
        onReset={handleReset}
      />
      <main>
        {activeView === 'play' && (
          <PlayView gameState={gameState} setGameState={setGameState} />
        )}
        {activeView === 'agents' && (
          <div className="placeholder-view">
            <h2>Agent Editor</h2>
            <p>Coming in Phase 6</p>
          </div>
        )}
        {activeView === 'history' && (
          <div className="placeholder-view">
            <h2>Game History</h2>
            <p>Coming in Phase 3</p>
          </div>
        )}
        {activeView === 'lobby' && (
          <div className="placeholder-view">
            <h2>Game Lobby</h2>
            <p>Coming in Phase 5</p>
          </div>
        )}
      </main>
    </div>
  );
}
