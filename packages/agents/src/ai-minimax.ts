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
import { buildRootContext, rootMoveBonus, type RootContext, type MoveBonus } from "./ai-judgement";


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
    // apply move-level judgement at the root (reversal value, block * impact).
    // Default true; set false to A/B it in the self-play runner. */
    rootBonuses?: boolean;
    /**
     * Killer-move and history ordering for interior nodes. Alpha-beta prunes
     * best when the refuting move is tried first; these remember which moves
     * caused cutoffs, at each depth (killers) and across the search (history).
     * Default true; set false to A/B it.
     */
    killerHistory?: boolean;
    /** Override individual root-judgement weights (see MOVE_BONUS), e.g. { doubleUp: 0 } to A/B it. */
    moveBonus?: Partial<MoveBonus>;
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
    readonly rootBonuses: boolean;
    readonly killerHistory: boolean;
    readonly moveBonus: Partial<MoveBonus>;
    /** Instrumentation: interior + leaf nodes visited, and deepest completed iteration, last move. */
    public nodes = 0;
    public lastDepth = 0;

    private readonly maxDepth: number;
    private readonly timeMs: number;
    private readonly weights: EvalWeights;
    private readonly rng: Rng;

    // Per-move search scratch:
    private transposition_table = new Map<string, transposition_table_entry>();
    private me!: PlayerColor;
    private deadline = 0;
    private ctx!: MoveContext;
    private rootCtx!: RootContext;
    // Root-move bonuses for the current turn, computed once per move
    private rootBonus = new Map<MoveAction, number>();
    // Per-turn ordering memory: two killer moves per ply, and a history score per move
    private killers: Array<[MoveAction | null, MoveAction | null]> = [];
    private history = new Map<string, number>();

    constructor(opts: MinimaxOptions = {}) {
        this.id = opts.id ?? 'ai-minimax';
        this.label = opts.label ?? 'Minimax';
        this.maxDepth = Math.max(1, opts.maxDepth ?? 3);
        this.timeMs = Math.max(1, opts.timeMs ?? 1000);
        this.weights = opts.weights ?? DEFAULT_WEIGHTS;
        this.rng = seededRng(opts.seed ?? 0x5eed);
        this.rootBonuses = opts.rootBonuses ?? true;
        this.killerHistory = opts.killerHistory ?? true;
        this.moveBonus = { ...(opts.moveBonus ?? {}) };
    }

    async move(color: PlayerColor, state: FinityGameState, ctx: MoveContext): Promise<MoveAction> {
        throwIfAborted(ctx);
        this.me = color;
        this.ctx = ctx;
        const deadline = Date.now() + this.timeMs;
        this.transposition_table = new Map();
        this.rootCtx = buildRootContext(state, color, this.moveBonus);
        this.rootBonus = new Map();
        this.killers = [];
        this.history = new Map();
        this.nodes = 0;
        this.lastDepth = 0;

        const rootMoves = this.ordered(state, legalMoves(state, color), null);
        if (rootMoves.length === 0) {
            throw new IllegalMoveError(color, { type: 'remove' }, 'no legal moves available');
        }
        if (rootMoves.length === 1) return rootMoves[0];

        let best: MoveAction = rootMoves[0];

        // Iterative deepening: each completed depth refines `best`; a timeout or
        // hard abort mid-depth discards that depth and keeps the last good one.
        for (let depth = 1; depth <= this.maxDepth; depth++) {
            // depth 1 always run to completion, whatever the budget
            this.deadline = depth === 1 ? Infinity : deadline;
            try {
                const result = this.searchRoot(state, rootMoves, depth, best);
                best = result.move;
                this.lastDepth = depth;
                // A proven win/loss won't change with more depth.
                if (Math.abs(result.score) >= WIN_SCORE / 2) break;
            } catch (e) {
                if (e instanceof SearchDeadlineReached) break;
                throw e; // MoveAbortedError propagates to the orchestrator
            }
            if (Date.now() >= deadline) break;
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

            // move-level judgement (reversal value, block impact). It depends on the move
            // so compute it once per turn, on the first iteration, and reuse it at every depth
            let bonus = this.rootBonus.get(move);
            if (bonus === undefined) {
                bonus = this.rootBonuses ? rootMoveBonus(this.rootCtx, state, child, move): 0;
                this.rootBonus.set(move, bonus);
            }

            // search the child against a window shifted by the bonus,
            // so that pruning is exact for the adjusted score: raw + bonus > alpha
            // exactly when raw > alpha - bonus
            const score = -this.search(child, depth - 1, -beta, -(alpha - bonus)) + bonus;

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
    private search(state: FinityGameState, depth: number, alpha: number, beta: number, ply = 1): number {
        this.checkBudget();
        this.nodes++;

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
        const moves = this.ordered(state, possibleMoves(state, toMove), ttMove, ply);

        if (moves.length === 0) return this.leaf(state, depth);

        const alphaOrig = alpha;
        let bestScore = -Infinity;
        let bestMove: MoveAction | null = null;

        for (const move of moves) {
            const child = applyMove(state, move);
            const score = -this.search(child, depth - 1, -beta, -alpha, ply + 1);
            if (score > bestScore) {
                bestScore = score;
                bestMove = move;
            }

            if (score > alpha) alpha = score;
            if (alpha >= beta) {
                this.recordCutoff(move, ply, depth);
                break; // cutoff
            }
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

    /**
     * Move ordering. Everywhere: category, then Tony's blocking exposure. At
     * interior nodes (ply given) with killerHistory on, the two killer moves
     * for that ply go first, then moves by history score. The transposition
     * move, when known, goes before all of them.
     */
    private ordered(
        state: FinityGameState,
        moves: MoveAction[],
        ttMove: MoveAction | null,
        ply?: number,
    ): MoveAction[] {
        const useMemory = this.killerHistory && ply !== undefined;
        const [k1, k2] = useMemory ? (this.killers[ply!] ?? [null, null]): [null, null];

        // score once per move, not once per comparison
        const keyed = moves.map((m) => {
            let rank = CATEGORY_ORDER[moveCategory(m)] * 10 + blockingExposure(state, m);
            if (useMemory) {
                if (k1 && sameMove(m, k1)) rank = -2_000_000;
                else if (k2 && sameMove(m, k2)) rank = -1_000_000;
                else rank -= (this.history.get(historyKey(m)) ?? 0) * 100;
            }
            return { m, rank };
        });
        keyed.sort((a, b) => a.rank - b.rank);
        const sorted = keyed.map((x) => x.m);

        return ttMove ? this.moveFirst(sorted, ttMove): sorted;
    }

    /** A move refuted this line: remember it at this ply, and credit it overall */
    private recordCutoff(move: MoveAction, ply: number, depth: number): void {
        if (!this.killerHistory) return;
        const slot = this.killers[ply] ?? (this.killers[ply] = [null, null]);
        if (!slot[0] || !sameMove(slot[0], move)) {
            slot[1] = slot[0];
            slot[0] = move;
        }
        const key = historyKey(move);
        // Deeper cutoffs prune more, so they count for more
        this.history.set(key, (this.history.get(key) ?? 0) + depth * depth);
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

/**
 * History is keyed by what a move does and where, so the same idea reached by
 * a different route shares its score
 */
function historyKey(m: MoveAction): string {
    const add = m.pieceToAdd;
    if (!add) return `x:${m.pieceToRemove?.slotId ?? -1}`;
    switch(add.type) {
        case 'ring':
            return `r:${m.station}`;
        case 'arrow':
            return `a:${add.slotId}:${add.color}:${add.fromStation}>${add.toStation}`;
        case 'blocker':
            return `b:${m.pieceToRemove?.slotId ?? -1}>${add.slotId}`;
        case 'basePost':
            return `p:${add.toStation}`;
        default:
            return '?';
    }
}

// Structural move equality (enough for ordering; not a legality check).
function sameMove(a: MoveAction, b: MoveAction): boolean {
    if (a.type !== b.type || a.station !== b.station) return false;
    return JSON.stringify(a.pieceToAdd) === JSON.stringify(b.pieceToAdd)
        && JSON.stringify(a.pieceToRemove) === JSON.stringify(b.pieceToRemove);
}
