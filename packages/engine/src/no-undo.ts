import type { FinityGameState, MoveAction } from './types';
import { computeZobristHash } from './zobrist';

/**
 * Hash of the BOARD ONLY.
 *
 * computeZobristHash skips the side-to-move key when turnIndex is out of
 * range, so a shallow spread with turnIndex = -1 gives us a board-only hash
 * with no change to zobrist.ts
 */
export const boardHash = (state: FinityGameState): string => {
    return computeZobristHash({ ...state, turnIndex: -1 });
}

/**
 * Could `candidate` conceivably be an undo of `last`? Purely a cheap
 * prefilter: it must touch the same slot or the same station.
 */
const couldBeUndo = (candidate: MoveAction, last: MoveAction): boolean => {
    const slots = (m: MoveAction): number[] => {
        const out: number[] = [];
        const a = m.pieceToAdd;
        const r = m.pieceToRemove;
        if (a && (a.type === 'arrow' || a.type === 'blocker')) out.push(a.slotId);
        if (r) out.push(r.slotId);

        return out;
    };

    const stations = (m: MoveAction): string[] => {
        const out: string[] = [];
        if (m.station) out.push(m.station);
        const a = m.pieceToAdd;
        if (a && a.type === 'basePost') out.push(a.toStation);

        return out;
    };

    const cs = slots(candidate);
    const ls = slots(last);
    if (cs.some((s) => ls.includes(s))) return true;

    const cst = stations(candidate);
    const lst = stations(last);

    return cst.some((s) => lst.includes(s));
}

/**
 * Remove any candidate that would restore the board to exactly the
 * position it held before the previous move.
 */
export const filterImmediateUndo = (
    state: FinityGameState,
    moves: MoveAction[],
    applyMoveFn: (s: FinityGameState, m: MoveAction) => FinityGameState,
): MoveAction[] => {
    const prev = state.prevBoardHash;
    if (!prev) return moves; // first move of the game — nothing to undo
    if (state.moveHistory.length === 0) return moves;

    const last = state.moveHistory[state.moveHistory.length - 1].move;

    return moves.filter((move) => {
        if (!couldBeUndo(move, last)) return true;
        try {
            // The exception (rulebook): if the previous move orphaned rings,
            // the board no longer matches `prev`, the hashes differ, and the
            // move is correctly allowed.
            return boardHash(applyMoveFn(state, move)) !== prev;
        } catch {
            // A candidate that will not apply is not an undo - let it through
            return true;
        }
    });
}

/**
 * True when placing an arrow of `color` into `slotId` is forbidden
 * because the previous move removed an arrow of that color from
 * that same slot — in EITHER direction.
 */
export const violatesReplacementRule = (
    state: FinityGameState,
    slotId: number,
    arrowColor: 'b' | 'w',
): boolean => {
    if (state.moveHistory.length === 0) return false;
    const last = state.moveHistory[state.moveHistory.length - 1].move;
    if (last.type !== 'remove') return false;
    const removed = last.pieceToRemove;
    return (
        removed?.type === 'arrow' &&
        removed.color === arrowColor &&
        removed.slotId === slotId
    );
}
