// one entry point for built-in AI opponents.
//
//   createBuiltinAgent('medium', 2) -> MinimaxAgent  (2-player: exact search)
//   createBuiltinAgent('medium', 3) -> MCTSAgent      (3-4 player: sampling)
//
// Budgets are intentionally conservative because these currently run on the
// caller's thread. Iterative deepening (minimax) and the time budget (MCTS)
// both guarantee a legal move is returned before the deadline. Moving the
// search into a Web Worker (v2) would let these budgets grow substantially.

import type { PlayerAgent } from './interface';
import { MinimaxAgent } from './ai-minimax';
import { MCTSAgent } from './ai-mcts';
import { seededRng } from './ai-common';

export type Difficulty = 'easy' | 'medium' | 'hard';

interface Budget {
    /** Minimax depth cap (2-player). */
    maxDepth: number;
    /** Per-move wall-clock budget (both agents). */
    timeMs: number;
    /** MCTS rollout truncation depth (3-4 player). */
    rolloutDepth: number;
}

const BUDGETS: Record<Difficulty, Budget> = {
    easy: { maxDepth: 2, timeMs: 300, rolloutDepth: 4 },
    medium: { maxDepth: 3, timeMs: 1000, rolloutDepth: 6 },
    hard: { maxDepth: 4, timeMs: 2500, rolloutDepth: 8 },
};

/**
 * Build a built-in agent tuned to the table size and difficulty.
 * 2-player uses exact alpha-beta minimax; 3-4 player uses MCTS (minimax's
 * two-sided assumption doesn't hold with three-plus independent opponents).
 */
export function createBuiltinAgent(
    difficulty: Difficulty,
    playerCount: number,
    seed?: number,
): PlayerAgent {
    const b = BUDGETS[difficulty];
    const s = seed ?? (Math.random() * 2 ** 32) >>> 0;

    if (playerCount <= 2) {
        return new MinimaxAgent({
            id: `ai-minimax-${difficulty}`,
            label: `Minimax (${difficulty})`,
            maxDepth: b.maxDepth,
            timeMs: b.timeMs,
            seed: s,
        });
    }

    return new MCTSAgent({
        id: `ai-mcts-${difficulty}`,
        label: `MCTS (${difficulty})`,
        timeMs: b.timeMs,
        rolloutDepth: b.rolloutDepth,
        rng: seededRng(s),
    });
}
