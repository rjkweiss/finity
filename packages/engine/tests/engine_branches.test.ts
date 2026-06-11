import { describe, it, expect } from 'vitest';
import {
    createGame,
    applyMove,
    occupiesHighPoint,
    canBlockSlot,
    outArrows,
    getAllRings,
    getAllArrows,
    stationControlledBy,
    topmostOpening,
    arrowCount,
} from '../src/engine';
import type {
    FinityGameState,
    GameConfig,
    MoveAction,
    ArrowState,
    StationName,
    PlayerColor,
    RingState,
} from '../src/types';
import { STATION_SLOTS } from '../src/topology';

// =============================================================
// Fixtures
// =============================================================

const TEST_PATTERN: ('b' | 'w')[] = ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'];

function make4PlayerGame(): FinityGameState {
    return createGame(
        { playerColors: ['cyan', 'yellow', 'red', 'purple'], boardSize: 4 },
        TEST_PATTERN,
    );
}

function make2PlayerGame(): FinityGameState {
    return createGame(
        { playerColors: ['cyan', 'yellow'], boardSize: 2 },
        TEST_PATTERN,
    );
}

function placeArrow(color: 'b' | 'w', from: StationName, to: StationName, slotId: number): MoveAction {
    return {
        type: 'place',
        pieceToAdd: { type: 'arrow', color, fromStation: from, toStation: to, slotId },
    };
}

/** Manually place a ring on a station in the game state (mutates for test setup) */
function setRing(state: FinityGameState, station: StationName, index: 0 | 1 | 2, color: PlayerColor, size: 's' | 'm' | 'l'): void {
    state.board.stations[station].rings[index] = { type: 'ring', color, size };
}

/** Clear all rings from a station (mutates for test setup) */
function clearRings(state: FinityGameState, station: StationName): void {
    state.board.stations[station].rings = [null, null, null];
}

/** Remove base post from a station (mutates for test setup) */
function clearBasePost(state: FinityGameState, station: StationName): void {
    state.board.stations[station].basePost = null;
}

// =============================================================
// canBlockSlot — first-move restriction
// =============================================================

