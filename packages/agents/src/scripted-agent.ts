// packages/agents/src/scripted-agent.ts
//
// STEP 2 — A trivial agent that plays moves from a predetermined list, in order.
// It is the instrument that lets the orchestrator (step 3) be tested with zero UI
// and zero human, and it is what replays a recorded game in step 4.

import type { FinityGameState, MoveAction, PlayerColor } from '@finity/engine';
import { MoveAbortedError, type AbortReason, type MoveContext, type PlayerAgent } from './interface';

export interface ScriptedAgentOptions {
    id?: string;
    label?: string;
    /** Optional artificial delay per move (ms), to exercise async paths/timeouts. */
    delayMs?: number;
    /** What to do when the script runs out. 'throw' (default) surfaces test bugs;
     *  'hang' returns a never-resolving promise (useful to test timeouts). */
    onExhausted?: 'throw' | 'hang';
}

export class ScriptedAgent implements PlayerAgent {
    readonly type = 'scripted' as const;
    readonly id: string;
    readonly label: string;
    readonly description = 'Plays a predetermined sequence of moves';
    readonly author = 'Finity (test)';

    private readonly moves: readonly MoveAction[];
    private readonly delayMs: number;
    private readonly onExhausted: 'throw' | 'hang';
    private cursor = 0;

    constructor(moves: readonly MoveAction[], opts: ScriptedAgentOptions = {}) {
        this.moves = moves;
        this.id = opts.id ?? 'scripted';
        this.label = opts.label ?? 'Scripted';
        this.delayMs = opts.delayMs ?? 0;
        this.onExhausted = opts.onExhausted ?? 'throw';
    }

    /** Remaining moves not yet played. */
    get remaining(): number {
        return this.moves.length - this.cursor;
    }

    async move(_color: PlayerColor, _state: FinityGameState, ctx: MoveContext): Promise<MoveAction> {
        throwIfAborted(ctx.signal);

        if (this.delayMs > 0) {
            await delay(this.delayMs, ctx.signal);
        }

        if (this.cursor >= this.moves.length) {
            if (this.onExhausted === 'hang') {
                return new Promise<MoveAction>(() => {
                    /* never resolves — lets a test drive the timeout path */
                });
            }
            throw new Error(
                `ScriptedAgent "${this.id}" exhausted: asked for move ${this.cursor + 1} of ${this.moves.length}`,
            );
        }

        return this.moves[this.cursor++];
    }
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new MoveAbortedError(signal.reason as AbortReason | undefined);
    }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            reject(new MoveAbortedError(signal.reason as AbortReason | undefined));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
