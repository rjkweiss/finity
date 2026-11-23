/**
 * Finity — Strict Replay
 *
 * Replays a parsed BGA game through the engine and refuses to continue past a
 * move the engine would not itself allow. replay-validator.ts only checks
 * orphan counts and the winner, and applyMove trusts its input (it will, for
 * example, drop an arrow onto a blocker's slot and silently delete the
 * blocker), so a replay can look clean while the board has already diverged
 * from the real game.
 *
 * Per move this checks that
 *   - it is the logged player's turn,
 *   - the slot a piece lands in is empty, and a piece being removed or
 *     reversed is really there,
 *   - the move is in legalMoves(state, color) (no-undo rule included).
 *
 * The log gives only the DESTINATION of a blocker move, not which of the
 * player's two blockers moved. Both candidates are tried, depth first, and the
 * one that keeps the rest of the game consistent wins. The result carries the
 * resolved MoveAction list, which record-builder and replay-validator use in
 * place of toMoveAction.
 */

import type { ArrowColor, FinityGameState, MoveAction, PlayerColor } from '@finity/engine';
import { applyMove, createGame, currentPlayer, legalMoves } from '@finity/engine';
import { toMoveAction, type ParsedAction, type ParsedGame } from './game-log-parser';

/** Search guard: only blocker moves branch, so real games stay far below this. */
const MAX_NODES = 20_000;

/**
 * Identity of a move for membership tests against legalMoves. A blocker move
 * is keyed by destination only, because the log cannot say which blocker moved.
 */
export function moveKey(m: MoveAction): string {
    const add = m.pieceToAdd;
    const rem = m.pieceToRemove;
    if (m.type === 'remove') return rem?.type === 'arrow' ? `ar:${rem.slotId}` : `br:${rem?.slotId}`;
    if (!add) return '?';
    switch (add.type) {
        case 'ring': return `ring:${m.station}`;
        case 'basePost': return `bp:${add.toStation}`;
        case 'blocker': return `bm:${add.slotId}`;
        case 'arrow':
            return m.type === 'replace'
                ? `rev:${add.slotId}`
                : `pl:${add.slotId}:${add.color}:${add.fromStation}`;
    }
}

/** A reason the move cannot be applied to this board, or null if it can. */
export function strictViolation(state: FinityGameState, m: MoveAction): string | null {
    const slots = state.board.slots;
    const add = m.pieceToAdd;
    const rem = m.pieceToRemove;

    if (m.type === 'place' && add?.type === 'arrow' && slots[add.slotId].contains) {
        return `slot ${add.slotId} already holds a ${slots[add.slotId].contains!.type}`;
    }
    if (m.type === 'replace' && add?.type === 'blocker' && slots[add.slotId].contains) {
        return `blocker destination ${add.slotId} already holds a ${slots[add.slotId].contains!.type}`;
    }
    if (m.type === 'remove' && rem && slots[rem.slotId].contains?.type !== rem.type) {
        return `no ${rem.type} in slot ${rem.slotId} to remove`;
    }
    if (m.type === 'replace' && add?.type === 'arrow' && slots[add.slotId].contains?.type !== 'arrow') {
        return `no arrow in slot ${add.slotId} to reverse`;
    }
    return null;
}

export interface StrictFailure {
    /** Index into game.moves of the deepest move any branch reached. */
    moveIndex: number;
    moveNumber: number;
    kind: ParsedAction['kind'];
    reason: string;
}

export interface StrictReplay {
    ok: boolean;
    /** One engine MoveAction per parsed move; empty unless ok. */
    moves: MoveAction[];
    failure?: StrictFailure;
}

export function strictReplay(
    game: ParsedGame,
    pattern: ArrowColor[],
    playerColors: [PlayerColor, PlayerColor] = ['cyan', 'yellow'],
): StrictReplay {
    const colorOf = new Map<string, PlayerColor>();
    game.players.forEach((p, i) => colorOf.set(p, playerColors[i]));

    const path: MoveAction[] = [];
    let nodes = 0;
    let failure: StrictFailure | undefined;
    const note = (i: number, reason: string): void => {
        if (failure && i < failure.moveIndex) return;
        const pm = game.moves[i];
        failure = { moveIndex: i, moveNumber: pm.moveNumber, kind: pm.action.kind, reason };
    };

    const candidates = (action: ParsedAction, color: PlayerColor, s: FinityGameState): MoveAction[] => {
        if (action.kind !== 'move-blocker') return [toMoveAction(action, color, s)];
        const own = s.board.slots.flatMap((sl) =>
            sl.contains?.type === 'blocker' && sl.contains.color === color ? [sl.contains] : []);
        return own.map((b) => ({
            type: 'replace' as const,
            pieceToRemove: b,
            pieceToAdd: { type: 'blocker' as const, color, slotId: action.slotId },
        }));
    };

    const walk = (i: number, s: FinityGameState): boolean => {
        if (i === game.moves.length) return true;
        if (++nodes > MAX_NODES) { note(i, 'search limit reached'); return false; }

        const pm = game.moves[i];
        const color = colorOf.get(pm.player)!;
        if (currentPlayer(s) !== color) { note(i, `not ${pm.player}'s turn`); return false; }

        const cands = candidates(pm.action, color, s);
        if (cands.length === 0) { note(i, `${color} has no blocker to move`); return false; }

        const legal = new Set(legalMoves(s, color).map(moveKey));
        for (const m of cands) {
            const bad = strictViolation(s, m) ?? (legal.has(moveKey(m)) ? null : `not a legal move (${moveKey(m)})`);
            if (bad) { note(i, bad); continue; }
            path.push(m);
            if (walk(i + 1, applyMove(s, m))) return true;
            path.pop();
        }
        return false;
    };

    const ok = walk(0, createGame({ playerColors, boardSize: 2 }, pattern));
    return ok ? { ok, moves: path.slice() } : { ok, moves: [], failure };
}
