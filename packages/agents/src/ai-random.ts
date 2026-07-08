// Two policies:
//   - WeightedRandomAgent: samples legal moves with category weights that favor
//     rings and base posts (the design's intended baseline opponent).
//   - RandomAgent: uniform over legal moves (useful as a control / smoke test).
//
// Both are trivially fast, but still honor ctx.signal for API uniformity.

import type { FinityGameState, MoveAction, PlayerColor } from "@finity/engine";
import { possibleMoves } from "@finity/engine";
import type { PlayerAgent, MoveContext } from "./interface";
import { IllegalMoveError } from "./interface";
import {
    moveCategory,
    DEFAULT_CATEGORY_WEIGHTS,
    type CategoryWeights,
    weightedPick,
    defaultRng,
    type Rng,
    throwIfAborted
} from "./ai-common";

export interface RandomAgentOptions {
    // Stable identity for records; defaults to a generic id.
    id?: string;
    label?: string;
    // Category weights for the weighted policy -- ignored by the uniform policy
    weights?: CategoryWeights;
    // Injectable RNG for reproducibility. Defaults to Math.random
    rng?: Rng;
}

abstract class BaseRandomAgent implements PlayerAgent {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly author = 'built-in';
    readonly type = 'ai-builtin' as const;
    protected readonly rng: Rng;

    constructor(id: string, label: string, description: string, rng: Rng) {
        this.id = id;
        this.label = label;
        this.description = description;
        this.rng = rng;
    }

    async move(color: PlayerColor, state: FinityGameState, ctx: MoveContext): Promise<MoveAction> {
        throwIfAborted(ctx);
        const moves = possibleMoves(state, color);
        if (moves.length === 0) {
            // no legal move - surface it rather than inventing one
            throw new IllegalMoveError(color, { type: 'remove' }, 'no legal moves available');
        }
        throwIfAborted(ctx);
        return this.choose(moves);
    }

    protected abstract choose(moves: MoveAction[]): MoveAction;
}

// Uniform random over legal moves
export class RandomAgent extends BaseRandomAgent {
    constructor(opts: RandomAgentOptions = {}) {
        super(
            opts.id ?? 'ai-random-uniform',
            opts.label ?? 'Random (uniform)',
            'Picks a uniformly random legal move',
            opts.rng ?? defaultRng,
        );
    }

    protected choose(moves: MoveAction[]): MoveAction {
        return moves[Math.floor(this.rng() * moves.length)];
    }
}

// Category-Weighted random: favors rings and base posts over arrows/blockers
export class WeightedRandomAgent extends BaseRandomAgent {
    private readonly weights: CategoryWeights;
    constructor(opts: RandomAgentOptions = {}) {
        super(
            opts.id ?? 'ai-random-weighted',
            opts.label ?? 'Random (weighted)',
            'Picks a random legal move, weighted toward rings and base posts',
            opts.rng ?? defaultRng,
        );

        this.weights = opts.weights ?? DEFAULT_CATEGORY_WEIGHTS;
    }

    protected choose(moves: MoveAction[]): MoveAction {
        return weightedPick(moves, (m) => this.weights[moveCategory(m)], this.rng);
    }
}
