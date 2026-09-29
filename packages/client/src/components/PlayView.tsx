//  Play screen wiring. Restores the ORIGINAL intended layout that App.css
// styles: #game_container is a flex row with #players_1_3 (left column) | #finity
// (board) | #players_2_4 (right column). Play/pause/step/reset live in the Header
// (wired at App level), so this view no longer renders its own controls bar.
//
// Clickability: FinityCanvas reports a pixel (x,y). We snap it to the nearest
// currently-SELECTABLE target (via boardHitTest) and feed that to the input handler.
// The board highlights those selectable targets so the player can aim.

import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import type { ArrowColor, GameConfig, PlayerColor, MoveAction } from '@finity/engine';
import { LocalHumanAgent, type PlayerAgent } from '@finity/agents';
import { GameOrchestrator, type AgentMap } from '../orchestrator';
import { useOrchestrator } from '../hooks/useOrchestrator';
import { computeLayout } from '../rendering/layout';
import { nearestTarget } from '../rendering/boardHitTest';
import type { MoveCategory } from '../rendering/moveInputHandler';

import FinityCanvas from './FinityCanvas';
import PlayerPanel from './PlayerPanel';
import MoveLog from './MoveLog';
import { positionAt, historyLabel, type ViewIndex } from '../historyNav';
import { generatePathPattern } from '@finity/engine';
import { boardMarks } from '../rendering/moveMarks';

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
  viewIndex?: ViewIndex;
  onAgentChange?: (color: PlayerColor, sel: string) => void;
  /** Show an earlier position (null = live). App owns the view so the Header can drive it. */
  onViewIndexChange?: (view: ViewIndex) => void;
}

/** PlayerPanel's move-type dropdown -> input category filter (+ arrow color). */
const MOVE_TYPE_TO_FILTER: Record<string, { cat: MoveCategory | null; arrowColor?: ArrowColor }> = {
  select: { cat: null },
  'b-arrow': { cat: 'arrow', arrowColor: 'b' },
  'w-arrow': { cat: 'arrow', arrowColor: 'w' },
  ring: { cat: 'ring' },
  'base-post': { cat: 'basePost' },
  blocker: { cat: 'blocker' },
  'rev-arrow': { cat: 'reverse' },
  'rem-arrow': { cat: 'remove' },
  'opp-blocker': { cat: 'remove' },
};

/** Human-readable name for the active filter, used in feedback messages. */
const MOVE_TYPE_LABEL: Record<string, string> = {
  'b-arrow': 'black-arrow placement',
  'w-arrow': 'white-arrow placement',
  ring: 'ring placement',
  'base-post': 'base-post move',
  blocker: 'blocker move',
  'rev-arrow': 'arrow reversal',
  'rem-arrow': 'arrow removal',
  'opp-blocker': 'blocker removal',
};

const MSG_DISMISS_MS = 2600;