describe('canBlockSlot — first-move restriction branches', () => {
    it('allows any slot after the first move (history > 0)', () => {
        let game = make4PlayerGame();
        // Make one move so history is non-empty
        game = applyMove(game, placeArrow('b', 'C', 'N', 1));

        // Now any slot should be allowed — the restriction only applies on move 0
        // Slot 3 is C→NE:L, adjacent to yellow's base post station NE
        expect(canBlockSlot(game, 3, 'yellow', 'arrow')).toBe(true);
        expect(canBlockSlot(game, 3, 'yellow', 'blocker')).toBe(true);
    });

    it('blocks arrow placement on a slot directly adjacent to opponent base post', () => {
        const game = make4PlayerGame();
        // Cyan is moving first. Yellow's base post is at NE.
        // Slot 3 is C→NE:L — directly on NE's station
        expect(canBlockSlot(game, 3, 'cyan', 'arrow')).toBe(false);
        // Slot 4 is C→NE:C
        expect(canBlockSlot(game, 4, 'cyan', 'arrow')).toBe(false);
        // Slot 5 is C→NE:R
        expect(canBlockSlot(game, 5, 'cyan', 'arrow')).toBe(false);
    });

    it('blocks blocker placement on a slot directly adjacent to opponent base post', () => {
        const game = make4PlayerGame();
        // Slot 9 is C→S:L, S station has no base post in 4-player
        // But slot 6 is C→SE:L, SE has red's base post
        expect(canBlockSlot(game, 6, 'cyan', 'blocker')).toBe(false);
    });

    it('blocks arrow on interfering slot of opponent base post station', () => {
        const game = make4PlayerGame();
        // Slot 2 is C→N:R. It interferes with slots 3 and 27.
        // Slot 3 is C→NE:L, which is adjacent to NE (yellow's base post).
        // So placing in slot 2 as arrow should be blocked because slot 2
        // interferes with slot 3 which is on yellow's station.
        // Actually let me re-check: canBlockSlot checks if slotId is in interference
        // of opponent's station slots, not the reverse. Let me re-read the code.
        //
        // The code iterates opponent stations → their slots → checks if target slotId
        // equals the station slot OR (for arrows) if target slotId is in that slot's interference.
        // So slot 2 would be blocked if it equals or interferes with any slot on NE/SE/SW.
        //
        // Slot 27 is N→NE:R, which IS on NE's station. And SLOT_INTERFERENCES[27] = [2, 3].
        // But the code checks: if interferences of the STATION slot include the TARGET slotId.
        // So for NE slot 27: getSlotInterferences(27) = [2, 3]. Contains 2? Yes.
        // So canBlockSlot(game, 2, 'cyan', 'arrow') should be false.
        expect(canBlockSlot(game, 2, 'cyan', 'arrow')).toBe(false);
    });

    it('allows blocker on interfering slot (interference only checked for arrows)', () => {
        const game = make4PlayerGame();
        // Same slot 2 — for blocker type, interference is NOT checked.
        // Slot 2 itself is C→N:R, NOT directly on NE/SE/SW stations.
        // So blocker placement should be allowed... but wait, slot 2 IS on
        // C→N which doesn't have an opponent base post (N has no base post in 4-player).
        // However, we need to check ALL opponent stations.
        // C→N:R = slot 2 is NOT on NE/SE/SW stations directly.
        // But we need to check: is slot 2 listed as a slot for any opponent station?
        // NE station has slots: NE→E (33,34,35), NE→SE (38,37,36), NE→C (5,4,3), NE→N (27,28,29), NE→FNE (30,31,32)
        // Slot 2 is NOT in that list. So blocker placement at slot 2 should be allowed.
        expect(canBlockSlot(game, 2, 'cyan', 'blocker')).toBe(true);
    });

    it('allows placement on own base post station slots', () => {
        const game = make4PlayerGame();
        // Cyan's base post is at NW. NW→C slots are 17, 16, 15.
        // canBlockSlot only restricts OPPONENT base post stations,
        // not your own. So cyan placing on own station's slots should be fine.
        expect(canBlockSlot(game, 16, 'cyan', 'arrow')).toBe(true);
    });

    it('allows placement on station with no base post', () => {
        const game = make4PlayerGame();
        // N station has no base post in 4-player. C→N:C = slot 1.
        // But we need to check this isn't blocked by OTHER opponent stations' interference.
        // Slot 1 is C→N:C. No interference rules for center channels.
        // And slot 1 is not directly on NE/SE/SW.
        expect(canBlockSlot(game, 1, 'cyan', 'arrow')).toBe(true);
    });

    it('handles 2-player: only one opponent station to check', () => {
        const game = make2PlayerGame();
        // Cyan moves first. Yellow is at S.
        // S station slots via C→S: 9, 10, 11
        expect(canBlockSlot(game, 9, 'cyan', 'arrow')).toBe(false);
        expect(canBlockSlot(game, 10, 'cyan', 'arrow')).toBe(false);
        expect(canBlockSlot(game, 11, 'cyan', 'arrow')).toBe(false);

        // C→N:C = slot 1 (own base post station direction) should be fine
        expect(canBlockSlot(game, 1, 'cyan', 'arrow')).toBe(true);
    });
});

// =============================================================
// occupiesHighPoint — all branch coverage
// =============================================================

