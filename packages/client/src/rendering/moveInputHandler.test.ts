// packages/client/src/rendering/moveInputHandler.test.ts
//
// The state machine is tested with an INJECTED legal-move list, so it doesn't depend
// on the real possibleMoves() output. (The extractor functions are exercised
// indirectly; reconcile them separately against the real engine — MISS #7.)

import { describe, it, expect, vi } from 'vitest';
import type { FinityGameState, MoveAction, PlayerColor, StationName } from '@finity/engine';
import { MoveInputHandler, primaryTarget, moveCategory } from './moveInputHandler';

const state = {} as FinityGameState;
const color: PlayerColor = 'cyan';

const ringAt = (s: StationName): MoveAction => ({ type: 'place', station: s, pieceToAdd: { type: 'ring', color, size: 's' } });
const arrowOn = (slotId: number, c: 'b' | 'w'): MoveAction => ({
    type: 'place',
    pieceToAdd: { type: 'arrow', color: c, fromStation: 'NW', toStation: 'N', slotId },
});

function makeHandler(legal: MoveAction[], submit = vi.fn(() => true)) {
    const handler = new MoveInputHandler({ submit, getLegalMoves: () => legal });
    handler.refresh(state, color);
    return { handler, submit };
}

describe('MoveInputHandler', () => {
    it('exposes one selectable target per distinct target', () => {
        const { handler } = makeHandler([ringAt('N'), ringAt('NE'), arrowOn(5, 'b')]);
        const targets = handler.selectableTargets();
        expect(targets).toContainEqual({ kind: 'station', station: 'N' });
        expect(targets).toContainEqual({ kind: 'station', station: 'NE' });
        expect(targets).toContainEqual({ kind: 'slot', slotId: 5 });
        expect(targets.length).toBe(3);
    });

    it('submits immediately when a target maps to exactly one legal move', () => {
        const { handler, submit } = makeHandler([ringAt('N'), ringAt('NE')]);
        expect(handler.selectTarget({ kind: 'station', station: 'N' })).toBe(true);
        expect(submit).toHaveBeenCalledWith(ringAt('N'));
        expect(handler.getPhase().phase).toBe('selecting');
    });

    it('ignores a target with no legal move', () => {
        const { handler, submit } = makeHandler([ringAt('N')]);
        expect(handler.selectTarget({ kind: 'slot', slotId: 99 })).toBe(false);
        expect(submit).not.toHaveBeenCalled();
    });

    it('enters disambiguation when a target maps to several moves, then submits the chosen one', () => {
        const { handler, submit } = makeHandler([arrowOn(5, 'b'), arrowOn(5, 'w')]);
        const entered = handler.selectTarget({ kind: 'slot', slotId: 5 });
        expect(entered).toBe(true);
        const phase = handler.getPhase();
        expect(phase.phase).toBe('disambiguating');
        if (phase.phase !== 'disambiguating') throw new Error('unreachable');
        expect(phase.options.length).toBe(2);
        expect(handler.selectOption(phase.options[1].id)).toBe(true);
        expect(submit).toHaveBeenCalledWith(arrowOn(5, 'w'));
        expect(handler.getPhase().phase).toBe('selecting');
    });

    it('category filter narrows selectable targets', () => {
        const { handler } = makeHandler([ringAt('N'), arrowOn(5, 'b')]);
        handler.setCategoryFilter('ring');
        expect(handler.selectableTargets()).toEqual([{ kind: 'station', station: 'N' }]);
        handler.setCategoryFilter(null);
        expect(handler.selectableTargets().length).toBe(2);
    });

    it('cancelSelection backs out of disambiguation', () => {
        const { handler } = makeHandler([arrowOn(5, 'b'), arrowOn(5, 'w')]);
        handler.selectTarget({ kind: 'slot', slotId: 5 });
        handler.cancelSelection();
        expect(handler.getPhase().phase).toBe('selecting');
    });

    it('fires onChange on refresh and selection transitions', () => {
        const onChange = vi.fn();
        const handler = new MoveInputHandler({ submit: () => true, getLegalMoves: () => [arrowOn(5, 'b'), arrowOn(5, 'w')], onChange });
        handler.refresh(state, color);
        handler.selectTarget({ kind: 'slot', slotId: 5 });
        expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
});

describe('extractors (reconcile with real engine — MISS #7)', () => {
    it('maps a ring placement to its station', () => {
        expect(primaryTarget(ringAt('NE'))).toEqual({ kind: 'station', station: 'NE' });
        expect(moveCategory(ringAt('NE'))).toBe('ring');
    });
    it('maps an arrow placement to its slot', () => {
        expect(primaryTarget(arrowOn(7, 'b'))).toEqual({ kind: 'slot', slotId: 7 });
        expect(moveCategory(arrowOn(7, 'b'))).toBe('arrow');
    });
    it('maps a removal to the removed piece slot', () => {
        const remove: MoveAction = { type: 'remove', pieceToRemove: { type: 'arrow', color: 'b', fromStation: 'N', toStation: 'C', slotId: 3 } };
        expect(primaryTarget(remove)).toEqual({ kind: 'slot', slotId: 3 });
        expect(moveCategory(remove)).toBe('remove');
    });
});
