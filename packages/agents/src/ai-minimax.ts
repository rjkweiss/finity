// Iterative deepening + Alpha-Beta + transposition table keyed by a computed position key
//  + light move ordering. Leaf nodes score with the engine's `evaluate` differential.
// iterative deepening always keeps the best move from the last fully completed depth,
// so an interrupted search still returns a legal, reasonable move

import type {
    FinityGameState,
    MoveAction,
    PlayerColor,
    EvalWeights
} from "@finity/engine";
import {
    legalMoves,
    applyMove,
    currentPlayer,
    isGameOver,
    evaluate,
    DEFAULT_WEIGHTS,
    possibleMoves
} from "@finity/engine";
import type { PlayerAgent, MoveContext } from "./interface";
import { IllegalMoveError } from "./interface";
import {
    differentialScore,
    moveCategory,
    type MoveCategory,
    throwIfAborted,
    SearchDeadlineReached,
    WIN_SCORE,
    Rng,
    seededRng,
    blockingExposure
} from "./ai-common";


export interface MinimaxOptions {
    id?: string;
    label?: string;
    // hard cap on search depth (iterative deepening stops here even with time left)
    maxDepth?: number;
    // wall-clock budget per move in milliseconds
    timeMs?: number;
    // evaluation weights: defaults to the engine's DEFAULT_WEIGHTS
    weights?: EvalWeights;

    // seed for breaking ties between equal-scoring root moves
    seed?: number;
}

type transposition_table_flag = 'exact' | 'lower' | 'upper';

interface transposition_table_entry {
    depth: number;
    flag: transposition_table_flag;
    score: number;
    move: MoveAction | null;
}

// static ordering bias so the first move tried tends to cause a cutoff
const CATEGORY_ORDER: Record<MoveCategory, number> = {
    ring: 0,
    basePost: 1,
    arrow: 2,
    reverse: 3,
    blocker: 4,
    remove: 5
};

export class MinimaxAgent implements PlayerAgent {
    readonly id: string;
    readonly label: string;
    readonly description = 'Alpha-beta minimax with iterative deepening (2-player).';
    readonly author = 'built-in';
    readonly type = 'ai-builtin' as const;

    private readonly maxDepth: number;
    private readonly timeMs: number;
    private readonly weights: EvalWeights;
    private readonly rng: Rng;

    // Per-move search scratch:
    private transposition_table = new Map<string, transposition_table_entry>();
    private me!: PlayerColor;
    private deadline = 0;
    private ctx!: MoveContext;

    constructor(opts: MinimaxOptions = {}) {
        this.id = opts.id ?? 'ai-minimax';
        this.label = opts.label ?? 'Minimax';
        this.maxDepth = Math.max(1, opts.maxDepth ?? 3);
        this.timeMs = Math.max(1, opts.timeMs ?? 1000);
        this.weights = opts.weights ?? DEFAULT_WEIGHTS;
        this.rng = seededRng(opts.seed ?? 0x5eed);
    }

    async move(color: PlayerColor, state: FinityGameState, ctx: MoveContext): Promise<MoveAction> {
        throwIfAborted(ctx);
        this.me = color;
        this.ctx = ctx;
        this.deadline = Date.now() + this.timeMs;
        this.transposition_table = new Map();

        const rootMoves = this.ordered(state, legalMoves(state, color), null);
        if (rootMoves.length === 0) {
            throw new IllegalMoveError(color, { type: 'remove' }, 'no legal moves available');
        }
        if (rootMoves.length === 1) return rootMoves[0];

        let best: MoveAction = rootMoves[0];

        // Iterative deepening: each completed depth refines `best`; a timeout or
        // hard abort mid-depth discards that depth and keeps the last good one.
        for (let depth = 1; depth <= this.maxDepth; depth++) {
            try {
                const result = this.searchRoot(state, rootMoves, depth, best);
                best = result.move;
                // A proven win/loss won't change with more depth.
                if (Math.abs(result.score) >= WIN_SCORE) break;
            } catch (e) {
                if (e instanceof SearchDeadlineReached) break;
                throw e; // MoveAbortedError propagates to the orchestrator
            }
            if (Date.now() >= this.deadline) break;
        }
        return best;
    }

