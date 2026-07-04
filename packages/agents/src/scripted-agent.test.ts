// packages/agents/src/scripted-agent.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { FinityGameState, MoveAction, PlayerColor, StationName } from '@finity/engine';
import { ScriptedAgent } from './scripted-agent';
import { MoveAbortedError, type MoveContext } from './interface';

// Minimal fakes — the agent never inspects state, only the move list.
const fakeState = {} as FinityGameState;
const color: PlayerColor = 'cyan';

function ctx(signal?: AbortSignal, moveIndex = 0): MoveContext {
    return { signal: signal ?? new AbortController().signal, moveIndex };
}

const STATIONS: StationName[] = ['N', 'NE', 'SE', 'S', 'SW', 'NW'];
const m = (n: number): MoveAction => ({ type: 'place', station: STATIONS[n % STATIONS.length] });

describe('ScriptedAgent', () => {
    it('returns moves in order and tracks remaining', async () => {
        const agent = new ScriptedAgent([m(1), m(2), m(3)]);
        expect(agent.remaining).toBe(3);
        expect(await agent.move(color, fakeState, ctx())).toEqual(m(1));
        expect(await agent.move(color, fakeState, ctx())).toEqual(m(2));
        expect(agent.remaining).toBe(1);
        expect(await agent.move(color, fakeState, ctx())).toEqual(m(3));
        expect(agent.remaining).toBe(0);
    });

    it('throws when the script is exhausted (default)', async () => {
        const agent = new ScriptedAgent([m(1)]);
        await agent.move(color, fakeState, ctx());
        await expect(agent.move(color, fakeState, ctx())).rejects.toThrow(/exhausted/);
    });

    it('rejects immediately if the signal is already aborted', async () => {
        const agent = new ScriptedAgent([m(1)]);
        const ac = new AbortController();
        ac.abort({ kind: 'new-game' });
        await expect(agent.move(color, fakeState, ctx(ac.signal))).rejects.toBeInstanceOf(MoveAbortedError);
        // The move was NOT consumed.
        expect(agent.remaining).toBe(1);
    });

    it('aborts a delayed move when the signal fires mid-wait', async () => {
        vi.useFakeTimers();
        const agent = new ScriptedAgent([m(1)], { delayMs: 1000 });
        const ac = new AbortController();
        const p = agent.move(color, fakeState, ctx(ac.signal));
        const assertion = expect(p).rejects.toBeInstanceOf(MoveAbortedError);
        ac.abort({ kind: 'timeout' });
        await assertion;
        vi.useRealTimers();
    });

    it('can hang forever to exercise the orchestrator timeout path', async () => {
        const agent = new ScriptedAgent([], { onExhausted: 'hang' });
        let settled = false;
        void agent.move(color, fakeState, ctx()).then(() => (settled = true));
        await Promise.resolve();
        expect(settled).toBe(false);
    });
});
