import { describe, it, expect } from 'vitest';
import { createGame, possibleMoves, type ArrowColor, type GameConfig } from '@finity/engine';
import { RandomAgent, WeightedRandomAgent } from './ai-random';
import { MoveAbortedError, type MoveContext } from './interface';
import { seededRng, moveCategory } from './ai-common';

const CONFIG: GameConfig = { playerColors: ['cyan', 'yellow'], boardSize: 2 };
const PATTERN: ArrowColor[] = ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'];

function ctx(signal: AbortSignal, moveIndex = 0): MoveContext {
    return { signal, moveIndex };
}
function liveCtx(): MoveContext {
    return ctx(new AbortController().signal);
}
function isLegal(move: unknown, state: ReturnType<typeof createGame>, color: 'cyan' | 'yellow'): boolean {
    const legal = possibleMoves(state, color).map((m) => JSON.stringify(m));
    return legal.includes(JSON.stringify(move));
}

describe('RandomAgent (uniform)', () => {
    it('returns a legal move', async () => {
        const state = createGame(CONFIG, PATTERN);
        const agent = new RandomAgent({ rng: seededRng(1) });
        const move = await agent.move('cyan', state, liveCtx());
        expect(isLegal(move, state, 'cyan')).toBe(true);
    });

    it('rejects when the signal is already aborted', async () => {
        const state = createGame(CONFIG, PATTERN);
        const ac = new AbortController();
        ac.abort({ kind: 'new-game' });
        const agent = new RandomAgent();
        await expect(agent.move('cyan', state, ctx(ac.signal))).rejects.toBeInstanceOf(MoveAbortedError);
    });

    it('is deterministic under a seeded rng', async () => {
        const state = createGame(CONFIG, PATTERN);
        const a = new RandomAgent({ rng: seededRng(42) });
        const b = new RandomAgent({ rng: seededRng(42) });
        const ma = await a.move('cyan', state, liveCtx());
        const mb = await b.move('cyan', state, liveCtx());
        expect(JSON.stringify(ma)).toEqual(JSON.stringify(mb));
    });
});

describe('WeightedRandomAgent', () => {
    it('returns a legal move', async () => {
        const state = createGame(CONFIG, PATTERN);
        const agent = new WeightedRandomAgent({ rng: seededRng(7) });
        const move = await agent.move('cyan', state, liveCtx());
        expect(isLegal(move, state, 'cyan')).toBe(true);
    });

    it('favors rings over the long run when rings are available', async () => {
        const state = createGame(CONFIG, PATTERN);
        // Only run the bias check if the opening actually offers both a ring and
        // a non-ring move, so the test is meaningful.
        const cats = new Set(possibleMoves(state, 'cyan').map(moveCategory));
        if (!cats.has('ring') || cats.size < 2) return;
        const agent = new WeightedRandomAgent({ rng: seededRng(99) });
        let rings = 0;
        const N = 200;
        for (let i = 0; i < N; i++) {
            const m = await agent.move('cyan', state, liveCtx());
            if (moveCategory(m) === 'ring') rings++;
        }
        // Weighted heavily toward rings; expect a clear majority.
        expect(rings).toBeGreaterThan(N / 2);
    });
});
