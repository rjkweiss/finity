// packages/agents/src/human-local.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { FinityGameState, MoveAction, PlayerColor } from '@finity/engine';
import { LocalHumanAgent } from './human-local';
import { MoveAbortedError, type MoveContext } from './interface';

const fakeState = {} as FinityGameState;
const color: PlayerColor = 'cyan';
const ctxFor = (signal: AbortSignal, moveIndex = 0): MoveContext => ({ signal, moveIndex });
const aMove: MoveAction = { type: 'place', station: 'C' };

describe('LocalHumanAgent', () => {
    it('parks a promise that resolves when the UI submits a move', async () => {
        const agent = new LocalHumanAgent();
        const ac = new AbortController();
        const p = agent.move(color, fakeState, ctxFor(ac.signal));
        expect(agent.isAwaitingInput()).toBe(true);
        expect(agent.awaitingColor()).toBe(color);

        expect(agent.submitMove(aMove)).toBe(true);
        expect(await p).toEqual(aMove);
        expect(agent.isAwaitingInput()).toBe(false);
        expect(agent.awaitingColor()).toBe(null);
    });

    it('ignores stray submits when no turn is awaiting', () => {
        const agent = new LocalHumanAgent();
        expect(agent.submitMove(aMove)).toBe(false);
    });

    it('rejects the parked promise when the turn is aborted', async () => {
        const agent = new LocalHumanAgent();
        const ac = new AbortController();
        const p = agent.move(color, fakeState, ctxFor(ac.signal));
        const assertion = expect(p).rejects.toBeInstanceOf(MoveAbortedError);
        ac.abort({ kind: 'resign', color });
        await assertion;
        expect(agent.isAwaitingInput()).toBe(false);
        // A submit after abort is a no-op.
        expect(agent.submitMove(aMove)).toBe(false);
    });

    it('rejects immediately if asked to move with an already-aborted signal', async () => {
        const agent = new LocalHumanAgent();
        const ac = new AbortController();
        ac.abort({ kind: 'new-game' });
        await expect(agent.move(color, fakeState, ctxFor(ac.signal))).rejects.toBeInstanceOf(MoveAbortedError);
        expect(agent.isAwaitingInput()).toBe(false);
    });

    it('notifies awaiting-change listeners on both edges', async () => {
        const agent = new LocalHumanAgent();
        const seen: boolean[] = [];
        agent.onAwaitingChange((a) => seen.push(a));
        const ac = new AbortController();
        const p = agent.move(color, fakeState, ctxFor(ac.signal));
        agent.submitMove(aMove);
        await p;
        expect(seen).toEqual([true, false]);
    });

    it('cancels a stale turn if move() is called again before the first resolves', async () => {
        const agent = new LocalHumanAgent();
        const ac1 = new AbortController();
        const stale = agent.move(color, fakeState, ctxFor(ac1.signal));
        const staleAssertion = expect(stale).rejects.toBeInstanceOf(MoveAbortedError);
        const ac2 = new AbortController();
        const fresh = agent.move(color, fakeState, ctxFor(ac2.signal));
        await staleAssertion;
        agent.submitMove(aMove);
        expect(await fresh).toEqual(aMove);
    });

    it('dispose() rejects any in-flight turn', async () => {
        const agent = new LocalHumanAgent();
        const ac = new AbortController();
        const p = agent.move(color, fakeState, ctxFor(ac.signal));
        const assertion = expect(p).rejects.toBeInstanceOf(MoveAbortedError);
        agent.dispose();
        await assertion;
    });

    it('does not leak the abort listener after a normal submit', async () => {
        const agent = new LocalHumanAgent();
        const ac = new AbortController();
        const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
        const p = agent.move(color, fakeState, ctxFor(ac.signal));
        agent.submitMove(aMove);
        await p;
        expect(removeSpy.mock.calls.length).toBeGreaterThan(0);
    });
});
