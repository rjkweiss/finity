/**
 * Finity Game Engine — Zobrist Hashing
 *
 * A position hash for transposition detection in AI search. Each possible board
 * feature owns a random 64-bit key; the hash of a position is the XOR of all
 * active features' keys plus the side-to-move key. Because XOR is order-
 * independent, two move sequences that transpose to the same board produce the
 * same hash — which is exactly what a search transposition table needs.
 *
 * Key table layout (788 keys, matching the design doc):
 *   arrows      72 slots × 2 colors (b/w) × 2 directions   = 288
 *   rings       13 stations × 4 player colors × 3 sizes     = 156
 *   blockers    72 slots × 4 player colors                  = 288
 *   base posts  13 stations × 4 player colors               =  52
 *   side to move 4 player colors                            =   4
 *
 * The table is generated once at module load from a FIXED seed (splitmix64), so
 * it is deterministic across runs and processes — the engine stays pure (no
 * ambient Math.random). The hash is stored on FinityGameState as a hex string
 * (the state type is JSON-serializable; bigint is not), and recomputed by
 * applyMove. Incremental XOR updates are a possible optimization, but applyMove
 * already deep-clones the whole state per move, so a full O(board) fold is the
 * same order of cost and far less error-prone.
 */

import type { FinityGameState, PlayerColor, ArrowColor } from './types';
import { NAME_TO_NUMBER, SLOT_TO_STATIONS } from './topology';

// -------------------------------------------------------------------------
// Fixed feature ordering
// -------------------------------------------------------------------------

/** Canonical player-color order for indexing. Covers every possible color. */
const COLORS: PlayerColor[] = ['cyan', 'yellow', 'red', 'purple'];
const N_STATIONS = 13; // numeric ids 0..12
const N_SLOTS = 72;

const ARROWS = N_SLOTS * 2 * 2; // 288
const RINGS = N_STATIONS * 4 * 3; // 156
const BLOCKERS = N_SLOTS * 4; // 288
const BASEPOSTS = N_STATIONS * 4; // 52
const SIDES = 4;

const OFF_ARROWS = 0;
const OFF_RINGS = OFF_ARROWS + ARROWS; // 288
const OFF_BLOCKERS = OFF_RINGS + RINGS; // 444
const OFF_BASEPOSTS = OFF_BLOCKERS + BLOCKERS; // 732
const OFF_SIDES = OFF_BASEPOSTS + BASEPOSTS; // 784
const TABLE_SIZE = OFF_SIDES + SIDES; // 788

const MASK64 = (1n << 64n) - 1n;

// -------------------------------------------------------------------------
// Deterministic key table (splitmix64 from a fixed seed)
// -------------------------------------------------------------------------

function makeKeyTable(seed: bigint, n: number): bigint[] {
    let x = seed & MASK64;
    const out = new Array<bigint>(n);
    for (let i = 0; i < n; i++) {
        // splitmix64
        x = (x + 0x9e3779b97f4a7c15n) & MASK64;
        let z = x;
        z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
        z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
        z = z ^ (z >> 31n);
        out[i] = z & MASK64;
    }
    return out;
}

const KEYS: bigint[] = makeKeyTable(0x00c0ffee_1decade5n, TABLE_SIZE);

// -------------------------------------------------------------------------
// Index helpers
// -------------------------------------------------------------------------

function colorIndex(c: PlayerColor): number {
    return COLORS.indexOf(c);
}

function arrowKey(slotId: number, color: ArrowColor, dir: 0 | 1): bigint {
    const colorBit = color === 'b' ? 0 : 1;
    return KEYS[OFF_ARROWS + slotId * 4 + colorBit * 2 + dir];
}

function ringKey(stationIdx: number, colorIdx: number, sizeIdx: number): bigint {
    return KEYS[OFF_RINGS + stationIdx * 12 + colorIdx * 3 + sizeIdx];
}

function blockerKey(slotId: number, colorIdx: number): bigint {
    return KEYS[OFF_BLOCKERS + slotId * 4 + colorIdx];
}

function basePostKey(stationIdx: number, colorIdx: number): bigint {
    return KEYS[OFF_BASEPOSTS + stationIdx * 4 + colorIdx];
}

function sideKey(colorIdx: number): bigint {
    return KEYS[OFF_SIDES + colorIdx];
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/**
 * Full Zobrist hash of a position: pieces on the board plus the side to move,
 * returned as a lowercase hex string. Deliberately excludes move history, the
 * deadlock counter, gsId, winners, and playStatus — it is a hash of the *board
 * position and whose turn it is*, which is what makes transpositions collide.
 */
export function computeZobristHash(state: FinityGameState): string {
    let h = 0n;
    const board = state.board;

    // Side to move (only when a valid player is on the clock).
    const ti = state.turnIndex;
    if (ti >= 0 && ti < state.config.playerColors.length) {
        const ci = colorIndex(state.config.playerColors[ti]);
        if (ci >= 0) h ^= sideKey(ci);
    }

    // Stations: base posts and rings.
    for (const name of Object.keys(board.stations)) {
        const st = board.stations[name as keyof typeof board.stations];
        const stationIdx = NAME_TO_NUMBER[st.id];
        if (stationIdx === undefined) continue;

        if (st.basePost) {
            const ci = colorIndex(st.basePost);
            if (ci >= 0) h ^= basePostKey(stationIdx, ci);
        }
        // Ring position IS the size index: [0]=small, [1]=medium, [2]=large.
        for (let sizeIdx = 0; sizeIdx < st.rings.length; sizeIdx++) {
            const ring = st.rings[sizeIdx];
            if (!ring) continue;
            const ci = colorIndex(ring.color);
            if (ci >= 0) h ^= ringKey(stationIdx, ci, sizeIdx);
        }
    }

    // Slots: arrows (with direction) and blockers. The `blocked` flag is a
    // derived function of arrows, so it is intentionally not hashed.
    for (const slot of board.slots) {
        const c = slot.contains;
        if (!c) continue;
        if (c.type === 'arrow') {
            const pair = SLOT_TO_STATIONS[slot.id];
            const dir: 0 | 1 = pair && c.fromStation === pair[0] ? 0 : 1;
            h ^= arrowKey(slot.id, c.color, dir);
        } else {
            const ci = colorIndex(c.color);
            if (ci >= 0) h ^= blockerKey(slot.id, ci);
        }
    }

    return h.toString(16);
}
