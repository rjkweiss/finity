// one entry point for built-in AI opponents.
//
//   createBuiltinAgent('easy', 2)   -> MinimaxAgent, one move deep, no threat checks
//   createBuiltinAgent('medium', 2) -> MinimaxAgent, two moves deep, all checks
//   createBuiltinAgent('medium', 3) -> MCTSAgent (3-4 player: sampling)
//
// There is one 2-player search agent (the race minimax in ai-minimax.ts);
// difficulty only changes how far ahead it looks and which checks it runs.
// Measured (8-game paired matches): Medium beat Easy 5-0 with 3 unfinished;
// Easy beat the previous Easy 8-0. Deeper than 2 plies was not stronger in
// agent-vs-agent play, so Medium searches exactly 2.
// 'hard' is reserved for the learned agents (RL / GNN). Until one exists the
// UI shows it as "coming soon" and disabled, and if it is requested anyway
// (self-play specs, older saved settings) it builds the medium agent.
//
// Budgets are conservative; the client runs these in a Web Worker
// (search_worker.ts), so they can grow. Iterative deepening (minimax) and the
// time budget (MCTS) guarantee a legal move before the deadline.

import type { PlayerAgent } from './interface';
import { MinimaxAgent } from './ai-minimax';
import { MCTSAgent } from './ai-mcts';
import { seededRng } from './ai-common';

export type Difficulty = 'easy' | 'medium' | 'hard';

interface Budget {
    /** Minimax search depth: easy looks one move ahead. */
    maxDepth: number;
    minDepth: number;
    /** Check one-move wins and threats at the horizon (easy: off, so it misses some). */
    threatCheck: boolean;
    /** Play the two-move opening plan (easy: off). */
    opening: boolean;
    /** Per-move wall-clock budget (both agents). */
    timeMs: number;
    /** MCTS rollout truncation depth (3-4 player). */
    rolloutDepth: number;
}

const BUDGETS: Record<Difficulty, Budget> = {
    easy: { maxDepth: 1, minDepth: 1, threatCheck: false, opening: false, timeMs: 300, rolloutDepth: 4 },
    medium: { maxDepth: 2, minDepth: 2, threatCheck: true, opening: true, timeMs: 1000, rolloutDepth: 6 },
    // reserved for the learned agent; not used until it exists
    hard: { maxDepth: 4, minDepth: 3, threatCheck: true, opening: true, timeMs: 2500, rolloutDepth: 8 },
};

/**
 * Build a built-in agent tuned to the table size and difficulty.
 * 2-player uses the minimax agent at the difficulty's depth; 3-4 player uses
 * MCTS (minimax's two-sided assumption doesn't hold with three-plus
 * independent opponents, and the minimax agent is 2-player only).
 */
export function createBuiltinAgent(
    difficulty: Difficulty,
    playerCount: number,
    seed?: number,
): PlayerAgent {
    // 'hard' is coming soon: build the medium agent until it exists
    const level: Difficulty = difficulty === 'hard' ? 'medium' : difficulty;
    const b = BUDGETS[level];
    const s = seed ?? (Math.random() * 2 ** 32) >>> 0;

    if (playerCount <= 2) {
        return new MinimaxAgent({
            id: `ai-minimax-${level}`,
            label: `Minimax (${level})`,
            maxDepth: b.maxDepth,
            minDepth: b.minDepth,
            threatCheck: b.threatCheck,
            opening: b.opening,
            timeMs: b.timeMs,
            seed: s,
        });
    }

    return new MCTSAgent({
        id: `ai-mcts-${level}`,
        label: `MCTS (${level})`,
        timeMs: b.timeMs,
        rolloutDepth: b.rolloutDepth,
        rng: seededRng(s),
    });
}
