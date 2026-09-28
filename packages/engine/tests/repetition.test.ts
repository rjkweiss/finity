// Repetition rule (Tony): a board arrangement may not occur a third time —
// whose turn it is does not matter. The move that makes it occur for the third
// time voids the game, which counts as a loss for every player.
//
// The cycle used throughout: cyan places an arrow, yellow places an arrow,
// cyan removes hers, yellow removes his. After those four plies the board is
// empty again with cyan to move — the starting position, one more time.

import { describe, it, expect } from 'vitest';
import {
    applyMove,
    basePostStation,
    boardHash,
    createGame,
    legalMoves,
    type ArrowColor,
    type ArrowState,
    type FinityGameState,
    type GameConfig,
    type MoveAction,
    type PlayerColor,
} from '../src/index';

const PATTERN: ArrowColor[] = ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'];

function game(repetitionLimit?: number): FinityGameState {
    const config: GameConfig = { playerColors: ['cyan', 'yellow'], boardSize: 2 };
    if (repetitionLimit !== undefined) config.repetitionLimit = repetitionLimit;

    return createGame(config, PATTERN);
}

// A player may remove an arrow pointing INTO a station whose high point they
// hold, so each side places its arrow into its own base-post station.
const firstPlacement = (s: FinityGameState, c: PlayerColor): MoveAction => {
    const home = basePostStation(s, c);
    const m = legalMoves(s, c).find(
        (x) => x.type === 'place' && x.pieceToAdd?.type === 'arrow' && x.pieceToAdd.toStation === home
    );
    if (!m) throw new Error(`no arrow placement into ${home} for ${c}`);
    return m;
};

const removalOf = (s: FinityGameState, c: PlayerColor, slotId: number): MoveAction => {
    const m = legalMoves(s, c).find((x) => x.type === 'remove' && x.pieceToRemove?.slotId === slotId);
    if (!m) throw new Error(`${c} cannot remove the arrow in slot ${slotId}`);
    return m;
};

/** The four moves of one cycle, computed from the start position. */
function cycleMoves(start: FinityGameState): MoveAction[] {
    const a = firstPlacement(start, 'cyan');
    const s1 = applyMove(start, a);
    const b = firstPlacement(s1, 'yellow');
    const s2 = applyMove(s1, b);
    const slotA = (a.pieceToAdd as { slotId: number }).slotId;
    const slotB = (b.pieceToAdd as { slotId: number }).slotId;
    const ra = removalOf(s2, 'cyan', slotA);
    const s3 = applyMove(s2, ra);
    const rb = removalOf(s3, 'yellow', slotB);

    return [a, b, ra, rb];
}

/** Play `cycles` full cycles, stopping early if the game ends. */
function playCycles(start: FinityGameState, cycles: number): FinityGameState {
    const moves = cycleMoves(start);
    let s = start;
    for (let i = 0; i < cycles * 4 && s.playStatus !== 'over'; i++) s = applyMove(s, moves[i % 4]);

    return s;
}

describe('repetition rule', () => {
    it('counts the starting position once', () => {
        const s = game();
        expect(s.positionCounts?.[boardHash(s)]).toBe(1);
    });

    it('allows a position to occur twice', () => {
        const start = game();
        const s = playCycles(start, 1);
        expect(boardHash(s)).toBe(boardHash(start));
        expect(s.positionCounts?.[boardHash(start)]).toBe(2);
        expect(s.playStatus).toBe('playing');
    });

    it('voids the game on the third occurrence', () => {
        const start = game();
        const s = playCycles(start, 2);
        expect(s.playStatus).toBe('over');
        expect(s.endReason).toBe('repetition');
        expect(s.winners).toEqual([]);
        expect(s.moveHistory.length).toBe(8);
    });

    it('can be disabled with repetitionLimit 0 (for replaying BGA games)', () => {
        const s = playCycles(game(0), 3);
        expect(s.playStatus).toBe('playing');
        expect(s.moveHistory.length).toBe(12);
    });

    it('honours a custom limit', () => {
        const start = game(5);
        const early = playCycles(start, 3);
        expect(early.playStatus).toBe('playing');
        const s = playCycles(start, 4);
        expect(s.endReason).toBe('repetition');
        expect(s.moveHistory.length).toBe(16);
    });

    it('counts the same board as a repeat whichever player is to move', () => {
        // Three plies that restore the empty board with YELLOW to move — the
        // start had cyan to move. Applied directly (legality is not the point
        // here): cyan places an arrow, yellow reverses it, cyan removes it.
        const start = game();
        const place = firstPlacement(start, 'cyan');
        const s1 = applyMove(start, place);
        const slotId = (place.pieceToAdd as { slotId: number }).slotId;
        const arrow = s1.board.slots[slotId].contains as ArrowState;
        const flipped: ArrowState = { ...arrow, fromStation: arrow.toStation, toStation: arrow.fromStation };
        const s2 = applyMove(s1, { type: 'replace', pieceToRemove: arrow, pieceToAdd: flipped });
        const s3 = applyMove(s2, { type: 'remove', pieceToRemove: flipped });

        expect(s3.zobristHash).not.toBe(start.zobristHash); // different side to move...
        expect(boardHash(s3)).toBe(boardHash(start));        // ...same board
        expect(s3.positionCounts?.[boardHash(start)]).toBe(2);
    });
});
