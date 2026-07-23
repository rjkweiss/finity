/**
 * App — root component (orchestrator model).
 * App owns the orchestrator so the Header's play/pause/step/reset can drive it, and
 * PlayView subscribes to it via useOrchestrator. Each player seat's agent is chosen
 * in its PlayerPanel dropdown; changing a seat rebuilds the orchestrator (a new game)
 * with the new agent map — the replaced orchestrator is disposed so its loop stops
 * and its worker agents terminate. Human and AI moves flow through the identical
 * turn loop; search AIs run in Web Workers so the UI never freezes mid-search.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArrowColor, GameConfig, PlayerColor } from '@finity/engine';
import {
  LocalHumanAgent,
  WeightedRandomAgent,
  createBuiltinAgent,
  type Difficulty,
  type PlayerAgent,
} from '@finity/agents';
import Header from './components/Header';
import { PlayView } from './components/PlayView';
import { GameOrchestrator, type AgentMap } from './orchestrator';
import { WorkerSearchAgent } from './agents/workerSearchAgent';

type View = 'play' | 'agents' | 'history' | 'lobby';

/** Pause between auto-played turns so AI-vs-AI games are watchable step by step. */
const TURN_DELAY_MS = 600;

const DIFFICULTY_BY_SEL: Record<string, Difficulty> = {
  'ai-easy': 'easy',
  'ai-medium': 'medium',
  'ai-hard': 'hard',
};

/**
 * Map a PlayerPanel dropdown value to a concrete agent.
 * Search AIs (easy/medium/hard) run in a Web Worker; 2-player -> minimax,
 * 3-4 -> MCTS is decided inside the worker by createBuiltinAgent. The on-thread
 * fallback covers environments without Worker (jsdom / headless tests).
 */
function makeAgent(color: PlayerColor, sel: string, playerCount: number): PlayerAgent {
  const difficulty = DIFFICULTY_BY_SEL[sel];
  if (difficulty) {
    return typeof Worker !== 'undefined'
      ? new WorkerSearchAgent({ difficulty, playerCount, id: `ai-${difficulty}-${color}` })
      : createBuiltinAgent(difficulty, playerCount);
  }
  if (sel === 'ai-random') {
    return new WeightedRandomAgent({ id: `ai-random-${color}` });
  }
  return new LocalHumanAgent({ id: `human-${color}`, label: `${color} (human)` });
}

export default function App() {
  const [activeView, setActiveView] = useState<View>('play');

  const config = useMemo<GameConfig>(
    () => ({ playerColors: ['cyan', 'yellow'], boardSize: 2 }),
    [],
  );

  // Which agent plays each seat. Defaults to two local humans.
  const [agentSel, setAgentSel] = useState<Record<string, string>>({
    cyan: 'human-loc',
    yellow: 'human-loc',
  });

  const agents = useMemo(() => {
    const map: AgentMap = {};
    for (const c of config.playerColors) {
      map[c] = makeAgent(c, agentSel[c] ?? 'human-loc', config.playerColors.length);
    }
    return map;
  }, [config, agentSel]);

  const pattern = useMemo<ArrowColor[]>(
    () => Array.from({ length: 8 }, () => (Math.random() < 0.5 ? 'b' : 'w')),
    [],
  );

  // Rebuilds when the agent map changes -> selecting an agent for a seat starts a new game.
  const orch = useMemo(
    () => new GameOrchestrator({ config, agents, pathPattern: pattern, turnDelayMs: TURN_DELAY_MS }),
    [config, agents, pattern],
  );

  // Dispose the PREVIOUS orchestrator when a seat change replaces it: stops its play
  // loop, aborts a parked turn, terminates its worker agents. Deliberately NOT an
  // effect-cleanup on `orch` itself — StrictMode's double-invoked cleanup would
  // dispose the live orchestrator.
  const prevOrch = useRef<GameOrchestrator | null>(null);
  useEffect(() => {
    if (prevOrch.current && prevOrch.current !== orch) prevOrch.current.dispose();
    prevOrch.current = orch;
  }, [orch]);

  return (
    <div className="App">
      <Header
        activeView={activeView}
        onNavigate={setActiveView}
        onPlay={() => void orch.play()}
        onPause={() => orch.pause()}
        onStep={() => {
          // If a loop is running, pausing makes the in-flight turn the "step";
          // step() itself only advances when idle (it throws mid-flight — swallowed).
          orch.pause();
          void orch.step().catch(() => { });
        }}
        onReset={() => orch.reset()}
      />
      <main>
        {activeView === 'play' && (
          <PlayView
            orchestrator={orch}
            onAgentChange={(color, sel) =>
              setAgentSel((prev) => ({ ...prev, [color]: sel }))
            }
          />
        )}
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
