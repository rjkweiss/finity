// PlayerAgent that proxies move() to a dedicated Web Worker running the built-in
// search agents. The orchestrator cannot tell the difference — same interface,
// same abort semantics — but the main thread never blocks during search.
//
// Cancellation: on ctx.signal abort we TERMINATE the worker (the only true mid-
// search cancel; see search.worker.ts) and lazily spawn a fresh one on the next
// move. This matches the orchestrator's "orphan the misbehaving promise / the real
// sandbox would terminate its worker" contract in callWithAbort.

import type { FinityGameState, MoveAction, PlayerColor } from '@finity/engine';
import {
    MoveAbortedError,
    type AbortReason,
    type Difficulty,
    type MoveContext,
    type PlayerAgent,
} from '@finity/agents';
import type { WorkerRequest, WorkerResponse } from '../workers/searchProtocol';

export interface WorkerSearchAgentOptions {
    difficulty: Difficulty;
    playerCount: number;
    id?: string;
    label?: string;
}

export class WorkerSearchAgent implements PlayerAgent {
    readonly id: string;
    readonly label: string;
    readonly description = 'Built-in search AI running in a Web Worker (off the UI thread).';
    readonly author = 'built-in';
    readonly type = 'ai-builtin' as const;

    private readonly difficulty: Difficulty;
    private readonly playerCount: number;
    private worker: Worker | null = null;
    private nextRequestId = 1;

    constructor(opts: WorkerSearchAgentOptions) {
        this.difficulty = opts.difficulty;
        this.playerCount = opts.playerCount;
        this.id = opts.id ?? `ai-worker-${opts.difficulty}`;
        this.label = opts.label ?? `AI (${opts.difficulty})`;
    }

    move(color: PlayerColor, state: FinityGameState, ctx: MoveContext): Promise<MoveAction> {
        if (ctx.signal.aborted) {
            return Promise.reject(new MoveAbortedError(ctx.signal.reason as AbortReason | undefined));
        }
        const worker = this.ensureWorker();
        const requestId = this.nextRequestId++;

        return new Promise<MoveAction>((resolve, reject) => {
            const cleanup = () => {
                worker.removeEventListener('message', onMessage);
                worker.removeEventListener('error', onError);
                ctx.signal.removeEventListener('abort', onAbort);
            };
            const onMessage = (e: MessageEvent<WorkerResponse>) => {
                const msg = e.data;
                if (msg.kind === 'ready' || msg.requestId !== requestId) return;
                cleanup();
                if (msg.kind === 'result') resolve(msg.move);
                else reject(new Error(`search worker: ${msg.message}`));
            };
            const onError = (e: ErrorEvent) => {
                cleanup();
                this.terminate();
                reject(new Error(`search worker crashed: ${e.message}`));
            };
            const onAbort = () => {
                cleanup();
                this.terminate(); // fresh worker spawns lazily on the next move
                reject(new MoveAbortedError(ctx.signal.reason as AbortReason | undefined));
            };

            worker.addEventListener('message', onMessage);
            worker.addEventListener('error', onError);
            ctx.signal.addEventListener('abort', onAbort, { once: true });

            const req: WorkerRequest = { kind: 'move', requestId, color, state, moveIndex: ctx.moveIndex };
            worker.postMessage(req);
        });
    }

    dispose(): void {
        this.terminate();
    }

    private ensureWorker(): Worker {
        if (this.worker) return this.worker;
        // Static URL is required by Vite's worker bundling — do not compute it.
        const worker = new Worker(new URL('../workers/search.worker.ts', import.meta.url), {
            type: 'module',
        });
        const init: WorkerRequest = {
            kind: 'init',
            difficulty: this.difficulty,
            playerCount: this.playerCount,
        };
        worker.postMessage(init);
        this.worker = worker;
        return worker;
    }

    private terminate(): void {
        this.worker?.terminate();
        this.worker = null;
    }
}
