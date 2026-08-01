// Gameplay-level coverage for 3- and 4-player boards. Topology tests verify the
// static tables; this verifies possibleMoves/applyMove actually respect the
// reduced station set during play (3-player has no W/E/FNE/FSE — a generated
// move referencing an absent station is a bug even if it never crashes).

import { describe, it, expect } from 'vitest';
import { createGame, applyMove, currentPlayer } from '../src/engine';
import { possibleMoves } from '../src/possible-moves';
import type { ArrowColor, FinityGameState, MoveAction, PlayerColor, StationName } from '../src/types';

const PATTERN: ArrowColor[] = ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'];
const SMOKE_MOVES = 150;

/** Every station a move touches, regardless of move shape. */
function stationsIn(move: MoveAction): StationName[] {
  const out: StationName[] = [];
  const p = move.pieceToAdd as { fromStation?: StationName; toStation?: StationName } | undefined;
  if (p?.fromStation) out.push(p.fromStation);
  if (p?.toStation) out.push(p.toStation);
  const r = move.pieceToRemove as { fromStation?: StationName; toStation?: StationName } | undefined;
  if (r?.fromStation) out.push(r.fromStation);
  if (r?.toStation) out.push(r.toStation);
  return out;
}

/** Deterministic "varied" agent: cycles through the legal-move list by move number
 *  so we exercise more branches than first-legal alone. */
function pickMove(state: FinityGameState, color: PlayerColor, i: number): MoveAction {
  const moves = possibleMoves(state, color);
  expect(moves.length).toBeGreaterThan(0);
  return moves[i % moves.length];
}

function smoke(playerColors: PlayerColor[], count: 2 | 3 | 4) {
  let state = createGame({ playerColors, boardSize: count }, PATTERN);
  const onBoard = new Set(Object.keys(state.board.stations));

  for (let i = 0; i < SMOKE_MOVES && state.playStatus === 'playing'; i++) {
    const color = currentPlayer(state);
    const moves = possibleMoves(state, color);
    for (const m of moves) {
      for (const st of stationsIn(m)) {
        expect(onBoard.has(st), `move ${i} offers absent station ${st}: ${JSON.stringify(m)}`).toBe(true);
      }
    }
    state = applyMove(state, pickMove(state, color, i));
  }
}

describe('multi-player gameplay smoke', () => {
  it('3-player: 150 moves, every offered move stays on the 10-station board', () => {
    smoke(['cyan', 'yellow', 'red'], 3);
  });

  it('4-player: 150 moves on the full 13-station board', () => {
    smoke(['cyan', 'yellow', 'red', 'purple'], 4);
  });

  it('3-player board is the 10-station triangle: excludes W/FNE/FSE, includes E corner', () => {
    const state = createGame({ playerColors: ['cyan', 'yellow', 'red'], boardSize: 3 }, PATTERN);
    for (const absent of ['W', 'FNE', 'FSE']) {
      expect(state.board.stations[absent as StationName]).toBeUndefined();
    }
    for (const present of ['E', 'FNW', 'FSW']) {
      expect(state.board.stations[present as StationName]).toBeDefined();
    }
    expect(Object.keys(state.board.stations)).toHaveLength(10);
  });
});
