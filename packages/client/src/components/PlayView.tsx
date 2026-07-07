// packages/client/src/components/PlayView.tsx
//
// STEP 8 — Play screen wiring. Restores the ORIGINAL intended layout that App.css
// styles: #game_container is a flex row with #players_1_3 (left column) | #finity
// (board) | #players_2_4 (right column). Play/pause/step/reset live in the Header
// (wired at App level), so this view no longer renders its own controls bar.
//
// Clickability: FinityCanvas reports a pixel (x,y). We snap it to the nearest
// currently-SELECTABLE target (via boardHitTest) and feed that to the input handler.
// The board highlights those selectable targets so the player can aim.

import { useCallback, useEffect, useMemo } from 'react';
import type { ArrowColor, GameConfig, PlayerColor } from '@finity/engine';
import { LocalHumanAgent, type PlayerAgent } from '@finity/agents';
import { GameOrchestrator, type AgentMap } from '../orchestrator';
import { useOrchestrator } from '../hooks/useOrchestrator';
import { computeLayout } from '../rendering/layout';
import { nearestTarget } from '../rendering/boardHitTest';
import type { MoveCategory } from '../rendering/moveInputHandler';

import FinityCanvas from './FinityCanvas';
import PlayerPanel from './PlayerPanel';

/** Click tolerance in px. Slots (L/C/R channels) sit ~30px apart, so keep this modest
 *  and rely on snapping to the nearest *legal* target. Tune to taste. */
const SNAP_RADIUS = 45;

export interface PlayViewProps {
  /** Pass an orchestrator in (App owns it so the Header can drive controls), OR pass
   *  config+agents to have PlayView build one for standalone use. */
  orchestrator?: GameOrchestrator;
  config?: GameConfig;
  agents?: AgentMap;
  pathPattern?: ArrowColor[];
}

/** The engine takes the cone pattern as input, so pattern generation is a client concern. */
function randomPattern(): ArrowColor[] {
  return Array.from({ length: 8 }, () => (Math.random() < 0.5 ? 'b' : 'w'));
}

/** PlayerPanel's move-type dropdown -> input category filter. */
const MOVE_TYPE_TO_CATEGORY: Record<string, MoveCategory | null> = {
  select: null,
  'b-arrow': 'arrow',
  'w-arrow': 'arrow',
  ring: 'ring',
  'base-post': 'basePost',
  blocker: 'blocker',
  'rev-arrow': 'reverse',
  'rem-arrow': 'remove',
  'opp-blocker': 'remove',
};

export function PlayView({ orchestrator, config, agents, pathPattern }: PlayViewProps) {
  const orch = useMemo(() => {
    if (orchestrator) return orchestrator;
    if (!config || !agents) throw new Error('PlayView needs either an orchestrator or config+agents');
    return new GameOrchestrator({ config, agents, pathPattern: pathPattern ?? randomPattern() });
  }, [orchestrator, config, agents, pathPattern]);

  const { state, currentColor, isOver, result, isAwaitingHumanInput, input } = useOrchestrator(orch);

  // Same geometry the renderer uses, so pixel clicks line up with drawn pieces.
  const layout = useMemo(() => computeLayout(state.config.boardSize), [state.config.boardSize]);

  // Kick off the turn loop; it parks on each human turn. Pause on unmount (e.g. tab away).
  useEffect(() => {
    void orch.play();
    return () => orch.pause();
  }, [orch]);

  const phase = input.getPhase();
  const highlights = isAwaitingHumanInput ? input.selectableTargets() : [];

  // Stable click handler: reads the LATEST state/agent through the (stable) orchestrator,
  // because FinityCanvas binds its mouse handler once in setup().
  const handleCanvasClick = useCallback(
    (x: number, y: number) => {
      const color = orch.currentColor();
      const agent = orch.agentFor(color);
      if (!(agent instanceof LocalHumanAgent && agent.isAwaitingInput())) return;
      const target = nearestTarget(x, y, input.selectableTargets(), layout, SNAP_RADIUS);
      if (target) input.selectTarget(target);
    },
    [orch, input, layout],
  );

  const handleMoveSelect = (color: PlayerColor, moveType: string) => {
    if (moveType === 'concede') {
      orch.abortCurrentTurn({ kind: 'resign', color });
      return;
    }
    input.setCategoryFilter(MOVE_TYPE_TO_CATEGORY[moveType] ?? null);
  };

  const colors = state.config.playerColors;
  const left = colors.filter((_, i) => i % 2 === 0);   // players 1 & 3
  const right = colors.filter((_, i) => i % 2 === 1);  // players 2 & 4

  const panel = (color: PlayerColor) => (
    <PlayerPanel
      key={color}
      color={color}
      isTurn={!isOver && color === currentColor}
      winners={state.winners}
      onMoveSelect={handleMoveSelect}
    />
  );

  return (
    <div className="play-view">
      <div id="game_container">
        <div id="players_1_3">{left.map(panel)}</div>

        <div id="finity">
          <FinityCanvas
            gameState={state}
            onCanvasClick={handleCanvasClick}
            highlightTargets={highlights}
          />

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

          {isOver && result && (
            <div className="finity-result" role="status">
              {result.winners.length > 0
                ? `${result.winners.join(', ')} wins (${result.reason})`
                : `Game over: ${result.reason}`}
            </div>
          )}
        </div>

        <div id="players_2_4">{right.map(panel)}</div>
      </div>
    </div>
  );
}

// Helper for the common case: two local humans on one device.
export function twoLocalHumans(playerColors: [PlayerColor, PlayerColor]): AgentMap {
  const map: AgentMap = {};
  const [a, b] = playerColors;
  map[a] = new LocalHumanAgent({ id: `human-${a}`, label: `${a} (human)` }) as PlayerAgent;
  map[b] = new LocalHumanAgent({ id: `human-${b}`, label: `${b} (human)` }) as PlayerAgent;
  return map;
}
