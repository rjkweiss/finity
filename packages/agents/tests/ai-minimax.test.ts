import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyMove, createGame, legalMoves, type FinityGameState, type MoveAction, type PlayerColor } from '@finity/engine';
import { MinimaxAgent } from '../src//ai-minimax';

const FIXTURES = fileURLToPath(new URL('../../../tools/validate/fixtures', import.meta.url));
const haveFixtures = existsSync(FIXTURES);
const ctx = () => ({ signal: new AbortController().signal, moveIndex: 0 });

function position(gameId: string, move: number): { s: FinityGameState; side: PlayerColor } {
    const rec = JSON.parse(readFileSync(join(FIXTURES, `${gameId}.json`), 'utf8'));
    let s = createGame(rec.config, rec.pathPattern);
    for (let i = 0; i < move; i++) s = applyMove(s, rec.moves[i].move);
    return { s, side: rec.moves[move].color };
}

const opponentCanWin = (s: FinityGameState, opp: PlayerColor): boolean =>
    legalMoves(s, opp).some((m) => applyMove(s, m).winners.includes(opp));

describe('MinimaxAgent (race minimax)', () => {
    it('returns a legal move from the opening position', async () => {
        const s = createGame({ playerColors: ['cyan', 'yellow'], boardSize: 2 }, ['w', 'b', 'w', 'b', 'w', 'b', 'b', 'w']);
        const m: MoveAction = await new MinimaxAgent({ timeMs: 200 }).move('cyan', s, ctx());
        expect(legalMoves(s, 'cyan').some((x) => JSON.stringify(x) === JSON.stringify(m))).toBe(true);
    });

    it.skipIf(!haveFixtures)('plays the winning base relocation (189707486, move 37)', async () => {
        const { s, side } = position('189707486', 37);
        const m = await new MinimaxAgent({ timeMs: 300 }).move(side, s, ctx());
        expect(applyMove(s, m).winners).toContain(side);
    });

    it.skipIf(!haveFixtures)('stops a hidden relocation win (189707486, move 36)', async () => {
        const { s, side } = position('189707486', 36);
        const m = await new MinimaxAgent({ timeMs: 500 }).move(side, s, ctx());
        expect(opponentCanWin(applyMove(s, m), 'yellow')).toBe(false);
    });

    it.skipIf(!haveFixtures)('does not complete the opponent\'s path (189401145, move 61)', async () => {
        const { s, side } = position('189401145', 61);
        const after = applyMove(s, await new MinimaxAgent({ timeMs: 500 }).move(side, s, ctx()));
        expect(after.winners).not.toContain('cyan');
        expect(opponentCanWin(after, 'cyan')).toBe(false);
    });
});
