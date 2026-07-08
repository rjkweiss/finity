import { describe, it, expect } from 'vitest';
import {
    createGame,
    possibleMoves,
    type ArrowColor,
    type GameConfig,
    type PlayerColor,
    type FinityGameState,
} from '@finity/engine';
import { MinimaxAgent } from './ai-minimax';
import { MCTSAgent } from './ai-mcts';
import { createBuiltinAgent } from './ai-builtin';
import { MoveAbortedError, type MoveContext } from './interface';

const PATTERN: ArrowColor[] = ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'];
const CONFIG_2P: GameConfig = { playerColors: ['cyan', 'yellow'], boardSize: 2 };
const CONFIG_3P: GameConfig = { playerColors: ['cyan', 'yellow', 'red'], boardSize: 3 };

function liveCtx(moveIndex = 0): MoveContext {
    return { signal: new AbortController().signal, moveIndex };
}
function abortedCtx(): MoveContext {
    const ac = new AbortController();
    ac.abort({ kind: 'timeout' });
    return { signal: ac.signal, moveIndex: 0 };
}
function isLegal(move: unknown, state: FinityGameState, color: PlayerColor): boolean {
    return possibleMoves(state, color)
        .map((m) => JSON.stringify(m))
        .includes(JSON.stringify(move));
}

describe('MinimaxAgent (2-player)', () => {
    it('returns a legal move within a small budget', async () => {
        const state = createGame(CONFIG_2P, PATTERN);
        const agent = new MinimaxAgent({ maxDepth: 3, timeMs: 300 });
        const move = await agent.move('cyan', state, liveCtx());
        expect(isLegal(move, state, 'cyan')).toBe(true);
    });

    it('is deterministic given identical budgets', async () => {
        const state = createGame(CONFIG_2P, PATTERN);
        const a = new MinimaxAgent({ maxDepth: 2, timeMs: 500 });
        const b = new MinimaxAgent({ maxDepth: 2, timeMs: 500 });
        const ma = await a.move('cyan', state, liveCtx());
        const mb = await b.move('cyan', state, liveCtx());
        expect(JSON.stringify(ma)).toEqual(JSON.stringify(mb));
    });

    it('rejects a pre-aborted move', async () => {
        const state = createGame(CONFIG_2P, PATTERN);
        const agent = new MinimaxAgent({ maxDepth: 4, timeMs: 2000 });
        await expect(agent.move('cyan', state, abortedCtx())).rejects.toBeInstanceOf(MoveAbortedError);
    });
});

describe('MCTSAgent (3-player)', () => {
    it('returns a legal move within a small budget', async () => {
        const state = createGame(CONFIG_3P, PATTERN);
        const agent = new MCTSAgent({ timeMs: 300, rolloutDepth: 20 });
        const move = await agent.move('cyan', state, liveCtx());
        expect(isLegal(move, state, 'cyan')).toBe(true);
    });

    it('rejects a pre-aborted move', async () => {
        const state = createGame(CONFIG_3P, PATTERN);
        const agent = new MCTSAgent({ timeMs: 500 });
        await expect(agent.move('cyan', state, abortedCtx())).rejects.toBeInstanceOf(MoveAbortedError);
    });
});

describe('createBuiltinAgent', () => {
    it('uses minimax for 2 players and MCTS for 3-4', () => {
        expect(createBuiltinAgent('medium', 2)).toBeInstanceOf(MinimaxAgent);
        expect(createBuiltinAgent('medium', 3)).toBeInstanceOf(MCTSAgent);
        expect(createBuiltinAgent('hard', 4)).toBeInstanceOf(MCTSAgent);
    });

    it('produces an agent that returns a legal move', async () => {
        const state = createGame(CONFIG_2P, PATTERN);
        const agent = createBuiltinAgent('easy', 2);
        const move = await agent.move('cyan', state, liveCtx());
        expect(isLegal(move, state, 'cyan')).toBe(true);
    });
});
