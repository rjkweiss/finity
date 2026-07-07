/**
 * App — root component (orchestrator model).
 * App owns the orchestrator so the Header's play/pause/step/reset can drive it, and
 * PlayView subscribes to it via useOrchestrator.
 */

import { useMemo, useState } from 'react';
import type { ArrowColor, GameConfig } from '@finity/engine';
import Header from './components/Header';
import { PlayView, twoLocalHumans } from './components/PlayView';
import { GameOrchestrator } from './orchestrator';

type View = 'play' | 'agents' | 'history' | 'lobby';

export default function App() {
  const [activeView, setActiveView] = useState<View>('play');

  const config = useMemo<GameConfig>(
    () => ({ playerColors: ['cyan', 'yellow'], boardSize: 2 }),
    [],
  );
  const agents = useMemo(() => twoLocalHumans(['cyan', 'yellow']), []);
  const pattern = useMemo<ArrowColor[]>(
    () => Array.from({ length: 8 }, () => (Math.random() < 0.5 ? 'b' : 'w')),
    [],
  );

  // One orchestrator for the app's lifetime. Header drives it; PlayView renders it.
  const orch = useMemo(
    () => new GameOrchestrator({ config, agents, pathPattern: pattern }),
    [config, agents, pattern],
  );

  return (
    <div className="App">
      <Header
        activeView={activeView}
        onNavigate={setActiveView}
        onPlay={() => void orch.play()}
        onPause={() => orch.pause()}
        onStep={() => void orch.step()}
        onReset={() => orch.reset()}
      />
      <main>
        {activeView === 'play' && <PlayView orchestrator={orch} />}
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
