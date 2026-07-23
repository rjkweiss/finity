// Runs the built-in search agents (Minimax / MCTS) off the main thread. The agent
// instance persists for the worker's lifetime, so anything it accumulates across
// moves survives between turns. Cancellation is NOT done via the abort signal here:
// the search loop is synchronous and the worker is single-threaded, so a posted
// "abort" message would only be seen after the search finished anyway. The main
// thread cancels by terminating the worker (see WorkerSearchAgent).

import { createBuiltinAgent, type PlayerAgent } from '@finity/agents';
import type { WorkerRequest, WorkerResponse } from './searchProtocol';

// Minimal structural typing keeps this file compiling under the client's DOM lib
// without pulling in the conflicting "webworker" lib.
type WorkerScope = {
    onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
    postMessage: (msg: WorkerResponse) => void;
};
const scope = self as unknown as WorkerScope;

let agent: PlayerAgent | null = null;

scope.onmessage = (e) => {
    void handle(e.data);
};

async function handle(msg: WorkerRequest): Promise<void> {
    if (msg.kind === 'init') {
        agent = createBuiltinAgent(msg.difficulty, msg.playerCount);
        scope.postMessage({ kind: 'ready' });
        return;
    }

    if (!agent) {
        scope.postMessage({
            kind: 'error',
            requestId: msg.requestId,
            message: 'worker received "move" before "init"',
        });
        return;
    }

    try {
        // Signal is inert by design (see header comment); budgets inside the agent
        // (timeMs / maxDepth / maxIterations) bound the search.
        const ac = new AbortController();
        const move = await agent.move(msg.color, msg.state, {
            signal: ac.signal,
            moveIndex: msg.moveIndex,
        });
        scope.postMessage({ kind: 'result', requestId: msg.requestId, move });
    } catch (err) {
        scope.postMessage({
            kind: 'error',
            requestId: msg.requestId,
            message: err instanceof Error ? err.message : String(err),
        });
    }
}
