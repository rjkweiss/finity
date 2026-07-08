// multiplayer (3-4 player) agent.
//
// Monte-Carlo Tree Search with:
//   - UCT/UCB1 selection using per-player reward bookkeeping (each node tracks
//     reward for every player; the chooser at a node is its side-to-move)
//   - progressive widening (children unlocked as a node is visited more)
//   - truncated, category-weighted rollouts scored by the engine's `evaluate`
//   - a time/iteration budget, checked against ctx.signal and a deadline
//
// Rewards are shares in [0,1] summing to 1 across players, so wins, draws, and
// heuristic cutoffs live on the same scale
//
// DEFERRED FOR NOW (v2): RAVE/AMAF, a cross-search transposition table, and root
// parallelization. See createBuiltinAgent for difficulty budgets
// ALSO DEFERRED: using our existing game records to see agent's initial weights

import type { FinityGameState, MoveAction, PlayerColor, EvalWeights } from '@finity/engine';
import {
    possibleMoves,
    applyMove,
    currentPlayer,
    isGameOver,
    evaluate,
    DEFAULT_WEIGHTS,
} from '@finity/engine';
import type { PlayerAgent, MoveContext } from './interface';
import { IllegalMoveError } from './interface';
import {
    moveCategory,
    DEFAULT_CATEGORY_WEIGHTS,
    type CategoryWeights,
    weightedPick,
    defaultRng,
    type Rng,
    throwIfAborted,
} from './ai-common';

export interface MctsOptions {
    id?: string;
    label?: string;
    // Wall-clock budget per move in milliseconds
    timeMs?: number;
    // Hard cap on iterations regardless of time (safety net)
    maxIterations?: number;
    // Plies to simulate before truncating a rollout and scoring heuristically
    rolloutDepth?: number;
    // UCB1 exploration constant
    explore?: number;
    // Rollout policy weights
    weights?: CategoryWeights;
    // Evaluation weights for rollout scoring
    evalWeights?: EvalWeights;
    rng?: Rng;
}

type Reward = Partial<Record<PlayerColor, number>>;

interface MctsNode {
    state: FinityGameState;
    toMove: PlayerColor;
    parent: MctsNode | null;
    moveFromParent: MoveAction | null;
    children: MctsNode[];
    untried: MoveAction[];
    visits: number;
    reward: Reward; // accumulated per-player reward
}

const PW_K = 2; // progressive-widening base
const PW_ALPHA = 0.5; // progressive-widening exponent

export class MCTSAgent implements PlayerAgent {
    readonly id: string;
    readonly label: string;
    readonly description = 'Monte-Carlo Tree Search (multiplayer).';
    readonly author = 'built-in';
    readonly type = 'ai-builtin' as const;

    private readonly timeMs: number;
    private readonly maxIterations: number;
    private readonly rolloutDepth: number;
    private readonly explore: number;
    private readonly weights: CategoryWeights;
    private readonly evalWeights: EvalWeights;
    private readonly rng: Rng;

    constructor(opts: MctsOptions = {}) {
        this.id = opts.id ?? 'ai-mcts';
        this.label = opts.label ?? 'MCTS';
        this.timeMs = Math.max(1, opts.timeMs ?? 1000);
        this.maxIterations = Math.max(1, opts.maxIterations ?? 100_000);
        this.rolloutDepth = Math.max(1, opts.rolloutDepth ?? 30);
        this.explore = opts.explore ?? Math.SQRT2;
        this.weights = opts.weights ?? DEFAULT_CATEGORY_WEIGHTS;
        this.evalWeights = opts.evalWeights ?? DEFAULT_WEIGHTS;
        this.rng = opts.rng ?? defaultRng;
    }

    async move(color: PlayerColor, state: FinityGameState, ctx: MoveContext): Promise<MoveAction> {
        throwIfAborted(ctx);
        const rootMoves = possibleMoves(state, color);
        if (rootMoves.length === 0) {
            throw new IllegalMoveError(color, { type: 'remove' }, 'no legal moves available');
        }
        if (rootMoves.length === 1) return rootMoves[0];

        const root = this.makeNode(state, null, null);
        const deadline = Date.now() + this.timeMs;

        let iters = 0;
        while (iters < this.maxIterations && Date.now() < deadline) {
            throwIfAborted(ctx);
            const leaf = this.select(root);
            const expanded = this.expand(leaf);
            const reward = this.rollout(expanded.state, deadline);
            this.backpropagate(expanded, reward);
            iters++;
        }

        // Robust child: most-visited root move. Fall back to a legal move
        let best: MctsNode | null = null;
        for (const child of root.children) {
            if (!best || child.visits > best.visits) best = child;
        }

        return best?.moveFromParent ?? rootMoves[0];
    }

