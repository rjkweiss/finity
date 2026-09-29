// Tony's move-level advice, applied at the root of the minimax search:
//   - a reversal is worth the most when it orphans opponent rings (more rings,
//     more value), something when it extends your own route, and is penalised
//     when it does neither;
//   - a block is worth more the more it hurts the opponent, especially when it
//     closes one of their channels outright.

import { describe, it, expect } from 'vitest';
import {
    applyMove,
    createGame,
    currentPlayer,
    legalMoves,
    longestLegalPathLength,
    ringCount,
    SLOT_INTERFERENCES,
    type ArrowColor,
    type FinityGameState,
    type MoveAction,
} from '@finity/engine';
import {
    BOXED_IN,
    MOVE_BONUS,
    blockImpact,
    escapeValue,
    openChannels,
    buildRootContext,
    reversalValue,
    rootMoveBonus,
    type RootContext,
} from '../src/ai-judgement';
import { MinimaxAgent } from '../src/ai-minimax';
import type { MoveContext } from '../src/interface';

const moveCtx = (moveIndex = 0): MoveContext => ({ signal: new AbortController().signal, moveIndex });

const PATTERN: ArrowColor[] = ['b', 'b', 'w', 'w', 'b', 'w', 'b', 'w'];
const start = () => createGame({ playerColors: ['cyan', 'yellow'], boardSize: 2 }, PATTERN);

/** A context describing `after` as if `orphaned` opponent rings had just gone
 *  and the mover's path had grown by `routeGain`. Tests the grading alone. */
function ctxFor(after: FinityGameState, orphaned: number, routeGain: number): RootContext {
    return {
        me: 'cyan',
        opponents: ['yellow'],
        oppRings: ringCount(after, 'yellow') + orphaned,
        myPath: longestLegalPathLength(after, 'cyan') - routeGain,
        oppTriplets: new Set(),
        myOpenChannels: 5,
    };
}

describe('reversal value', () => {
    const s = start();

    it('penalises a reversal that neither orphans nor helps', () => {
        expect(reversalValue(ctxFor(s, 0, 0), s)).toBe(MOVE_BONUS.wastedReversal);
        expect(MOVE_BONUS.wastedReversal).toBeLessThan(0);
    });

    it('rewards a reversal toward your own route', () => {
        expect(reversalValue(ctxFor(s, 0, 1), s)).toBe(MOVE_BONUS.ownRoute);
    });

    it('rewards orphaning more than helping your route', () => {
        expect(reversalValue(ctxFor(s, 1, 0), s)).toBeGreaterThan(reversalValue(ctxFor(s, 0, 1), s));
    });

    it('scales with the number of rings orphaned', () => {
        const one = reversalValue(ctxFor(s, 1, 0), s);
        const three = reversalValue(ctxFor(s, 3, 0), s);
        expect(three).toBe(3 * one);
    });

    it('credits both reasons when a reversal has both', () => {
        expect(reversalValue(ctxFor(s, 2, 1), s)).toBe(2 * MOVE_BONUS.orphanPerRing + MOVE_BONUS.ownRoute);
    });
});

describe('block impact', () => {
    /** Channel = the three slots of one station pair; base = its first slot. */
    const BASE = 45; // SE-S: slots 45, 46, 47

    function withOpenSlots(open: number[]): FinityGameState {
        const s = structuredClone(start());
        for (const id of [BASE, BASE + 1, BASE + 2]) s.board.slots[id].blocked = !open.includes(id);
        return s;
    }

    const blockerTo = (slotId: number): MoveAction => ({
        type: 'replace',
        pieceToAdd: { type: 'blocker', color: 'cyan', slotId },
    } as MoveAction);

    const ctxWatching = (bases: number[]): RootContext => ({
        me: 'cyan', opponents: ['yellow'], oppRings: 0, myPath: 0, oppTriplets: new Set(bases),
        myOpenChannels: 5,
    });

    it('is zero away from the opponent\'s channels', () => {
        const s = withOpenSlots([45, 46, 47]);
        expect(blockImpact(ctxWatching([]), s, blockerTo(46))).toBe(0);
    });

    it('counts an open slot taken from an opponent channel', () => {
        const s = withOpenSlots([45, 46, 47]);
        expect(blockImpact(ctxWatching([BASE]), s, blockerTo(46))).toBe(MOVE_BONUS.blockPerSlot);
    });

    it('counts closing the channel\'s last open slot much higher', () => {
        const s = withOpenSlots([46]);
        const closing = blockImpact(ctxWatching([BASE]), s, blockerTo(46));
        expect(closing).toBe(MOVE_BONUS.blockPerSlot + MOVE_BONUS.channelClosed);

        const partial = blockImpact(ctxWatching([BASE]), withOpenSlots([45, 46, 47]), blockerTo(46));
        expect(closing).toBeGreaterThan(partial);
    });

    it('counts the slots an arrow shuts by interference, not just its own', () => {
        // An arrow in slot 8 (C-SE right) interferes with slot 45 (SE-S right).
        expect(SLOT_INTERFERENCES[8]).toContain(45);
        const s = withOpenSlots([45]);
        const arrow = {
            type: 'place',
            pieceToAdd: { type: 'arrow', color: 'b', fromStation: 'C', toStation: 'SE', slotId: 8 },
        } as MoveAction;
        expect(blockImpact(ctxWatching([BASE]), s, arrow)).toBe(MOVE_BONUS.blockPerSlot + MOVE_BONUS.channelClosed);
    });
});

