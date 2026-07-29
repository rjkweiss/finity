// Package-local tests: drive the GameRecorder the way its contract specifies
// (begin -> recordMove per applied move -> finalize), using ONLY the engine —
// no client orchestrator. The orchestrator-integration half (reset restarts the
// record, recorded sequence == applied sequence through the seam) lives in the
// client package: packages/client/src/recorder_test.ts.

import { describe, it, expect } from 'vitest';
import {
    applyMove,
    createGame,
    currentPlayer,
    isGameOver,
    possibleMoves,
    type ArrowColor,
    type GameConfig,
    type PlayerColor,
} from '@finity/engine';
import type { AgentInfo } from '@finity/engine';
import { GameRecorder } from '../src/recorder';
import { parseGameRecord, recordFileName, recordToJson } from '../src/serialization';

const CONFIG: GameConfig = { playerColors: ['cyan', 'yellow'], boardSize: 2 };
const PATTERN: ArrowColor[] = ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'];

const AGENTS = {
    cyan: { id: 'fl-cyan', type: 'ai-builtin', label: 'First Legal', author: 'test' },
    yellow: { id: 'fl-yellow', type: 'ai-builtin', label: 'First Legal', author: 'test' },
} as Record<PlayerColor, AgentInfo>;

const MAX_MOVES = 500;

/** Play first-legal moves to a terminal state, feeding the recorder per contract. */
function playRecorded(recorder: GameRecorder) {
    let state = createGame(CONFIG, PATTERN);
    recorder.begin(state);
    while (!isGameOver(state)) {
        if (state.moveHistory.length >= MAX_MOVES) throw new Error('no terminal state');
        const color = currentPlayer(state);
        const move = possibleMoves(state, color)[0];
        state = applyMove(state, move);
        recorder.recordMove(move, color, state);
    }
    return state;
}

describe('GameRecorder (standalone, engine-driven)', () => {
    it('returns null before begin()', () => {
        const r = new GameRecorder({ agents: {} as Record<PlayerColor, AgentInfo> });
        expect(r.toRecord()).toBeNull();
    });

    it('captures a full game and the record replays to the same final position', () => {
        const recorder = new GameRecorder({ agents: AGENTS });
        const finalState = playRecorded(recorder);
        recorder.finalize({
            winners: [],
            reason: 'deadlock',
            finalState,
            totalMoves: finalState.moveHistory.length,
            durationMs: 0,
        });

        const rec = recorder.toRecord()!;
        expect(rec.moves).toHaveLength(finalState.moveHistory.length);
        expect(rec.moves.map((m) => m.moveIndex)).toEqual(rec.moves.map((_, i) => i));

        let s = rec.initialState;
        for (const rm of rec.moves) s = applyMove(s, rm.move);
        expect(s.zobristHash).toBe(finalState.zobristHash);
    });

    it('JSON round-trip is lossless and the parsed record still replays', () => {
        const recorder = new GameRecorder({ agents: AGENTS });
        const finalState = playRecorded(recorder);
        const rec = recorder.toRecord()!;

        const parsed = parseGameRecord(recordToJson(rec));
        expect(parsed).toEqual(rec);
        let s = parsed.initialState;
        for (const rm of parsed.moves) s = applyMove(s, rm.move);
        expect(s.zobristHash).toBe(finalState.zobristHash);
        expect(recordFileName(parsed)).toMatch(/^finity-\d{8}-\d{4}-.+\.json$/);
    });

    it('begin() starts a fresh record with a fresh gameId', () => {
        const recorder = new GameRecorder({ agents: AGENTS });
        const s0 = createGame(CONFIG, PATTERN);
        recorder.begin(s0);
        const move = possibleMoves(s0, currentPlayer(s0))[0];
        recorder.recordMove(move, currentPlayer(s0), applyMove(s0, move));
        const first = recorder.toRecord()!;
        expect(first.moves).toHaveLength(1);

        recorder.begin(s0);
        const second = recorder.toRecord()!;
        expect(second.moves).toHaveLength(0);
        expect(second.result).toBeNull();
        expect(second.gameId).not.toBe(first.gameId);
    });

    it('snapshots are frozen against later recording', () => {
        const recorder = new GameRecorder({ agents: AGENTS });
        let state = createGame(CONFIG, PATTERN);
        recorder.begin(state);
        const snap = recorder.toRecord()!;

        const color = currentPlayer(state);
        const move = possibleMoves(state, color)[0];
        state = applyMove(state, move);
        recorder.recordMove(move, color, state);

        expect(snap.moves).toHaveLength(0);
        expect(recorder.toRecord()!.moves).toHaveLength(1);
    });

    it('parseGameRecord rejects malformed input with readable messages', () => {
        expect(() => parseGameRecord('not json')).toThrow(/Not valid JSON/);
        expect(() => parseGameRecord('{"version":2}')).toThrow(/version/);
        expect(() => parseGameRecord('{"version":1,"gameId":"x","timestamp":1}')).toThrow(/pathPattern/);
    });
});
