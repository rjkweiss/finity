/**
 * Finity — BGA Game Log Parser (parser 2 of 2)
 *
 * Input: a BGA move log (text). Output: a faithful, log-ordered ParsedGame —
 * player order, every move as a discriminated ParsedAction with its resolved
 * slot id, the orphan annotations ("X has to remove N orphaned rings") attached
 * to their triggering move, and the winner.
 *
 * The parser stays pure and log-faithful; converting a ParsedMove into an
 * engine MoveAction (which sometimes needs live board context) is done by
 * `toMoveAction` at replay time.
 *
 * Validated against 5 real logs: 0 unparsed lines, 0 unmapped coordinates,
 * all six action kinds classified, winners and orphan counts captured.
 */

import type {
    ArrowColor,
    Channel,
    StationName,
    PlayerColor,
    FinityGameState,
    MoveAction,
    ArrowState,
    BlockerState,
} from '@finity/engine';
import { STATION_SLOTS, toStationName } from '@finity/engine';

// =============================================================
// Output types
// =============================================================

export type ParsedAction =
    | { kind: 'place-arrow'; color: ArrowColor; from: StationName; to: StationName; channel: Channel; slotId: number }
    | { kind: 'remove-arrow'; color: ArrowColor; from: StationName; to: StationName; channel: Channel; slotId: number }
    | { kind: 'reverse-arrow'; color: ArrowColor; from: StationName; to: StationName; channel: Channel; slotId: number }
    | { kind: 'place-ring'; size: 's' | 'm' | 'l'; station: StationName }
    | { kind: 'move-blocker'; from: StationName; to: StationName; channel: Channel; slotId: number }
    | { kind: 'remove-blocker'; from: StationName; to: StationName; channel: Channel; slotId: number }
    | { kind: 'move-base-post'; station: StationName };

export interface ParsedMove {
    moveNumber: number;
    player: string;
    action: ParsedAction;
    /** Epoch ms parsed from the log (best-effort; undefined if unparseable). */
    timestamp?: number;
    /** Present when the log noted orphan removal triggered by this move. */
    orphanedRings?: { player: string; count: number };
}

export interface ParsedGame {
    players: string[];        // distinct players in first-move order
    moves: ParsedMove[];
    winner: string | null;
    unparsed: string[];       // any content lines the grammar missed (should be empty)
}

// =============================================================
// Lookups
// =============================================================

const COLOR: Record<string, ArrowColor> = { Black: 'b', White: 'w' };
const SIZE: Record<string, 's' | 'm' | 'l'> = { Small: 's', Medium: 'm', Large: 'l' };
const POS: Record<string, Channel> = { Right: 'R', Left: 'L', Middle: 'C' };

function name(coord: string): StationName {
    return toStationName(coord); // accepts the raw "-1,0" coordinate form
}

function slotOf(from: StationName, to: StationName, channel: Channel): number {
    const id = STATION_SLOTS[from]?.[to]?.[channel];
    if (id === undefined) {
        throw new Error(`No slot for ${from} -> ${to} : ${channel}`);
    }
    return id;
}

// =============================================================
// Line grammar
// =============================================================

const RE_MOVE_NUM = /^Move (\d+) :/;   // matches "Move 5 :" and "Move 1 :10/17/2022 7:41 AM"
const RE_TS = /^\d{1,2}\/\d{1,2}\/\d{4}|^\d{1,2}:\d{2}:\d{2}/;
const RE_ACTION = /^(.+?): (Added|Removed|Reversed|Moved) a (.+)$/;
const RE_BRIDGE = /^(Black|White) Bridge at Station \[([^\]]+)\] => \[([^\]]+)\] Position:(Right|Left|Middle)$/;
const RE_RING = /^(Small|Medium|Large) Ring at Station \[([^\]]+)\]$/;
const RE_BLOCKER = /^Blocker at Station \[([^\]]+)\] => \[([^\]]+)\] Position:(Right|Left|Middle)$/;
const RE_BASEPOST = /^Base Post at Station \[([^\]]+)\]$/;
const RE_ORPHAN = /^(.+?) has to remove (\d+) orphaned rings$/;
const RE_WIN = /^The end of the game: (.+) wins!$/;

function classify(verb: string, rest: string): ParsedAction | null {
    let m: RegExpMatchArray | null;

    if ((m = rest.match(RE_BRIDGE))) {
        const from = name(m[2]);
        const to = name(m[3]);
        const channel = POS[m[4]];
        const kind =
            verb === 'Added' ? 'place-arrow' : verb === 'Removed' ? 'remove-arrow' : 'reverse-arrow';
        return { kind, color: COLOR[m[1]], from, to, channel, slotId: slotOf(from, to, channel) };
    }
    if ((m = rest.match(RE_RING))) {
        return { kind: 'place-ring', size: SIZE[m[1]], station: name(m[2]) };
    }
    if ((m = rest.match(RE_BLOCKER))) {
        const from = name(m[1]);
        const to = name(m[2]);
        const channel = POS[m[3]];
        // "Moved a Blocker" and "Removed a Blocker" share this shape — branch on verb.
        const kind = verb === 'Moved' ? 'move-blocker' : 'remove-blocker';
        return { kind, from, to, channel, slotId: slotOf(from, to, channel) };
    }
    if ((m = rest.match(RE_BASEPOST))) {
        return { kind: 'move-base-post', station: name(m[1]) };
    }
    return null;
}

// =============================================================
// Parser
// =============================================================

