/**
 * Finity — Game Record Builder
 *
 * Converts a parsed BGA log + its cone pattern into a `GameRecord` (the format
 * we persist for ML training / replay). The move list and final state are
 * produced by replaying through the engine, so the record is engine-faithful:
 * applying `record.moves` from `record.initialState` reproduces the validated
 * final state. Per-move timestamps come from the log (best-effort).
 *
 */

import type {
    ArrowColor,
    PlayerColor,
    GameRecord,
    RecordedMove,
    GameResult,
    AgentInfo,
    GameConfig,
} from '@finity/engine';
import { createGame, applyMove } from '@finity/engine';
import { toMoveAction, type ParsedGame } from './game-log-parser';

export interface ToGameRecordOptions {
    gameId: string;
    /** Defaults to ['cyan','yellow']; first mover maps to index 0 (N start). */
    playerColors?: PlayerColor[];
    source?: string;
}

export function toGameRecord(
    game: ParsedGame,
    pattern: ArrowColor[],
    opts: ToGameRecordOptions,
): GameRecord {
    const playerColors = opts.playerColors ?? ['cyan', 'yellow'];
    const boardSize = playerColors.length as 2 | 3 | 4;
    const config: GameConfig = { playerColors, boardSize };

    const colorOf = new Map<string, PlayerColor>();
    game.players.forEach((p, i) => colorOf.set(p, playerColors[i]));

    const initialState = createGame(config, pattern);
    let state = initialState;

    const moves: RecordedMove[] = [];
    for (let i = 0; i < game.moves.length; i++) {
        const pm = game.moves[i];
        const color = colorOf.get(pm.player)!;
        const move = toMoveAction(pm.action, color, state);
        moves.push({ move, color, timestamp: pm.timestamp ?? 0, moveIndex: i });
        state = applyMove(state, move); // immutable: initialState stays untouched
    }
    const finalState = state;

    const agents = {} as Record<PlayerColor, AgentInfo>;
    game.players.forEach((p, i) => {
        agents[playerColors[i]] = { id: `bga:${p}`, type: 'human-remote', label: p, author: p };
    });

    const stamps = game.moves
        .map(m => m.timestamp)
        .filter((t): t is number => typeof t === 'number' && t > 0);
    const firstTs = stamps.length ? stamps[0] : Date.now();
    const lastTs = stamps.length ? stamps[stamps.length - 1] : firstTs;

    const result: GameResult | null = game.winner
        ? {
              winners: finalState.winners.slice(),
              reason: 'path_complete',
              finalState,
              totalMoves: moves.length,
              durationMs: Math.max(0, lastTs - firstTs),
          }
        : null;

    return {
        version: 1,
        gameId: opts.gameId,
        timestamp: firstTs,
        config,
        pathPattern: pattern,
        initialState,
        agents,
        moves,
        result,
        metadata: { source: opts.source ?? 'bga', players: game.players, winnerName: game.winner },
    };
}