export function PlayView({ orchestrator, config, agents, pathPattern, viewIndex, onAgentChange, onViewIndexChange }: PlayViewProps) {
  const orch = useMemo(() => {
    if (orchestrator) return orchestrator;
    if (!config || !agents) throw new Error('PlayView needs either an orchestrator or config+agents');
    return new GameOrchestrator({ config, agents, pathPattern: pathPattern ?? generatePathPattern() });
  }, [orchestrator, config, agents, pathPattern]);

  const { state, currentColor, isOver, result, isAwaitingHumanInput, input } = useOrchestrator(orch);

  // An earlier position, when stepping back through history
  const viewed = useMemo(
    () => (viewIndex == null ? null : positionAt(orch.getInitialState(), state.moveHistory, viewIndex)),
    [orch, viewIndex, state.moveHistory],
  );

  const [hoveredMove, setHoveredMove] = useState<MoveAction | null>(null);
  useEffect(() => setHoveredMove(null), [orch]);

  // The move that produced the position on screen: the live last move, or,
  // when viewing history, the move that led to that earlier position.
  const shown = viewed ?? state;
  const lastMove = shown.moveHistory[shown.moveHistory.length - 1]?.move;
  const moveMarks = useMemo(() => boardMarks(lastMove, hoveredMove), [lastMove, hoveredMove]);

  const [delay, setDelay] = useState(() => orch.getTurnDelay());
  useEffect(() => setDelay(orch.getTurnDelay()), [orch]);

  const historyMsg = historyLabel(viewIndex ?? null, state.moveHistory.length);

  // click handler is bound once, so it reads the view through a ref
  const viewIndexRef = useRef(viewIndex);
  viewIndexRef.current = viewIndex;

  // Same geometry the renderer uses, so pixel clicks line up with drawn pieces.
  const layout = useMemo(() => computeLayout(state.config.boardSize), [state.config.boardSize]);

  // Games start PAUSED - nothing moves until the Header's "Play" button is pressed
  useEffect(() => () => orch.pause(), [orch]);

  // Use re-apply the seat's filter after the input handler's per-turn refresh
  // otherwise the dropdown would SAY "Place Ring" while the filter had been reset
  const [moveTypeBySeat, setMoveTypeBySeat] = useState<Partial<Record<PlayerColor, string>>>({});

  // Transient feedback for invalid clicks ("no legal move there", "press play ..")
  const [inputMsg, setInputMsg] = useState<string | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((msg: string) => {
    setInputMsg(msg);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setInputMsg(null), MSG_DISMISS_MS);
  }, []);

  useEffect(() => () => {
    if (msgTimer.current) clearTimeout(msgTimer.current);
  }, []);

  const applyFilterForSeat = useCallback((color: PlayerColor) => {
    const mt = moveTypeBySeat[color] ?? 'select';
    const f = MOVE_TYPE_TO_FILTER[mt] ?? { cat: null };
    input.setCategoryFilter(f.cat, { arrowColor: f.arrowColor ?? null });
  }, [input, moveTypeBySeat]);

  // The hook's effect call input.refresh() which resets the filter whenever a human turn starts or the state
  // changes mid-turn
  useEffect(() => {
    if (isAwaitingHumanInput) applyFilterForSeat(currentColor);
  }, [isAwaitingHumanInput, currentColor, state, applyFilterForSeat]);

  const phase = input.getPhase();
  const highlights = isAwaitingHumanInput ? input.selectableTargets() : [];

  // Persistent hint when the chosen move type has NO legal moves this turn
  const activeMoveType = isAwaitingHumanInput ? (moveTypeBySeat[currentColor] ?? 'select') : 'select';
  const filterHasNoMoves = isAwaitingHumanInput && input.getCategoryFilter() !== null && highlights.length === 0;
  const persistentHint = filterHasNoMoves
    ? `No legal ${MOVE_TYPE_LABEL[activeMoveType] ?? 'move'} available - choose another move type.`
    : null;
  const carryHint = phase.phase === 'carrying'
    ? 'Carrying a blocker: click a highlighted slot to drop it, or click it again to put it back.'
    : null;

  // use escape key to cancel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') input.cancelSelection(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [input]);

  // Stable click handler: reads the LATEST state/agent through the (stable) orchestrator,
  // because FinityCanvas binds its mouse handler once in setup().
  const handleCanvasClick = useCallback(
    (x: number, y: number) => {
      if (viewIndexRef.current != null) {
        flash('Viewing an earlier position. Press ⏭ to return to the live game. ');
        return;
      }
      if (orch.isOver()) return;
      const color = orch.currentColor();
      const agent = orch.agentFor(color);
      if (!(agent instanceof LocalHumanAgent && agent.isAwaitingInput())) {
        if (orch.getPlayMode() === 'paused') flash('Game is paused - press Play button to play.');
        else flash(`Waiting for ${color} to move.`);
        return;
      }
      // aiming: a click anywhere places the arrow the ghost shows
      if (input.getPhase().phase === 'aiming') {
        if (!input.confirmAim()) flash('Point toward the station the arrow should point at, then click.');
        return;
      }

      const target = nearestTarget(x, y, input.selectableTargets(), layout, SNAP_RADIUS);
      if (!target || !input.selectTarget(target)) {
        if (input.getPhase().phase === 'carrying') {
          flash('Drop the blocker on a highlighted slot, or click it again to put it back.');
          return;
        }
        const mt = moveTypeBySeat[color] ?? 'select';
        const what = MOVE_TYPE_LABEL[mt];
        flash(
          what
            ? `Not a legal ${what} target - the highlighted circles show where you can play.`
            : 'No legal move there - the highlighted circles show where you can play.'
        );

        return;
      }
      setInputMsg(null); // a valid selection clears any stale message
    },
    [orch, input, layout, moveTypeBySeat, flash],
  );

  // while carrying a blocker or aiming an arrow, the ghost follows the pointer
  const handleCanvasMouseMove = useCallback((x: number, y: number) => {
    if (viewIndexRef.current != null) return;
    const ph = input.getPhase();
    if (ph.phase === 'carrying') {
      input.hoverTarget(nearestTarget(x, y, input.selectableTargets(), layout, SNAP_RADIUS));
    } else if (ph.phase === 'aiming') {
      // point toward whichever of the slot's two stations the pointer is nearer
      const [a, b] = ph.stations;
      const pa = layout.stationPositions[a];
      const pb = layout.stationPositions[b];

      if (pa && pb) {
        const da = (x - pa[0]) ** 2 + (y - pa[1]) ** 2;
        const db = (x - pb[0]) ** 2 + (y - pb[1]) ** 2;
        input.aimToward(da <= db ? a : b);
      }
    }
  }, [input, layout]);

  const handleMoveSelect = (color: PlayerColor, moveType: string) => {
    if (moveType === 'concede') {
      orch.concede(color);
      return;
    }
    setMoveTypeBySeat((prev) => ({ ...prev, [color]: moveType }));
    setInputMsg(null);
    const f = MOVE_TYPE_TO_FILTER[moveType] ?? { cat: null };
    input.setCategoryFilter(f.cat, { arrowColor: f.arrowColor ?? null });
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
      moveType={moveTypeBySeat[color] ?? 'select'}
      onMoveSelect={handleMoveSelect}
      onAgentChange={onAgentChange}
    />
  );

  return (
    <div className="play-view">
      <div id="game_container">
        <div id="players_1_3">{left.map(panel)}</div>

        <div id="finity">
          {(historyMsg ?? inputMsg ?? carryHint ?? persistentHint) && (
            <div className="finity-input-msg" role="status">
              {historyMsg ?? inputMsg ?? carryHint ?? persistentHint}
            </div>
          )}
          <FinityCanvas
            gameState={viewed ?? state}
            layout={layout}
            onCanvasClick={handleCanvasClick}
            onCanvasMouseMove={handleCanvasMouseMove}
            movePreview={viewed ? null : input.preview()}
            highlightTargets={viewed ? [] : highlights}
            moveMarks={moveMarks}
          />

          {phase.phase === 'disambiguating' && !viewed && (
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

          {phase.phase === 'aiming' && !viewed && (
            <div className="finity-disambig" role="dialog" aria-label="Aim arrow">
              <span>Point toward where the arrow should go, then click the board.</span>
              {input.aimColors().length > 1 && input.aimColors().map((c) => (
                <button key={c} type="button" aria-pressed={phase.color === c}
                  onClick={() => input.setAimColor(c)}>
                  {c === 'b' ? 'Black' : 'White'}
                </button>
              ))}
              {phase.others.map((opt) => (
                <button key={opt.id} type="button" onClick={() => input.selectAimOption(opt.id)}>
                  {opt.label}
                </button>
              ))}
              <button type="button" onClick={() => input.cancelSelection()}>Cancel</button>
            </div>
          )}

          {isOver && result && (
            <div className="finity-result" role="status">
              {result.winners.length > 0
                ? `${result.winners.join(', ')} wins (${result.reason})`
                : `Game over: ${result.reason}`}
            </div>
          )}
          <MoveLog
            orchestrator={orch}
            onHover={setHoveredMove}
            onSelect={(moveIndex) => {
              const next = moveIndex + 1;
              onViewIndexChange?.(next >= state.moveHistory.length ? null : next);
            }}
            viewedMoveIndex={viewIndex == null ? null : viewIndex - 1}
          />
          <label className='turn-delay'>
            AI move delay
            <input
              type="range" min={0} max={2000} step={100} value={delay}
              onChange={(e) => {
                const ms = Number(e.target.value);
                setDelay(ms);
                orch.setTurnDelay(ms);
              }}
            />
            <span>{(delay / 1000).toFixed(1)} s</span>
          </label>
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