describe('occupiesHighPoint — branch coverage', () => {
    it('returns true when player has base post (highest priority)', () => {
        const game = make4PlayerGame();
        // NW has cyan's base post
        expect(occupiesHighPoint(game, 'cyan', 'NW')).toBe(true);
    });

    it('returns false when different player has base post', () => {
        const game = make4PlayerGame();
        // NW has cyan's base post, not yellow's
        expect(occupiesHighPoint(game, 'yellow', 'NW')).toBe(false);
    });

    it('returns true for small ring when no base post', () => {
        const game = make4PlayerGame();
        // N has no base post, place a small cyan ring
        setRing(game, 'N', 0, 'cyan', 's');
        expect(occupiesHighPoint(game, 'cyan', 'N')).toBe(true);
    });

    it('returns false for medium ring when small ring is different color', () => {
        const game = make4PlayerGame();
        clearRings(game, 'N');
        setRing(game, 'N', 0, 'yellow', 's');
        setRing(game, 'N', 1, 'cyan', 'm');
        // Yellow has the small ring (high point), not cyan
        expect(occupiesHighPoint(game, 'cyan', 'N')).toBe(false);
        expect(occupiesHighPoint(game, 'yellow', 'N')).toBe(true);
    });

    it('returns true for medium ring when no small ring', () => {
        const game = make4PlayerGame();
        clearRings(game, 'N');
        setRing(game, 'N', 1, 'cyan', 'm');
        expect(occupiesHighPoint(game, 'cyan', 'N')).toBe(true);
    });

    it('returns true for large ring when no small or medium ring', () => {
        const game = make4PlayerGame();
        clearRings(game, 'N');
        setRing(game, 'N', 2, 'red', 'l');
        expect(occupiesHighPoint(game, 'red', 'N')).toBe(true);
    });

    it('returns false for large ring when small ring exists (different color)', () => {
        const game = make4PlayerGame();
        clearRings(game, 'N');
        setRing(game, 'N', 0, 'cyan', 's');
        setRing(game, 'N', 2, 'red', 'l');
        expect(occupiesHighPoint(game, 'red', 'N')).toBe(false);
        expect(occupiesHighPoint(game, 'cyan', 'N')).toBe(true);
    });

    it('base post overrides all rings', () => {
        const game = make4PlayerGame();
        // NW has cyan base post, put yellow rings on it
        setRing(game, 'NW', 0, 'yellow', 's');
        setRing(game, 'NW', 1, 'yellow', 'm');
        // Base post still wins
        expect(occupiesHighPoint(game, 'cyan', 'NW')).toBe(true);
        expect(occupiesHighPoint(game, 'yellow', 'NW')).toBe(false);
    });

    it('returns false for completely empty station', () => {
        const game = make4PlayerGame();
        clearRings(game, 'N');
        clearBasePost(game, 'N');
        expect(occupiesHighPoint(game, 'cyan', 'N')).toBe(false);
        expect(occupiesHighPoint(game, 'yellow', 'N')).toBe(false);
    });

    it('returns false for non-existent station', () => {
        const game = make2PlayerGame();
        // FNW doesn't exist in 2-player
        expect(occupiesHighPoint(game, 'cyan', 'FNW')).toBe(false);
    });
});

// =============================================================
// stationControlledBy — branch coverage
// =============================================================

describe('stationControlledBy — branch coverage', () => {
    it('base post color controls station', () => {
        const game = make4PlayerGame();
        expect(stationControlledBy(game.board.stations['NW'])).toBe('cyan');
    });

    it('small ring controls when no base post', () => {
        const game = make4PlayerGame();
        setRing(game, 'N', 0, 'red', 's');
        expect(stationControlledBy(game.board.stations['N'])).toBe('red');
    });

    it('medium ring controls when no base post and no small ring', () => {
        const game = make4PlayerGame();
        clearRings(game, 'N');
        setRing(game, 'N', 1, 'purple', 'm');
        expect(stationControlledBy(game.board.stations['N'])).toBe('purple');
    });

    it('large ring controls when nothing else', () => {
        const game = make4PlayerGame();
        clearRings(game, 'N');
        setRing(game, 'N', 2, 'yellow', 'l');
        expect(stationControlledBy(game.board.stations['N'])).toBe('yellow');
    });

    it('empty station is controlled by null', () => {
        const game = make4PlayerGame();
        expect(stationControlledBy(game.board.stations['N'])).toBeNull();
    });
});

// =============================================================
// topmostOpening — branch coverage
// =============================================================

