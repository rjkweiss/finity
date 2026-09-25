/**
 * History navigation for the Play view: step back through earlier positions
 * and return to the live game, without undoing anything.
 *
 * Viewing history never changes the game. The orchestrator's state stays
 * where it is; the view simply shows an earlier position, rebuilt by replaying
 * moves from the start. Play resumes from the live position.
 *
 * Kept free of React so the rules can be tested directly.
 */

import { applyMove, type FinityGameState, type RecordedMove } from '@finity/engine';

/**
 * What the board is showing.
 *   null — the live game (follows new moves as they happen)
 *   k    — the position after the first k moves; 0 is the starting position
 */
export type ViewIndex = number | null;

export type HistoryAction = 'back' | 'forward' | 'live';

/**
 * Next view after a button press.
 *
 * @param totalMoves  moves played so far in the live game
 * @param firstIndex  earliest viewable position: the move count of the state
 *                    the game started from (non-zero when a game was restored
 *                    mid-way, since earlier positions are not available)
 *
 * Back from live shows the position before the last move. Forward past the
 * newest position — or onto it — returns to live, so the board never sits on
 * a frozen copy of the current position.
 */
export function navigateHistory(
    view: ViewIndex,
    totalMoves: number,
    action: HistoryAction,
    firstIndex = 0,
): ViewIndex {
    switch (action) {
        case 'live':
            return null;
        case 'back': {
            const from = view ?? totalMoves;
            const to = Math.max(firstIndex, from - 1);
            return to >= totalMoves ? null : to;
        }
        case 'forward': {
            if (view === null) return null;
            const to = view + 1;
            return to >= totalMoves ? null : to;
        }
    }
}

/**
 * The position after the first `k` moves of the live history, rebuilt by
 * replaying from `initial`. Deterministic: the engine's applyMove is pure, so
 * this is exactly the position that was on the board at the time.
 */
export function positionAt(
    initial: FinityGameState,
    moves: readonly RecordedMove[],
    k: number,
): FinityGameState {
    let s = initial;
    for (let i = initial.moveHistory.length; i < k && i < moves.length; i++) {
        s = applyMove(s, moves[i].move);
    }

    return s;
}

/** Short status line for the board while history is shown. */
export function historyLabel(view: ViewIndex, totalMoves: number): string | null {
    if (view === null) return null;
    const where = view === 0 ? 'the starting position' : `the position after move ${view}`;

    return `Viewing ${where} of ${totalMoves}. Press ⏭ to return to the live game.`;
}
