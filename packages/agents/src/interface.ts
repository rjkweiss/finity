// packages/agents/src/interface.ts
//
// STEP 1 — The single contract every player type implements, plus the
// cancellation semantics that MUST be pinned before any agent is written.
//
// This SUPERSEDES the design-doc signature `move(color, state): Promise<MoveAction>`.
// The added third argument (MoveContext) is the whole point of step 1: every agent
// — human, scripted, minimax, MCTS, remote, ML — shares this signature, so the
// cancellation channel has to exist from the first agent or it's a painful retrofit.
//
// See PHASE2-NOTES.md "MISS #1" — any previously-ported agent (e.g. ai-random)
// must be updated to this signature.

import type {
    FinityGameState,
    GameConfig,
    GameResult,
    MoveAction,
    RecordedMove,
    PlayerColor,
} from '@finity/engine';

export type AgentType =
    | 'human-local'
    | 'human-remote'
    | 'ai-builtin'
    | 'ai-custom'
    | 'ai-ml'
    | 'scripted';

/**
 * Context handed to an agent for a single `move()` call.
 *
 * Why an object instead of a bare `signal` argument: it lets us add per-turn
 * fields later (deadline, moveIndex, difficulty hint) WITHOUT changing every
 * agent's signature again — which is the exact retrofit pain we are avoiding here.
 */
export interface MoveContext {
    /** Aborts when the orchestrator no longer wants this move (timeout, resign,
     *  new game, undo). Agents that hold pending work MUST listen and clean up. */
    readonly signal: AbortSignal;
    /** Sequential index of the turn being requested. Convenience for logging. */
    readonly moveIndex: number;
}

export interface PlayerAgent {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly author: string;
    readonly type: AgentType;

    /**
     * Resolve with a *legal* MoveAction for `color`, or reject.
     * `state` is an immutable clone owned by the agent — mutating it is harmless
     * to the orchestrator but pointless.
     * MUST reject with MoveAbortedError (or stop work) when `ctx.signal` aborts.
     */
    move(color: PlayerColor, state: FinityGameState, ctx: MoveContext): Promise<MoveAction>;

    onGameStart?(config: GameConfig): void;
    onGameEnd?(result: GameResult): void;
    onOpponentMove?(move: RecordedMove): void;
    dispose?(): void;
}

/** Reason objects carried on AbortSignal.reason so listeners can tell apart
 *  "the human pressed resign" from "the AI ran out of time". */
export type AbortReason =
    | { kind: 'timeout' }
    | { kind: 'resign'; color: PlayerColor }
    | { kind: 'new-game' }
    | { kind: 'undo' }
    | { kind: 'disposed' };

export class MoveAbortedError extends Error {
    readonly reason: AbortReason | undefined;
    constructor(reason?: AbortReason) {
        super(`Move aborted${reason ? `: ${reason.kind}` : ''}`);
        this.name = 'MoveAbortedError';
        this.reason = reason;
    }
}

export class MoveTimeoutError extends Error {
    constructor(public readonly timeoutMs: number) {
        super(`Agent exceeded move timeout of ${timeoutMs}ms`);
        this.name = 'MoveTimeoutError';
    }
}

export class IllegalMoveError extends Error {
    constructor(
        public readonly color: PlayerColor,
        public readonly move: MoveAction,
        public readonly validationReason?: string,
    ) {
        super(`Illegal move by ${color}${validationReason ? `: ${validationReason}` : ''}`);
        this.name = 'IllegalMoveError';
    }
}