describe('topmostOpening — all cases', () => {
    it('empty station opens at s', () => {
        const game = make4PlayerGame();
        expect(topmostOpening(game.board.stations['N'])).toBe('s');
    });

    it('station with small ring opens at m', () => {
        const game = make4PlayerGame();
        setRing(game, 'N', 0, 'cyan', 's');
        expect(topmostOpening(game.board.stations['N'])).toBe('m');
    });

    it('station with small+medium rings opens at l', () => {
        const game = make4PlayerGame();
        setRing(game, 'N', 0, 'cyan', 's');
        setRing(game, 'N', 1, 'yellow', 'm');
        expect(topmostOpening(game.board.stations['N'])).toBe('l');
    });

    it('station with all three rings returns null (full)', () => {
        const game = make4PlayerGame();
        setRing(game, 'N', 0, 'cyan', 's');
        setRing(game, 'N', 1, 'yellow', 'm');
        setRing(game, 'N', 2, 'red', 'l');
        expect(topmostOpening(game.board.stations['N'])).toBeNull();
    });
});

// =============================================================
// outArrows
// =============================================================

describe('outArrows', () => {
    it('returns empty for station with no arrows', () => {
        const game = make4PlayerGame();
        expect(outArrows(game, 'C', 'b')).toHaveLength(0);
        expect(outArrows(game, 'C', 'w')).toHaveLength(0);
    });

    it('finds outgoing black arrow from a station', () => {
        let game = make4PlayerGame();
        // Place black arrow from C to N in slot 1
        game = applyMove(game, placeArrow('b', 'C', 'N', 1));

        const blackArrows = outArrows(game, 'C', 'b');
        expect(blackArrows).toHaveLength(1);
        expect(blackArrows[0].fromStation).toBe('C');
        expect(blackArrows[0].toStation).toBe('N');
        expect(blackArrows[0].color).toBe('b');
    });

    it('does not return arrows going TO the station (only outgoing)', () => {
        let game = make4PlayerGame();
        // Arrow goes FROM C TO N — should appear in outArrows(C) but not outArrows(N)
        game = applyMove(game, placeArrow('b', 'C', 'N', 1));

        expect(outArrows(game, 'C', 'b')).toHaveLength(1);
        expect(outArrows(game, 'N', 'b')).toHaveLength(0);
    });

    it('filters by arrow color', () => {
        let game = make4PlayerGame();
        game = applyMove(game, placeArrow('b', 'C', 'N', 1));
        // Next player places white arrow
        game = applyMove(game, placeArrow('w', 'C', 'S', 10));

        expect(outArrows(game, 'C', 'b')).toHaveLength(1);
        expect(outArrows(game, 'C', 'w')).toHaveLength(1);
    });

    it('finds multiple arrows from same station same color', () => {
        let game = make4PlayerGame();
        game = applyMove(game, placeArrow('b', 'C', 'N', 1));  // cyan
        game = applyMove(game, placeArrow('b', 'C', 'S', 10)); // yellow
        game = applyMove(game, placeArrow('b', 'C', 'SE', 7)); // red

        // C now has black arrows going to N, S, and SE
        expect(outArrows(game, 'C', 'b')).toHaveLength(3);
    });

    it('returns empty for non-existent station', () => {
        const game = make2PlayerGame();
        expect(outArrows(game, 'FNW', 'b')).toHaveLength(0);
    });
});

// =============================================================
// getAllRings
// =============================================================

describe('getAllRings', () => {
    it('returns initial center rings in 4-player game', () => {
        const game = make4PlayerGame();
        const rings = getAllRings(game);
        expect(rings).toHaveLength(3); // 3 rings on center
        rings.forEach(r => {
            expect(r.station).toBe('C');
            expect(r.size).toBe('l');
        });
    });

    it('returns rings from multiple stations', () => {
        const game = make4PlayerGame();
        setRing(game, 'N', 0, 'cyan', 's');
        setRing(game, 'S', 0, 'yellow', 's');
        setRing(game, 'S', 1, 'yellow', 'm');

        const rings = getAllRings(game);
        // 3 center + 1 on N + 2 on S = 6
        expect(rings).toHaveLength(6);

        const nRings = rings.filter(r => r.station === 'N');
        expect(nRings).toHaveLength(1);
        expect(nRings[0].color).toBe('cyan');

        const sRings = rings.filter(r => r.station === 'S');
        expect(sRings).toHaveLength(2);
    });

    it('returns empty when no rings on board', () => {
        const game = make4PlayerGame();
        // Clear center rings
        clearRings(game, 'C');
        expect(getAllRings(game)).toHaveLength(0);
    });
});

