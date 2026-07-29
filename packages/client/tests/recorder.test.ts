// Orchestrator INTEGRATION tests for @finity/recorder: the recorder driven through
// the real GameOrchestrator via its GameRecorderLike seam, using the same
// first-legal-move pattern as orchestrator_test.ts. Package-local standalone tests
// (JSON round-trip details, frozen snapshots, malformed input) live in
// packages/recorder/src/recorder_test.ts. The core guarantee under test here is the
// one the BGA replay validator establishes for scraped records: folding applyMove
// over record.moves from record.initialState reproduces the recorded final state
// (checked via zobristHash — full-fold, so position-equal states hash equal).

import { describe, it, expect } from 'vitest';
import {
    applyMove,
    possibleMoves,
    type ArrowColor,
    type FinityGameState,
    type GameConfig,
    type MoveAction,
    type PlayerColor,
} from '@finity/engine';
import type { MoveContext, PlayerAgent } from '@finity/agents';
import { GameOrchestrator, type AgentMap } from '../src/orchestrator';
import { GameRecorder, agentInfoMap, parseGameRecord, recordFileName, recordToJson } from '@finity/recorder';

const CONFIG: GameConfig = { playerColors: ['cyan', 'yellow'], boardSize: 2 };
const PATTERN: ArrowColor[] = ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'];

/** Plays the first legal move every turn (same instrument as orchestrator_test). */
class FirstLegalAgent implements PlayerAgent {
    readonly type = 'ai-builtin' as const;
    readonly id: string;
    readonly label = 'First Legal';
    readonly description = 'Plays possibleMoves()[0]';
    readonly author = 'test';

    constructor(id = 'first-legal') {
        this.id = id;
    }

    async move(color: PlayerColor, state: FinityGameState, _ctx: MoveContext): Promise<MoveAction> {
        const moves = possibleMoves(state, color);
        if (moves.length === 0) throw new Error(`no legal moves for ${color}`);
        return moves[0];
    }
}

function agentsFor(): AgentMap {
    return { cyan: new FirstLegalAgent('fl-cyan'), yellow: new FirstLegalAgent('fl-yellow') };
}

const MAX_MOVES = 500;

async function playToCompletion(orch: GameOrchestrator): Promise<void> {
    while (!orch.isOver()) {
        if (orch.getState().moveHistory.length >= MAX_MOVES) {
            throw new Error(`game did not reach a terminal state within ${MAX_MOVES} moves`);
        }
        await orch.step();
    }
}

/** Build an orchestrator+recorder pair the way App does. */
function build(now?: () => number) {
    const agents = agentsFor();
    const recorder = new GameRecorder({ agents: agentInfoMap(agents), now });
    const orch = new GameOrchestrator({ config: CONFIG, pathPattern: PATTERN, agents, recorder });
    return { orch, recorder };
}

describe('GameRecorder', () => {
    it('is empty (but begun) before any move', () => {
        const { recorder } = build();
        const rec = recorder.toRecord();
        expect(rec).not.toBeNull();
        expect(rec!.moves).toHaveLength(0);
        expect(rec!.result).toBeNull();
        expect(rec!.pathPattern).toEqual(PATTERN);
        expect(rec!.agents.cyan.id).toBe('fl-cyan');
        expect(rec!.agents.cyan.type).toBe('ai-builtin');
    });

    it('records a full game: every applied move, in order, plus the result', async () => {
        const { orch, recorder } = build();
        await playToCompletion(orch);

        const result = orch.getResult()!;
        const rec = recorder.toRecord()!;

        expect(rec.moves).toHaveLength(result.totalMoves);
        expect(rec.moves.map((m) => m.moveIndex)).toEqual(rec.moves.map((_, i) => i));
        // Recorded sequence is exactly the orchestrator's applied sequence.
        expect(rec.moves.map((m) => m.move)).toEqual(
            orch.getState().moveHistory.map((h) => h.move),
        );
        expect(rec.result).not.toBeNull();
        expect(rec.result!.reason).toBe(result.reason);
        expect(rec.result!.winners).toEqual(result.winners);
    });

    it('replays: folding applyMove over record.moves reproduces the final position', async () => {
        const { orch, recorder } = build();
        await playToCompletion(orch);
        const rec = recorder.toRecord()!;

        let s = rec.initialState;
        for (const rm of rec.moves) s = applyMove(s, rm.move);

        expect(s.moveHistory).toHaveLength(orch.getState().moveHistory.length);
        expect(s.zobristHash).toBe(orch.getState().zobristHash);
        expect(s.zobristHash).toBe(rec.result!.finalState.zobristHash);
    });

    it('round-trips through JSON losslessly (and the parsed record still replays)', async () => {
        const { orch, recorder } = build();
        await playToCompletion(orch);
        const rec = recorder.toRecord()!;

        const parsed = parseGameRecord(recordToJson(rec));
        expect(parsed).toEqual(rec);

        let s = parsed.initialState;
        for (const rm of parsed.moves) s = applyMove(s, rm.move);
        expect(s.zobristHash).toBe(rec.result!.finalState.zobristHash);

        expect(recordFileName(parsed)).toMatch(/^finity-\d{8}-\d{4}-.+\.json$/);
    });

    it('reset() starts a fresh record (new gameId, empty moves, no result)', async () => {
        const { orch, recorder } = build();
        await orch.step();
        await orch.step();
        const before = recorder.toRecord()!;
        expect(before.moves).toHaveLength(2);

        orch.reset();
        const after = recorder.toRecord()!;
        expect(after.moves).toHaveLength(0);
        expect(after.result).toBeNull();
        expect(after.gameId).not.toBe(before.gameId);

        // and the fresh record keeps recording
        await orch.step();
        expect(recorder.toRecord()!.moves).toHaveLength(1);
    });

    it('mid-game snapshots are exportable (result null) and replayable', async () => {
        const { orch, recorder } = build();
        await orch.step();
        await orch.step();
        await orch.step();

        const rec = recorder.toRecord()!;
        expect(rec.result).toBeNull();
        expect(rec.moves).toHaveLength(3);

        let s = rec.initialState;
        for (const rm of rec.moves) s = applyMove(s, rm.move);
        expect(s.zobristHash).toBe(orch.getState().zobristHash);
    });

    it('recorded snapshots are frozen: later play does not mutate an earlier toRecord()', async () => {
        const { orch, recorder } = build();
        await orch.step();
        const snap = recorder.toRecord()!;
        const movesBefore = snap.moves.length;
        const hashBefore = snap.initialState.zobristHash;

        await orch.step();
        await orch.step();

        expect(snap.moves).toHaveLength(movesBefore);
        expect(snap.initialState.zobristHash).toBe(hashBefore);
    });
});
