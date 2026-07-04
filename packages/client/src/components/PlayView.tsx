// packages/client/src/components/PlayView.tsx
//
// STEP 8 — The first visible layer. Pure wiring: consumes useOrchestrator and routes
// data to the REAL FinityCanvas + PlayerPanel. It owns NO game logic.
//
// Reconciled against the actual components (FinityCanvas.tsx, PlayerPanel.tsx):
//   - FinityCanvas takes `gameState` + pixel `onCanvasClick(x,y)`; it does NOT take
//     legal-move highlights. Highlighting legal targets needs DisplayHandler support
//     (out of scope here) — see notes.
//   - PlayerPanel takes `isTurn` + `winners`; its move-type dropdown maps onto
//     input.setCategoryFilter, and "Concede" maps onto controls.resign.
//
// ONE SEAM REMAINS UNBUILT — [SEAM-HITTEST]:
//   The canvas reports a pixel (x,y). Turning that into a BoardTarget (which station /
//   which slot was clicked) needs the board geometry in rendering/layout.ts. That file
//   wasn't available here, so the hit-test is INJECTED as a prop. Implement it in the
//   layout layer (it already has computeLayout) and pass it in.

import { useCallback, useMemo } from 'react';
import type { ArrowColor, FinityGameState, GameConfig, PlayerColor } from '@finity/engine';
import { LocalHumanAgent } from '@finity/agents';
import { GameOrchestrator, type AgentMap } from '../orchestrator';
import { useOrchestrator } from '../hooks/useOrchestrator';
import type { BoardTarget, MoveCategory } from '../rendering/moveInputHandler';

import FinityCanvas from './FinityCanvas';
import PlayerPanel from './PlayerPanel';

/** Resolves a canvas pixel to a board target. Implement against rendering/layout.ts. */
export type BoardHitTester = (x: number, y: number, state: FinityGameState) => BoardTarget | null;

export interface PlayViewProps {
  /** Pass an orchestrator in, OR pass config+agents to have PlayView build one. */
  orchestrator?: GameOrchestrator;
  config?: GameConfig;
  agents?: AgentMap;
  /** The 8-cone pattern. The engine does NOT generate it; if omitted, PlayView makes a
   *  random one. For replaying a known game, pass the recorded pattern. */
  pathPattern?: ArrowColor[];
  /** [SEAM-HITTEST] pixel -> BoardTarget. Until provided, board clicks are ignored. */
  hitTest?: BoardHitTester;
}

/** The engine takes the cone pattern as input, so pattern generation is a client concern. */
function randomPattern(): ArrowColor[] {
  return Array.from({ length: 8 }, () => (Math.random() < 0.5 ? 'b' : 'w'));
}

/** PlayerPanel's move-type dropdown -> MoveInputHandler category filter. */
const MOVE_TYPE_TO_CATEGORY: Record<string, MoveCategory | null> = {
  select: null,
  'b-arrow': 'arrow', // color is chosen at the disambiguation step
  'w-arrow': 'arrow',
  ring: 'ring',
  'base-post': 'basePost',
  blocker: 'blocker',
  'rev-arrow': 'reverse',
  'rem-arrow': 'remove',
  'opp-blocker': 'remove',
};

export function PlayView({ orchestrator, config, agents, pathPattern, hitTest }: PlayViewProps) {
  const orch = useMemo(() => {
    if (orchestrator) return orchestrator;
    if (!config || !agents) throw new Error('PlayView needs either an orchestrator or config+agents');
    return new GameOrchestrator({ config, agents, pathPattern: pathPattern ?? randomPattern() });
  }, [orchestrator, config, agents, pathPattern]);

  const { state, currentColor, isOver, result, playMode, input, controls } = useOrchestrator(orch);
  const phase = input.getPhase();

  // Stable handler: reads the LATEST state/agent at click time. This matters because
  // FinityCanvas binds its mouse handler ONCE in setup() — a callback closing over a
  // state snapshot would go stale. Reading through the (stable) orchestrator avoids that.
  const handleCanvasClick = useCallback(
    (x: number, y: number) => {
      const color = orch.currentColor();
      const agent = orch.agentFor(color);
      const awaiting = agent instanceof LocalHumanAgent && agent.isAwaitingInput();
      if (!awaiting || !hitTest) return;
      const target = hitTest(x, y, orch.getState());
      if (target) input.selectTarget(target);
    },
    [orch, input, hitTest],
  );

  const handleMoveSelect = (color: PlayerColor, moveType: string) => {
    if (moveType === 'concede') {
      controls.resign(color);
      return;
    }
    input.setCategoryFilter(MOVE_TYPE_TO_CATEGORY[moveType] ?? null);
  };

  return (
    <div className="finity-play-view">
      <div className="finity-players">
        {state.config.playerColors.map((color) => (
          <PlayerPanel
            key={color}
            color={color}
            isTurn={!isOver && color === currentColor}
            winners={state.winners}
            onMoveSelect={handleMoveSelect}
          // onAgentChange is intentionally unwired here — switching an agent means
          // reconfiguring the orchestrator's agent map (a setup-screen / App concern,
          // and Phase 6 for custom agents). See notes.
          />
        ))}
      </div>

      <FinityCanvas gameState={state} onCanvasClick={handleCanvasClick} />

      {phase.phase === 'disambiguating' && (
        <div className="finity-disambig" role="dialog" aria-label="Choose move">
          {phase.options.map((opt) => (
            <button key={opt.id} type="button" onClick={() => input.selectOption(opt.id)}>
              {opt.label}
            </button>
          ))}
          <button type="button" onClick={() => input.cancelSelection()}>
            Cancel
          </button>
        </div>
      )}

      {/* NOTE: Header.tsx already owns play/pause/step/reset. If App wires Header to this
          orchestrator (lift the orchestrator to App and pass it via the `orchestrator`
          prop), drop this controls bar. Kept here so PlayView is usable standalone. */}
      <div className="finity-controls">
        {playMode === 'paused' ? (
          <button type="button" onClick={controls.play} disabled={isOver}>
            Play
          </button>
        ) : (
          <button type="button" onClick={controls.pause}>
            Pause
          </button>
        )}
        <button type="button" onClick={controls.step} disabled={isOver || playMode === 'playing'}>
          Step
        </button>
        <button type="button" onClick={controls.reset}>
          Reset
        </button>
      </div>

      {isOver && result && (
        <div className="finity-result" role="status">
          {result.winners.length > 0
            ? `${result.winners.join(', ')} wins (${result.reason})`
            : `Game over: ${result.reason}`}
        </div>
      )}
    </div>
  );
}

// Helper for the common case: two local humans on one device (step 9 playtest UI).
export function twoLocalHumans(playerColors: [PlayerColor, PlayerColor]): AgentMap {
  return {
    [playerColors[0]]: new LocalHumanAgent({ id: `human-${playerColors[0]}`, label: `${playerColors[0]} (human)` }),
    [playerColors[1]]: new LocalHumanAgent({ id: `human-${playerColors[1]}`, label: `${playerColors[1]} (human)` }),
  };
}
