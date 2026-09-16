/**
 * Finity Game Engine — No immediate undo
 *
 * The rulebook states TWO separate rules here, and the old tests conflated
 * them. Both are covered below.
 *
 *   RULE 1 (state-based). "It is forbidden to make a move that immediately
 *   undoes a previous move and leaves the board in an identical state to
 *   before that move... If the previous player's reversing the bridge had
 *   created orphan rings that were removed from the board, then reversing the
 *   bridge back is legal, because the board state has changed."
 *
 *   The test is BOARD IDENTITY, not move shape. The orphan exception is the
 *   part the old shape-based guard could not express, and the part nothing
 *   previously tested — it is the reason QUIRK B looked like an unsupported
 *   quirk rather than a printed rule.
 *
 *   RULE 2 (shape-based). "If a bridge is removed from the board, a bridge of
 *   the same color in either direction may not be immediately placed in the
 *   slot that the previous bridge was just removed from."
 *
 *   This one is STRICTER than board identity: replacing the bridge in the
 *   opposite direction produces a different board and is still forbidden. So
 *   it stays shape-based, and lives in violatesReplacementRule.
 */

import { describe, it, expect } from 'vitest';
import { createGame, applyMove } from '../src/engine';
import { possibleMoves, legalMoves } from '../src/possible-moves';
import {
    boardHash,
    filterImmediateUndo,
    violatesReplacementRule,
} from '../src/no-undo';
import { STATION_SLOTS } from '../src/topology';
import type {
    ArrowColor,
    ArrowState,
    FinityGameState,
    MoveAction,
    StationName,
} from '../src/types';

// =============================================================
// Fixtures
// =============================================================

const TEST_PATTERN: ArrowColor[] = ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'];

/** 2-player board. Base posts land on N (cyan) and S (yellow). */
function make2p(): FinityGameState {
    return createGame(
        { playerColors: ['cyan', 'yellow'], boardSize: 2 },
        TEST_PATTERN,
    );
}

/** Drop an arrow straight onto the board, bypassing move generation, so a
 *  scenario can be set up without burning turns that would themselves become
 *  the "previous move". */
function putArrow(
    state: FinityGameState,
    from: StationName,
    to: StationName,
    channel: 'L' | 'C' | 'R',
    color: ArrowColor,
): number {
    const slotId = STATION_SLOTS[from][to]![channel]!;
    state.board.slots[slotId].contains = {
        type: 'arrow', color, fromStation: from, toStation: to, slotId,
    };
    return slotId;
}

function reverseOf(arrow: ArrowState): MoveAction {
    return {
        type: 'replace',
        pieceToRemove: arrow,
        pieceToAdd: {
            ...arrow,
            fromStation: arrow.toStation,
            toStation: arrow.fromStation,
        },
    };
}

/** Reversal moves targeting one slot, before and after the undo filter. */
function reversalsInSlot(state: FinityGameState, slotId: number) {
    const match = (m: MoveAction) =>
        m.type === 'replace' &&
        m.pieceToAdd?.type === 'arrow' &&
        (m.pieceToAdd as ArrowState).slotId === slotId;
    return {
        generated: possibleMoves(state).filter(match),
        legal: legalMoves(state).filter(match),
    };
}

function placementsInSlot(
    state: FinityGameState, slotId: number, color: ArrowColor,
) {
    return possibleMoves(state).filter(
        (m) =>
            m.type === 'place' &&
            m.pieceToAdd?.type === 'arrow' &&
            (m.pieceToAdd as ArrowState).slotId === slotId &&
            (m.pieceToAdd as ArrowState).color === color,
    );
}

// =============================================================
// boardHash
// =============================================================

describe('boardHash', () => {
    it('ignores whose turn it is', () => {
        const game = make2p();
        expect(boardHash({ ...game, turnIndex: 0 }))
            .toBe(boardHash({ ...game, turnIndex: 1 }));
    });

    it('changes when a piece moves', () => {
        const before = make2p();
        const after = structuredClone(before) as FinityGameState;
        putArrow(after, 'N', 'NW', 'C', 'b');
        expect(boardHash(after)).not.toBe(boardHash(before));
    });
});

// =============================================================
// prevBoardHash bookkeeping
// =============================================================

describe('prevBoardHash', () => {
    it('is undefined on a fresh game', () => {
        expect(make2p().prevBoardHash).toBeUndefined();
    });

    it('records the board as it stood before the last applied move', () => {
        const game = make2p();
        const before = boardHash(game);
        const move = possibleMoves(game).find(
            (m) => m.type === 'place' && m.pieceToAdd?.type === 'arrow',
        )!;
        expect(applyMove(game, move).prevBoardHash).toBe(before);
    });
});

// =============================================================
// RULE 1 — state-based
// =============================================================

