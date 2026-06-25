/**
 * Finity — Replay Validator (engine lock-down harness)
 *
 * Replays a parsed BGA game through the engine using its scraped cone pattern
 * and asserts that every logged orphan event and the final winner are
 * reproduced. This is the strongest engine check available: it validates
 * `clearOrphans` and `checkVictory` against real games, move for move.
 *
 */

import type { ArrowColor, PlayerColor } from '@finity/engine';
import { createGame, applyMove, ringCount, hasFullPath } from '@finity/engine';
import { parseGameLog, toMoveAction, type ParsedGame } from './game-log-parser';
import { parsePathPatterns } from './path-pattern-parser';

export interface ValidationReport {
    ok: boolean;
    failures: string[];
    winner: string | null;
    winnerFired: boolean;
    winnerRings: number;
}

/**
 * Replay one game with a known pattern and validate against its own annotations.
 */
export function validateReplay(
    game: ParsedGame,
    pattern: ArrowColor[],
    playerColors: [PlayerColor, PlayerColor] = ['cyan', 'yellow'],
): ValidationReport {
    const colorOf = new Map<string, PlayerColor>();
    game.players.forEach((p, i) => colorOf.set(p, playerColors[i])); // first mover -> [0] (@N)

    let state = createGame({ playerColors, boardSize: 2 }, pattern);
    const failures: string[] = [];
    const [c0, c1] = playerColors;

    for (const mv of game.moves) {
        const color = colorOf.get(mv.player)!;
        const before0 = ringCount(state, c0);
        const before1 = ringCount(state, c1);

        state = applyMove(state, toMoveAction(mv.action, color, state));

        const removed: Record<PlayerColor, number> = {
            [c0]: Math.max(0, before0 - ringCount(state, c0)),
            [c1]: Math.max(0, before1 - ringCount(state, c1)),
        } as Record<PlayerColor, number>;

        if (mv.orphanedRings) {
            const oc = colorOf.get(mv.orphanedRings.player)!;
            const other = oc === c0 ? c1 : c0;
            if (removed[oc] !== mv.orphanedRings.count || removed[other] !== 0) {
                failures.push(
                    `move ${mv.moveNumber} (${mv.action.kind}): log ${mv.orphanedRings.player}=${mv.orphanedRings.count}, engine ${oc}=${removed[oc]} ${other}=${removed[other]}`,
                );
            }
        } else if (removed[c0] || removed[c1]) {
            failures.push(`move ${mv.moveNumber} (${mv.action.kind}): unexpected orphan removal ${JSON.stringify(removed)}`);
        }
    }

    const winnerColor = game.winner ? colorOf.get(game.winner) : undefined;
    const winnerFired = !!winnerColor && state.winners.includes(winnerColor);
    if (game.winner && !winnerFired) {
        failures.push(
            `winner ${game.winner} (${winnerColor}) not registered: winners=[${state.winners}] ` +
            `rings=${winnerColor ? ringCount(state, winnerColor) : '?'} fullPath=${winnerColor ? hasFullPath(state, winnerColor) : '?'}`,
        );
    }

    return {
        ok: failures.length === 0,
        failures,
        winner: game.winner,
        winnerFired,
        winnerRings: winnerColor ? ringCount(state, winnerColor) : 0,
    };
}

/**
 * Convenience: validate a game given its raw log text and the parsed pattern map.
 */
export function validateGameById(
    gameId: string,
    logText: string,
    patternsText: string,
): ValidationReport {
    const game = parseGameLog(logText);
    const pattern = parsePathPatterns(patternsText).get(gameId);
    if (!pattern) {
        return { ok: false, failures: [`no scraped pattern for game ${gameId}`], winner: game.winner, winnerFired: false, winnerRings: 0 };
    }
    return validateReplay(game, pattern);
}