    // -------------------------- MCTS phases ------------------------------ //

    private select(node: MctsNode): MctsNode {
        let cur = node;
        while (!isGameOver(cur.state)) {
            const allowed = Math.ceil(PW_K * Math.pow(cur.visits + 1, PW_ALPHA));
            // If widening still permits a new child and there are untried moves,
            // stop here so expand() can add one
            if (cur.untried.length > 0 && cur.children.length < allowed) return cur;
            if (cur.children.length === 0) return cur; // terminalish / no expansion
            cur = this.bestUctChild(cur);
        }

        return cur;
    }

    private expand(node: MctsNode): MctsNode {
        if (isGameOver(node.state) || node.untried.length === 0) return node;
        const allowed = Math.ceil(PW_K * Math.pow(node.visits + 1, PW_ALPHA));
        if (node.children.length >= allowed) return node;

        // Pick an untried move (weighted) and realize it as a child
        const move = weightedPick(node.untried, (m) => this.weights[moveCategory(m)], this.rng);
        node.untried = node.untried.filter((m) => m !== move);
        const child = this.makeNode(applyMove(node.state, move), node, move);
        node.children.push(child);
        return child;
    }

    private bestUctChild(node: MctsNode): MctsNode {
        const chooser = node.toMove;
        const logN = Math.log(node.visits + 1);
        let best: MctsNode | null = null;
        let bestVal = -Infinity;
        for (const c of node.children) {
            const exploit = (c.reward[chooser] ?? 0) / (c.visits || 1);
            const explore = this.explore * Math.sqrt(logN / (c.visits || 1));
            const val = exploit + explore;
            if (val > bestVal) {
                bestVal = val;
                best = c;
            }
        }
        return best ?? node;
    }

    // Truncated weighted-random playout; returns per-player reward shares
    private rollout(state: FinityGameState, deadline: number): Reward {
        let cur = state;
        let depth = 0;
        while (!isGameOver(cur) && depth < this.rolloutDepth) {
            if (Date.now() >= deadline) break;
            const mover = currentPlayer(cur);
            const moves = possibleMoves(cur, mover);
            if (moves.length === 0) break;
            const m = weightedPick(moves, (mv) => this.weights[moveCategory(mv)], this.rng);
            cur = applyMove(cur, m);
            depth++;
        }
        return this.scoreState(cur);
    }

    private backpropagate(node: MctsNode, reward: Reward): void {
        let cur: MctsNode | null = node;
        while (cur) {
            cur.visits++;
            for (const p of cur.state.config.playerColors) {
                cur.reward[p] = (cur.reward[p] ?? 0) + (reward[p] ?? 0);
            }
            cur = cur.parent;
        }
    }

    // ---------------------- scoring ------------------------- //

    // Per-player reward shares in [0,1] summing to 1
    private scoreState(state: FinityGameState): Reward {
        const players = state.config.playerColors;
        const out: Reward = {};
        if (state.playStatus === 'over') {
            if (state.winners.length > 0) {
                for (const p of players) {
                    out[p] = state.winners.includes(p) ? 1 / state.winners.length : 0;
                }
            } else {
                for (const p of players) out[p] = 1 / players.length; // draw
            }
            return out;
        }
        // Non-terminal cutoff: normalized, min-shifted evaluation shares
        const vals = players.map((p) => evaluate(state, p, this.evalWeights));
        const min = Math.min(...vals);
        const shifted = vals.map((v) => v - min + 1e-6);
        const sum = shifted.reduce((a, b) => a + b, 0);
        players.forEach((p, i) => {
            out[p] = shifted[i] / sum;
        });
        return out;
    }

    // ------------------------ helpers ------------------------ //

    private makeNode(
        state: FinityGameState,
        parent: MctsNode | null,
        moveFromParent: MoveAction | null,
    ): MctsNode {
        const toMove = currentPlayer(state);
        return {
            state,
            toMove,
            parent,
            moveFromParent,
            children: [],
            untried: isGameOver(state) ? [] : possibleMoves(state, toMove),
            visits: 0,
            reward: {},
        };
    }
}