describe('no immediate undo — RULE 1, board identity', () => {
    it('does not filter anything on the first move of the game', () => {
        const game = make2p();
        expect(legalMoves(game)).toHaveLength(possibleMoves(game).length);
    });

    it('forbids reversing a bridge straight back', () => {
        const game = make2p();
        const slotId = putArrow(game, 'NE', 'E', 'C', 'b');
        const arrow = game.board.slots[slotId].contains as ArrowState;

        const reversed = applyMove(game, reverseOf(arrow));
        const { generated, legal } = reversalsInSlot(reversed, slotId);

        expect(generated).toHaveLength(1); // possibleMoves still offers it
        expect(legal).toHaveLength(0);     // legalMoves removes it
    });

    it('allows the reverse-back when the first reversal orphaned rings', () => {
        const game = make2p();
        const slotId = putArrow(game, 'N', 'NW', 'C', 'b');
        game.board.stations.NW.rings[0] = { type: 'ring', color: 'cyan', size: 's' };
        expect(game.board.stations.NW.rings.filter(Boolean)).toHaveLength(1);

        const arrow = game.board.slots[slotId].contains as ArrowState;
        const reversed = applyMove(game, reverseOf(arrow));

        expect(reversed.board.stations.NW.rings.filter(Boolean)).toHaveLength(0);

        const { legal } = reversalsInSlot(reversed, slotId);
        expect(legal.length).toBeGreaterThan(0);
    });

    it('leaves moves unrelated to the previous one untouched', () => {
        const game = make2p();
        const slotId = putArrow(game, 'NE', 'E', 'C', 'b');
        const arrow = game.board.slots[slotId].contains as ArrowState;
        const reversed = applyMove(game, reverseOf(arrow));

        const generated = possibleMoves(reversed);
        const legal = legalMoves(reversed);

        // Exactly one move disappears: the reverse-back.
        expect(generated.length - legal.length).toBe(1);
    });

    it('filterImmediateUndo tolerates a candidate that will not apply', () => {
        // The filter applies each suspect candidate to hash the result. A
        // candidate that throws must not take down the whole move list.
        const game = make2p();
        const slotId = putArrow(game, 'NE', 'E', 'C', 'b');
        const arrow = game.board.slots[slotId].contains as ArrowState;
        const reversed = applyMove(game, reverseOf(arrow));

        const exploding = () => { throw new Error('nope'); };
        expect(() =>
            filterImmediateUndo(reversed, possibleMoves(reversed), exploding as never),
        ).not.toThrow();
    });
});

// =============================================================
// RULE 2 — shape-based
// =============================================================

describe('no immediate undo — RULE 2, replacement after removal', () => {
    /** Removes a bridge pointing into E, which cyan controls via a ring. */
    function afterRemovingBridgeIntoE() {
        const game = make2p();
        const slotId = putArrow(game, 'NE', 'E', 'C', 'b');
        game.board.stations.E.rings[0] = { type: 'ring', color: 'cyan', size: 's' };
        const arrow = game.board.slots[slotId].contains as ArrowState;
        return {
            slotId,
            state: applyMove(game, { type: 'remove', pieceToRemove: arrow }),
        };
    }

    it('allows any placement when history is empty', () => {
        expect(violatesReplacementRule(make2p(), 1, 'b')).toBe(false);
    });

    it('forbids the same colour in the slot just vacated', () => {
        const { slotId, state } = afterRemovingBridgeIntoE();
        expect(violatesReplacementRule(state, slotId, 'b')).toBe(true);
        expect(placementsInSlot(state, slotId, 'b')).toHaveLength(0);
    });

    it('forbids the same colour in EITHER direction', () => {
        const { slotId, state } = afterRemovingBridgeIntoE();
        const sameColour = possibleMoves(state).filter(
            (m) =>
                m.type === 'place' &&
                m.pieceToAdd?.type === 'arrow' &&
                (m.pieceToAdd as ArrowState).slotId === slotId &&
                (m.pieceToAdd as ArrowState).color === 'b',
        );
        expect(sameColour).toHaveLength(0);
    });

    it('allows the other colour in the same slot', () => {
        const { slotId, state } = afterRemovingBridgeIntoE();
        expect(violatesReplacementRule(state, slotId, 'w')).toBe(false);
        // Both directions are available for the permitted colour.
        expect(placementsInSlot(state, slotId, 'w').length).toBeGreaterThan(0);
    });

    it('is enforced by possibleMoves, not only by legalMoves', () => {
        const { slotId, state } = afterRemovingBridgeIntoE();
        const inGenerated = possibleMoves(state).some(
            (m) =>
                m.type === 'place' &&
                m.pieceToAdd?.type === 'arrow' &&
                (m.pieceToAdd as ArrowState).slotId === slotId &&
                (m.pieceToAdd as ArrowState).color === 'b',
        );
        expect(inGenerated).toBe(false);
    });
});
