/**
 * Board marks for moves: what to outline on the board to show a move.
 *
 * Two uses, drawn in two styles:
 *   'last'  — the most recent move, pulsing, so a human can follow the AI.
 *   'hover' — a move the mouse is over in the move log, so a line like
 *             "places a black arrow at SW-NW right" can be found on the board.
 *
 * Kept free of p5 and React so it can be tested directly; the display
 * handler only turns these into shapes.
 */

import type { MoveAction, StationName } from '@finity/engine';
import { primaryTarget, type BoardTarget } from './moveInputHandler';

export type MarkStyle = 'last' | 'hover';

export interface MoveMark {
    readonly style: MarkStyle;
    /** Where the move landed: the slot or station it placed or changed. */
    readonly target: BoardTarget;
    /** Arrow placements and reversals: the direction the arrow now points. */
    readonly direction?: { readonly from: StationName; readonly to: StationName };
    /** A blocker that moved between slots: the slot it left. */
    readonly origin?: BoardTarget;
    /** The move took a piece off the board, so nothing is left to see there. */
    readonly removal: boolean;
}

/** The mark for one move, or null for a move with nothing to point at. */
export function markForMove(move: MoveAction, style: MarkStyle): MoveMark | null {
    const target = primaryTarget(move);
    if (!target) return null;

    const add = move.pieceToAdd;
    const removed = move.pieceToRemove;

    const direction =
        add?.type === 'arrow' ? { from: add.fromStation, to: add.toStation } : undefined;

    const origin =
        add?.type === 'blocker' && removed?.type === 'blocker' && removed.slotId !== add.slotId
            ? ({ kind: 'slot', slotId: removed.slotId } as const)
            : undefined;

    return {
        style,
        target,
        ...(direction ? { direction } : {}),
        ...(origin ? { origin } : {}),
        removal: move.type === 'remove',
    };
}

/**
 * Marks for the board: the last move that produced the position being shown,
 * plus the move being hovered in the log. When both are the same move, the
 * hover mark alone is drawn.
 */
export function boardMarks(
    lastMove: MoveAction | null | undefined,
    hovered: MoveAction | null | undefined,
): MoveMark[] {
    const marks: MoveMark[] = [];
    const sameMove = !!lastMove && !!hovered && JSON.stringify(lastMove) === JSON.stringify(hovered);

    if (lastMove && !sameMove) {
        const m = markForMove(lastMove, 'last');
        if (m) marks.push(m);
    }
    if (hovered) {
        const m = markForMove(hovered, 'hover');
        if (m) marks.push(m);
    }

    return marks;
}
