// Message contract between WorkerSearchAgent (main thread) and search.worker.ts.
// Everything crossing the boundary is plain JSON — FinityGameState and MoveAction
// are structured-clone safe by construction (they round-trip through GameRecords).

import type { FinityGameState, MoveAction, PlayerColor } from '@finity/engine';
import type { Difficulty } from '@finity/agents';

export type WorkerRequest =
    | { kind: 'init'; difficulty: Difficulty; playerCount: number }
    | { kind: 'move'; requestId: number; color: PlayerColor; state: FinityGameState; moveIndex: number };

export type WorkerResponse =
    | { kind: 'ready' }
    | { kind: 'result'; requestId: number; move: MoveAction }
    | { kind: 'error'; requestId: number; message: string };
