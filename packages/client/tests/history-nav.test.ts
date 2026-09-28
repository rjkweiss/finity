import { describe, it, expect } from 'vitest';
import {
    applyMove,
    createGame,
    currentPlayer,
    legalMoves,
    type ArrowColor,
    type FinityGameState,
} from '@finity/engine';
import { historyLabel, navigateHistory, positionAt } from '../src/HistoryNav';

const PATTERN: ArrowColor[] = ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'];

describe('navigateHistory', () => {
    it('back from live shows the position before the last move', () => {
        expect(navigateHistory(null, 10, 'back')).toBe(9);
    });

    it('back steps one position at a time and stops at the start', () => {
        expect(navigateHistory(5, 10, 'back')).toBe(4);
        expect(navigateHistory(0, 10, 'back')).toBe(0);
    });

    it('back respects the earliest available position', () => {
        expect(navigateHistory(3, 10, 'back', 3)).toBe(3);
    });

    it('forward steps toward the present and returns to live at the end', () => {
        expect(navigateHistory(4, 10, 'forward')).toBe(5);
        expect(navigateHistory(9, 10, 'forward')).toBe(null);
    });

    it('forward while live stays live', () => {
        expect(navigateHistory(null, 10, 'forward')).toBe(null);
    });

    it('live always returns to the live game', () => {
        expect(navigateHistory(2, 10, 'live')).toBe(null);
    });

    it('back with no moves played stays live', () => {
        expect(navigateHistory(null, 0, 'back')).toBe(null);
    });
});

describe('positionAt', () => {
    function playSome(n: number): { start: FinityGameState; states: FinityGameState[] } {
        const start = createGame({ playerColors: ['cyan', 'yellow'], boardSize: 2 }, PATTERN);
        const states = [start];
        let s = start;
        for (let i = 0; i < n && s.playStatus !== 'over'; i++) {
            s = applyMove(s, legalMoves(s, currentPlayer(s))[i % 3]);
            states.push(s);
        }

        return { start, states };
    }

    it('rebuilds exactly the position that was on the board', () => {
        const { start, states } = playSome(12);
        const live = states[states.length - 1];
        for (let k = 0; k < states.length; k++) {
            expect(positionAt(start, live.moveHistory, k).zobristHash).toBe(states[k].zobristHash);
        }
    });

    it('position 0 is the starting position', () => {
        const { start, states } = playSome(6);
        expect(positionAt(start, states[6].moveHistory, 0)).toBe(start);
    });
});

describe('historyLabel', () => {
    it('is empty while live', () => {
        expect(historyLabel(null, 10)).toBe(null);
    });

    it('names the position being shown', () => {
        expect(historyLabel(0, 10)).toContain('starting position');
        expect(historyLabel(4, 10)).toContain('after move 4 of 10');
    });
});
