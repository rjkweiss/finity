import { describe, it, expect } from 'vitest';
import {
    createGame,
    applyMove,
    getAllArrows,
} from '../src/index';
import { possibleMoves } from '../src/possible-moves';
import type {
    FinityGameState,
    MoveAction,
    StationName,
    ArrowColor,
} from '../src/types';

// =============================================================
// Fixtures
// =============================================================

const PATTERN: ArrowColor[] = ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'];

function make2p(): FinityGameState {
    return createGame({ playerColors: ['cyan', 'red'], boardSize: 2 }, PATTERN);
}

function kindOf(m: MoveAction): string {
    const piece = m.pieceToAdd ?? m.pieceToRemove;
    return `${m.type}:${piece?.type ?? '?'}`;
}

function countByKind(moves: MoveAction[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const m of moves) out[kindOf(m)] = (out[kindOf(m)] ?? 0) + 1;
    return out;
}

// =============================================================
// The core invariant: generated moves are always applicable
// =============================================================

describe('possibleMoves — apply invariant', () => {
    it('every generated move applies without throwing (initial board)', () => {
        const game = make2p();
        const moves = possibleMoves(game);
        expect(moves.length).toBeGreaterThan(0);
        for (const m of moves) {
            expect(() => applyMove(game, m)).not.toThrow();
        }
    });

    it('every generated move applies without throwing (mid-game)', () => {
        let game = make2p();
        const arrows = possibleMoves(game).filter(
            m => m.type === 'place' && m.pieceToAdd?.type === 'arrow',
        );
        for (let i = 0; i < 6 && i < arrows.length; i++) game = applyMove(game, arrows[i]);

        for (const m of possibleMoves(game)) {
            expect(() => applyMove(game, m)).not.toThrow();
        }
    });
});

// =============================================================
// Initial-board shape
// =============================================================

describe('possibleMoves — initial 2-player board', () => {
    it('offers only blocker relocations and arrow placements', () => {
        const kinds = countByKind(possibleMoves(make2p()));
        expect(kinds['replace:blocker']).toBeGreaterThan(0);
        expect(kinds['place:arrow']).toBeGreaterThan(0);
        // nothing else is legal yet
        expect(kinds['place:ring']).toBeUndefined();
        expect(kinds['replace:basePost']).toBeUndefined();
        expect(kinds['remove:arrow']).toBeUndefined();
        expect(kinds['replace:arrow']).toBeUndefined();
        expect(kinds['remove:blocker']).toBeUndefined();
    });

    it('generates both arrow colors', () => {
        const colors = new Set(
            possibleMoves(make2p())
                .filter(m => m.pieceToAdd?.type === 'arrow')
                .map(m => (m.pieceToAdd as { color: ArrowColor }).color),
        );
        expect(colors.has('b')).toBe(true);
        expect(colors.has('w')).toBe(true);
    });
});

// =============================================================
// Rule decisions (A) center exclusion, (B) no-undo on removal
// =============================================================

describe('possibleMoves — UI-aligned rule decisions', () => {
    it('never proposes a ring on center C', () => {
        // Drive a few moves in and assert no ring move ever targets 'C'.
        let game = make2p();
        for (let step = 0; step < 8; step++) {
            const moves = possibleMoves(game);
            for (const m of moves) {
                if (m.type === 'place' && m.pieceToAdd?.type === 'ring') {
                    expect(m.station).not.toBe('C' as StationName);
                }
            }
            const next = moves.find(m => m.type === 'place' && m.pieceToAdd?.type === 'arrow');
            if (!next) break;
            game = applyMove(game, next);
        }
    });
});

// =============================================================
// Blocker removal threshold (>20 arrows)
// =============================================================

describe('possibleMoves — opponent blocker removal threshold', () => {
    function stuffArrows(state: FinityGameState, n: number): FinityGameState {
        const next = structuredClone(state) as FinityGameState;
        let placed = 0;
        for (const slot of next.board.slots) {
            if (placed >= n) break;
            if (slot.contains === null) {
                slot.contains = {
                    type: 'arrow', color: 'b',
                    fromStation: 'N', toStation: 'C', slotId: slot.id,
                };
                placed++;
            }
        }
        return next;
    }

    it('no opponent-blocker-remove moves at or below 20 arrows', () => {
        const game = stuffArrows(make2p(), 20);
        expect(getAllArrows(game).length).toBe(20);
        const kinds = countByKind(possibleMoves(game, 'cyan'));
        expect(kinds['remove:blocker']).toBeUndefined();
    });

    it('opponent blockers become removable past 20 arrows', () => {
        const game = stuffArrows(make2p(), 21);
        expect(getAllArrows(game).length).toBe(21);
        const removeBlockers = possibleMoves(game, 'cyan').filter(
            m => m.type === 'remove' && m.pieceToRemove?.type === 'blocker',
        );
        // red starts with 2 blockers; all become removable by cyan
        expect(removeBlockers.length).toBe(2);
        for (const m of removeBlockers) {
            expect((m.pieceToRemove as { color: string }).color).toBe('red');
        }
    });
});