// =============================================================
// applyMove — edge cases
// =============================================================

describe('applyMove — interference edge cases', () => {
    it('double blocking: two arrows each blocking a shared slot', () => {
        let game = make4PlayerGame();
        // Slot 0 interferes with [17, 18]
        // Slot 2 interferes with [3, 27]
        game = applyMove(game, placeArrow('b', 'C', 'N', 0));  // blocks 17, 18
        game = applyMove(game, placeArrow('w', 'C', 'N', 2));  // blocks 3, 27

        expect(game.board.slots[17].blocked).toBe(true);
        expect(game.board.slots[18].blocked).toBe(true);
        expect(game.board.slots[3].blocked).toBe(true);
        expect(game.board.slots[27].blocked).toBe(true);

        // Removing one arrow should unblock ITS targets but not the other's
        const removeFirst: MoveAction = {
            type: 'remove',
            pieceToRemove: { type: 'arrow', color: 'b', fromStation: 'C', toStation: 'N', slotId: 0 },
        };
        const next = applyMove(game, removeFirst);
        expect(next.board.slots[17].blocked).toBe(false);
        expect(next.board.slots[18].blocked).toBe(false);
        // These should still be blocked from the second arrow
        expect(next.board.slots[3].blocked).toBe(true);
        expect(next.board.slots[27].blocked).toBe(true);
    });

    it('arrow reversal preserves interference (same slot, different direction)', () => {
        let game = make4PlayerGame();
        game = applyMove(game, placeArrow('b', 'C', 'N', 0));
        expect(game.board.slots[17].blocked).toBe(true);

        // Reverse: C→N becomes N→C in same slot
        const reverseMove: MoveAction = {
            type: 'replace',
            pieceToRemove: { type: 'arrow', color: 'b', fromStation: 'C', toStation: 'N', slotId: 0 },
            pieceToAdd: { type: 'arrow', color: 'b', fromStation: 'N', toStation: 'C', slotId: 0 },
        };
        const next = applyMove(game, reverseMove);

        // Slot still occupied, interference should still be active
        expect(next.board.slots[0].contains).not.toBeNull();
        expect(next.board.slots[17].blocked).toBe(true);
    });

    it('multiple arrows on the board accumulate correctly', () => {
        let game = make4PlayerGame();
        game = applyMove(game, placeArrow('b', 'C', 'N', 1));
        game = applyMove(game, placeArrow('w', 'C', 'S', 10));
        game = applyMove(game, placeArrow('b', 'C', 'SE', 7));
        game = applyMove(game, placeArrow('w', 'C', 'NW', 16));

        expect(arrowCount(game)).toBe(4);
        expect(getAllArrows(game)).toHaveLength(4);
    });
});

describe('applyMove — blocker move (replace)', () => {
    it('moves blocker from one slot to another', () => {
        const game = make4PlayerGame();
        // Find cyan's first blocker
        const blockerSlot = game.board.slots.find(
            s => s.contains?.type === 'blocker' && (s.contains as any).color === 'cyan'
        );
        expect(blockerSlot).toBeDefined();
        const oldSlotId = blockerSlot!.id;
        const newSlotId = 1; // C→N:C, should be empty

        const move: MoveAction = {
            type: 'replace',
            pieceToRemove: { type: 'blocker', color: 'cyan', slotId: oldSlotId },
            pieceToAdd: { type: 'blocker', color: 'cyan', slotId: newSlotId },
        };
        const next = applyMove(game, move);

        expect(next.board.slots[oldSlotId].contains).toBeNull();
        expect(next.board.slots[newSlotId].contains).not.toBeNull();
        expect(next.board.slots[newSlotId].contains!.type).toBe('blocker');
    });
});