    private searchRoot(
        state: FinityGameState,
        rootMoves: MoveAction[],
        depth: number,
        prevBest: MoveAction,
    ): { move: MoveAction; score: number } {
        let alpha = -Infinity;
        const beta = Infinity;

        // Try the previous best first for stronger ordering.
        const moves = this.moveFirst(rootMoves, prevBest);
        let bestMove = moves[0];
        let bestScore = -Infinity;
        let bestExposure = Infinity;
        let ties = 1;

        for (const move of moves) {
            const child = applyMove(state, move);
            const score = -this.search(child, depth - 1, -beta, -alpha);

            if (score > bestScore) {
                bestScore = score;
                bestMove = move;
                bestExposure = blockingExposure(state, move);
                ties = 1;
            } else if (score === bestScore) {
                // Reservoir sampling over equal-scoring moves:
                // each of the k tied moves end up being chose with probability 1/k
                const e = blockingExposure(state, move);
                if (e < bestExposure) {
                    bestMove = move;
                    bestExposure = e;
                    ties = 1;
                } else if (e === bestExposure) {
                    ties++;
                    if (this.rng() < 1 / ties) bestMove = move;
                }
            }

            // alpha stays a hair below the best score so that a true tie is searched
            // exactly and a worse move comes back strictly lower
            if (score > alpha) alpha = score - 1e-9;
        }

        return { move: bestMove, score: bestScore };
    }

    // Negamax with alpha-beta. Returns the value from the side-to-move's view.
    private search(state: FinityGameState, depth: number, alpha: number, beta: number): number {
        this.checkBudget();

        if (isGameOver(state) || depth <= 0) {
            return this.leaf(state, depth);
        }

        const key = state.zobristHash;
        const hit = this.transposition_table.get(key);
        let ttMove: MoveAction | null = null;

        if (hit && hit.depth >= depth) {
            if (hit.flag === 'exact') return hit.score;
            if (hit.flag === 'lower' && hit.score > alpha) alpha = hit.score;
            else if (hit.flag === 'upper' && hit.score < beta) beta = hit.score;

            if (alpha >= beta) return hit.score;
            ttMove = hit.move;
        } else if (hit) {
            ttMove = hit.move;
        }

        const toMove = currentPlayer(state);
        const moves = this.ordered(state, possibleMoves(state, toMove), ttMove);

        if (moves.length === 0) return this.leaf(state, depth);

        const alphaOrig = alpha;
        let bestScore = -Infinity;
        let bestMove: MoveAction | null = null;

        for (const move of moves) {
            const child = applyMove(state, move);
            const score = -this.search(child, depth - 1, -beta, -alpha);
            if (score > bestScore) {
                bestScore = score;
                bestMove = move;
            }

            if (score > alpha) alpha = score;
            if (alpha >= beta) break; // cutoff
        }

        const flag: transposition_table_flag =
            bestScore <= alphaOrig ? 'upper' : bestScore >= beta ? 'lower' : 'exact';
        this.transposition_table.set(key, { depth, flag, score: bestScore, move: bestMove });

        return bestScore;
    }

    // -------------------------------------------------------------------------
    // Leaf value from the side-to-move's perspective (negamax convention).
    // differentialScore is from `me`'s perspective, so flip when the opponent
    // is on the move.
    // -------------------------------------------------------------------------
    private leaf(state: FinityGameState, depthLeft: number): number {
        const fromMe = differentialScore(
            state,
            this.me,
            (s, c) => evaluate(s, c, this.weights),
            Math.max(0, depthLeft),
        );
        return currentPlayer(state) === this.me ? fromMe : -fromMe;
    }

    private ordered(state: FinityGameState, moves: MoveAction[], ttMove: MoveAction | null): MoveAction[] {
        // score once per move
        const keyed = moves.map((m) => ({
            m,
            rank: CATEGORY_ORDER[moveCategory(m)] * 10 + blockingExposure(state, m),
        }));
        keyed.sort((a, b) => a.rank - b.rank);
        const sorted = keyed.map((X) => X.m);

        return ttMove ? this.moveFirst(sorted, ttMove): sorted;
    }

    private moveFirst(moves: MoveAction[], first: MoveAction): MoveAction[] {
        const idx = moves.findIndex((m) => sameMove(m, first));
        if (idx <= 0) return moves;
        const copy = [...moves];
        const [f] = copy.splice(idx, 1);
        copy.unshift(f);
        return copy;
    }

    private checkBudget(): void {
        throwIfAborted(this.ctx);
        if (Date.now() >= this.deadline) throw new SearchDeadlineReached();
    }
}

// Structural move equality (enough for ordering; not a legality check).
function sameMove(a: MoveAction, b: MoveAction): boolean {
    if (a.type !== b.type || a.station !== b.station) return false;
    return JSON.stringify(a.pieceToAdd) === JSON.stringify(b.pieceToAdd)
        && JSON.stringify(a.pieceToRemove) === JSON.stringify(b.pieceToRemove);
}
