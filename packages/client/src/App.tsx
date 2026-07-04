/**
 * App — root component (orchestrator model).
 * The orchestrator owns game state; PlayView subscribes via useOrchestrator.
 */

import { useMemo, useState } from 'react';
import type { GameConfig } from '@finity/engine';
import Header from './components/Header';
import { PlayView, twoLocalHumans } from './components/PlayView';

type View = 'play' | 'agents' | 'history' | 'lobby';

export default function App() {
  const [activeView, setActiveView] = useState<View>('play');

  // Memoized so PlayView's internal useMemo doesn't rebuild the orchestrator each render.
  const config = useMemo<GameConfig>(
    () => ({ playerColors: ['cyan', 'yellow'], boardSize: 2 }),
    [],
  );
  const agents = useMemo(() => twoLocalHumans(['cyan', 'yellow']), []);

  return (
    <div className="App">
      <Header activeView={activeView} onNavigate={setActiveView} />
      <main>
        {activeView === 'play' && <PlayView config={config} agents={agents} />}
        {activeView === 'agents' && (
          <div className="placeholder-view"><h2>Agent Editor</h2><p>Coming in Phase 6</p></div>
        )}
        {activeView === 'history' && (
          <div className="placeholder-view"><h2>Game History</h2><p>Coming in Phase 3</p></div>
        )}
        {activeView === 'lobby' && (
          <div className="placeholder-view"><h2>Game Lobby</h2><p>Coming in Phase 5</p></div>
        )}
      </main>
    </div>
  );
}