describe('base post escape', () => {
    // At the start, cyan's only reachable station is her base post N, which
    // has three open channels on the 2-player board (to C, NE and NW).
    const roomy = start();
    const ctxWith = (open: number): RootContext => ({
        me: 'cyan', opponents: ['yellow'], oppRings: 0, myPath: 0, oppTriplets: new Set(), myOpenChannels: open,
    });

    it('counts the open channels out of your territory', () => {
        expect(openChannels(roomy, 'cyan')).toBe(3);
    });

    it('rewards a relocation that frees a boxed-in player', () => {
        expect(escapeValue(ctxWith(BOXED_IN), roomy)).toBe(MOVE_BONUS.escape);
        expect(escapeValue(ctxWith(0), roomy)).toBe(MOVE_BONUS.escape);
    });

    it('gives nothing when you were not boxed in', () => {
        expect(escapeValue(ctxWith(BOXED_IN + 1), roomy)).toBe(0);
    });

    it('gives nothing when the move does not add room', () => {
        expect(escapeValue(ctxWith(3), roomy)).toBe(0);
    });
});

describe('root search with move bonuses', () => {
    /** Positions from real (deterministic) play, so the root has variety. */
    async function positions(count: number): Promise<FinityGameState[]> {
        const agents = {
            cyan: new MinimaxAgent({ timeMs: Number.MAX_SAFE_INTEGER, maxDepth: 1, seed: 1 }),
            yellow: new MinimaxAgent({ timeMs: Number.MAX_SAFE_INTEGER, maxDepth: 1, seed: 2 }),
        };
        const out: FinityGameState[] = [];
        let s = start();
        for (let ply = 0; ply < 40 && s.playStatus !== 'over'; ply++) {
            if (ply >= 10 && ply % 6 === 0) out.push(s);
            const c = currentPlayer(s) as 'cyan' | 'yellow';
            s = applyMove(s, await agents[c].move(c, s, moveCtx(ply)));
        }

        return out.slice(0, count);
    }

    it('picks the move with the best score + bonus (the shifted window prunes exactly)', async () => {
        for (const s of await positions(3)) {
            const me = currentPlayer(s);
            const agent = new MinimaxAgent({ timeMs: Number.MAX_SAFE_INTEGER, maxDepth: 2, seed: 7 });
            const chosen = await agent.move(me, s, moveCtx());

            // Brute force: every root move searched with a full window.
            const a = agent as unknown as {
                search(st: FinityGameState, d: number, al: number, be: number): number;
            };
            const rctx = buildRootContext(s, me);
            let best = -Infinity;
            let chosenScore = NaN;
            for (const m of legalMoves(s, me)) {
                const child = applyMove(s, m);
                const v = -a.search(child, 1, -Infinity, Infinity) + rootMoveBonus(rctx, s, child, m);
                if (v > best) best = v;
                if (JSON.stringify(m) === JSON.stringify(chosen)) chosenScore = v;
            }
            expect(chosenScore).toBe(best);
        }
    });
});

describe('search budget', () => {
    it('never plays an unsearched move, however small the budget', async () => {
        // With a 1 ms budget the old search could run out part-way through
        // depth 1 and fall back to the first move in its ordering, unsearched.
        // Now depth 1 always completes, so the choice must match a full
        // depth-1 search with the same seed.
        let s = start();
        const ctx0 = moveCtx();
        const driver = new MinimaxAgent({ timeMs: Number.MAX_SAFE_INTEGER, maxDepth: 1, seed: 3 });
        for (let ply = 0; ply < 30 && s.playStatus !== 'over'; ply++) {
            const c = currentPlayer(s);
            if (ply >= 10 && ply % 5 === 0) {
                const rushed = await new MinimaxAgent({ timeMs: 1, maxDepth: 3, seed: 9 }).move(c, s, ctx0);
                const full = await new MinimaxAgent({ timeMs: Number.MAX_SAFE_INTEGER, maxDepth: 1, seed: 9 }).move(c, s, ctx0);
                expect(JSON.stringify(rushed)).toBe(JSON.stringify(full));
            }
            s = applyMove(s, await driver.move(c, s, moveCtx(ply)));
        }
    });
});
