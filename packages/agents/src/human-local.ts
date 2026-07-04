// packages/agents/src/human-local.ts
//
// STEP 5 — The one genuinely tricky agent: it bridges the synchronous, event-driven
// world of mouse clicks to the async agent contract. `move()` does not compute — it
// parks a promise and hands its resolver to the UI. `submitMove()` (called by the
// MoveInputHandler in step 6) unblocks the orchestrator.

import type { FinityGameState, MoveAction, PlayerColor } from '@finity/engine';
import {
    MoveAbortedError,
    type AbortReason,
    type MoveContext,
    type PlayerAgent,
} from './interface';

export class LocalHumanAgent implements PlayerAgent {
    readonly type = 'human-local' as const;
    readonly id: string;
    readonly label: string;
    readonly description = 'A human player using this device';
    readonly author = 'Finity';

    private pending: {
        resolve: (m: MoveAction) => void;
        reject: (e: unknown) => void;
        color: PlayerColor;
        detachAbort: () => void;
    } | null = null;

    /** Fired when this agent starts/stops awaiting input, so the UI can toggle
     *  move controls without polling. */
    private awaitingListeners = new Set<(awaiting: boolean) => void>();

    constructor(opts: { id?: string; label?: string } = {}) {
        this.id = opts.id ?? 'human-local';
        this.label = opts.label ?? 'Local Human';
    }

    move(color: PlayerColor, _state: FinityGameState, ctx: MoveContext): Promise<MoveAction> {
        // Defensive: a well-behaved orchestrator never calls move() twice without the
        // first resolving, but if it does we cancel the stale turn rather than leak it.
        if (this.pending) {
            this.cancelPending(new MoveAbortedError({ kind: 'new-game' }));
        }

        return new Promise<MoveAction>((resolve, reject) => {
            if (ctx.signal.aborted) {
                reject(new MoveAbortedError(ctx.signal.reason as AbortReason | undefined));
                return;
            }
            const onAbort = () => {
                this.cancelPending(new MoveAbortedError(ctx.signal.reason as AbortReason | undefined));
            };
            ctx.signal.addEventListener('abort', onAbort, { once: true });
            this.pending = {
                resolve,
                reject,
                color,
                detachAbort: () => ctx.signal.removeEventListener('abort', onAbort),
            };
            this.emitAwaiting(true);
        });
    }

    /**
     * Called by the UI/MoveInputHandler when the human has assembled a complete move.
     * Returns true if a turn was actually waiting (so the UI can ignore stray clicks).
     * NOTE: this does NOT validate the move — the orchestrator validates via the engine.
     * The MoveInputHandler should only ever submit moves drawn from possibleMoves().
     */
    submitMove(move: MoveAction): boolean {
        if (!this.pending) return false;
        const { resolve } = this.takePending();
        resolve(move);
        return true;
    }

    /** True while the orchestrator is blocked on this human's input. */
    isAwaitingInput(): boolean {
        return this.pending !== null;
    }

    /** Color currently on the clock, or null if not this human's turn. */
    awaitingColor(): PlayerColor | null {
        return this.pending?.color ?? null;
    }

    onAwaitingChange(fn: (awaiting: boolean) => void): () => void {
        this.awaitingListeners.add(fn);
        return () => this.awaitingListeners.delete(fn);
    }

    dispose(): void {
        if (this.pending) this.cancelPending(new MoveAbortedError({ kind: 'disposed' }));
        this.awaitingListeners.clear();
    }

    private cancelPending(err: MoveAbortedError): void {
        if (!this.pending) return;
        const { reject } = this.takePending();
        reject(err);
    }

    private takePending(): { resolve: (m: MoveAction) => void; reject: (e: unknown) => void } {
        const p = this.pending!;
        p.detachAbort();
        this.pending = null;
        this.emitAwaiting(false);
        return { resolve: p.resolve, reject: p.reject };
    }

    private emitAwaiting(awaiting: boolean): void {
        for (const fn of this.awaitingListeners) fn(awaiting);
    }
}