export function parseGameLog(text: string): ParsedGame {
    const moves: ParsedMove[] = [];
    const players: string[] = [];
    const unparsed: string[] = [];
    let winner: string | null = null;
    let moveNumber = 0;

    // BGA timestamps: a full "m/d/yyyy h:mm:ss AM" sets the running date; later
    // time-only lines inherit it. The timestamp precedes its move's action line.
    let currentDate = '';
    let pendingTs: number | undefined;
    const setTs = (s: string) => {
        const dateMatch = s.match(/^(\d{1,2}\/\d{1,2}\/\d{4})/);
        if (dateMatch) currentDate = dateMatch[1];
        const parsed = currentDate ? Date.parse(dateMatch ? s : `${currentDate} ${s}`) : NaN;
        pendingTs = Number.isNaN(parsed) ? undefined : parsed;
    };

    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line === 'Game log') continue;
        if (/^No rings placed or orphaned/.test(line)) continue; // informational draw counter

        let m: RegExpMatchArray | null;
        if ((m = line.match(RE_MOVE_NUM))) {
            moveNumber = Number(m[1]);
            const rest = line.slice(m[0].length).trim(); // inline timestamp, if any
            if (rest) setTs(rest);
            continue;
        }
        if (RE_TS.test(line)) { setTs(line); continue; }
        if (/have been chosen according to their preferences/.test(line)) continue;
        if (/Rematch with the exact same players/.test(line)) continue;

        if ((m = line.match(RE_WIN))) { winner = m[1]; continue; }

        if ((m = line.match(RE_ORPHAN))) {
            if (moves.length) {
                moves[moves.length - 1].orphanedRings = { player: m[1], count: Number(m[2]) };
            }
            continue;
        }

        if ((m = line.match(RE_ACTION))) {
            const player = m[1];
            const action = classify(m[2], m[3]);
            if (action) {
                if (!players.includes(player)) players.push(player);
                moves.push({ moveNumber, player, action, timestamp: pendingTs });
                continue;
            }
        }
        unparsed.push(line);
    }

    return { players, moves, winner, unparsed };
}

// =============================================================
// Replay adapter — ParsedAction -> engine MoveAction
// =============================================================

/**
 * Map players to colors in first-move order. createGame assigns
 * playerColors[i] to startStations[i], so the first mover must be
 * playerColors[0].
 */
export function assignColors(
    game: ParsedGame,
    playerColors: PlayerColor[],
): Map<string, PlayerColor> {
    const map = new Map<string, PlayerColor>();
    game.players.forEach((p, i) => map.set(p, playerColors[i]));
    return map;
}

function findOwnBlocker(state: FinityGameState, color: PlayerColor): BlockerState {
    for (const slot of state.board.slots) {
        const c = slot.contains;
        if (c && c.type === 'blocker' && c.color === color) return c;
    }
    throw new Error(`No blocker found for ${color}`);
}

/**
 * Convert a ParsedAction to an engine MoveAction. Determinate cases are built
 * straight from the log; cases that reference an existing piece read it from
 * the live slot so the orientation/identity matches the board.
 *
 * TWO THINGS TO CONFIRM ON THE FIRST REAL REPLAY:
 *  - reverse-arrow: the log records one orientation; here we trust the live
 *    arrow in the slot and flip it. If a replay diverges, the log's [A]=>[B]
 *    may already be the post-reversal orientation.
 *  - move-blocker: the log gives only the destination slot, not which of the
 *    player's two blockers moved. Blockers don't affect path reachability or
 *    orphans, so any choice is fine for orphan/victory validation; we pick the
 *    first own blocker. Revisit if exact blocker identity ever matters.
 */
export function toMoveAction(
    action: ParsedAction,
    color: PlayerColor,
    state: FinityGameState,
): MoveAction {
    switch (action.kind) {
        case 'place-arrow':
            return {
                type: 'place',
                pieceToAdd: { type: 'arrow', color: action.color, fromStation: action.from, toStation: action.to, slotId: action.slotId },
            };

        case 'remove-arrow': {
            const live = state.board.slots[action.slotId].contains;
            const arrow: ArrowState = live && live.type === 'arrow'
                ? live
                : { type: 'arrow', color: action.color, fromStation: action.from, toStation: action.to, slotId: action.slotId };
            return { type: 'remove', pieceToRemove: arrow };
        }

        case 'reverse-arrow': {
            const live = state.board.slots[action.slotId].contains;
            const old: ArrowState = live && live.type === 'arrow'
                ? live
                : { type: 'arrow', color: action.color, fromStation: action.to, toStation: action.from, slotId: action.slotId };
            return {
                type: 'replace',
                pieceToRemove: old,
                pieceToAdd: { type: 'arrow', color: old.color, fromStation: old.toStation, toStation: old.fromStation, slotId: action.slotId },
            };
        }

        case 'place-ring':
            return {
                type: 'place',
                station: action.station,
                pieceToAdd: { type: 'ring', color, size: action.size },
            };

        case 'move-base-post':
            return {
                type: 'replace',
                pieceToAdd: { type: 'basePost', color, toStation: action.station },
            };

        case 'move-blocker':
            return {
                type: 'replace',
                pieceToRemove: findOwnBlocker(state, color),
                pieceToAdd: { type: 'blocker', color, slotId: action.slotId },
            };

        case 'remove-blocker': {
            const live = state.board.slots[action.slotId].contains;
            const blocker: BlockerState = live && live.type === 'blocker'
                ? live
                : { type: 'blocker', color, slotId: action.slotId };
            return { type: 'remove', pieceToRemove: blocker };
        }
    }
}
