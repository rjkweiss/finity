// Minimax agent (the "race minimax"): alpha-beta search over a pruned,
// plan-relevant move list, with a leaf evaluation built on the exact race
// distance (engine/race.ts). It is the only 2-player search agent: Easy runs it
// one move deep, Medium at full depth (ai-builtin.ts).
//
// Why a separate agent rather than new weights for MinimaxAgent:
//   * the existing leaf score is a weighted sum of 14 structural terms; the BGA
//     games say the game is a RACE in which almost every good move changes one
//     of two numbers by one: my distance to a completed path, or yours.
//   * the existing search tries all ~150-210 legal moves at every node and
//     reaches depth 2 in a second; most of those moves touch nothing either
//     player's cheapest routes use. Pruning to the moves that do lets the
//     search spend its time on the race.
//
// Strategy encoded here (see docs/strategy/):
//   - Leaf value = distance race (mine vs yours, with the side to move's tempo),
//     made convex near zero so a 2-move threat outweighs a 1-move lead elsewhere.
//   - Base relocation is part of the distance, so "stack a station next to the
//     base, then move the base onto it" is valued before it is played, and the
//     same hidden threat is seen when the opponent sets it up.
//   - At the horizon a 1-move threat is resolved, not guessed: a side with a
//     1-move win either has it (checked) or doesn't; a side facing one gets to
//     try its defences.
//   - Candidate moves are those that build my cheapest routes, or occupy,
//     reverse or remove what the opponent's cheapest routes need. Reversals and
//     removals are judged by applying them and counting the rings they orphan,
//     because a bridge both players use can still be worth cutting.
//   - Routes the opponent can undo in one move (an unlocked link, or a link
//     into a station they control) are penalised as fragile.
//   - Decided positions are graded: a later loss beats an earlier one, so a
//     lost position is still played for maximum resistance.
//   - Per game, rings the opponent has already knocked off a station make
//     rebuilding there less attractive until the link is protected.
//   - Only legal moves are searched: the no-immediate-undo rule decides
//     whether a reversal can simply be reversed back.
//   - Back-and-forth is discouraged at the root: a minor-effect move on a slot
//     that keeps changing hands is penalised, and so is reversing back the
//     opponent's reversal when a locking placement was available instead.
//   - Distances are capped at 15 in the evaluation, so an opponent with no
//     route is "far away", not an emergency worth every move.
//   - A move with no measurable effect pays a small root penalty: it is played
//     only when the search finds it clearly better than a move that does
//     something.
//   - objective path (the cheapest path built to stand up to
//     opposition: open slots, no opponent-controlled stations, doubled steps)
//     is part of the evaluation for both players. His rules are hard filters
//     on the moves searched, for both sides: a reversal must orphan rings or
//     answer a threat, a ring must not be knockable in one move, and centre
//     bridges wait until a path is predictable.
//
// Its plans, move relevance and opening plan are in ai-judgement.ts; the race
// distance it evaluates with is in the engine (race.ts).

import type { FinityGameState, MoveAction, PlayerColor, RouteSummary } from '@finity/engine';
import { applyMove, DRAW_ROUND_LIMIT, legalMoves, routeSummary, SLOT_TO_STATIONS } from '@finity/engine';
import type { MoveContext, PlayerAgent } from './interface';
import { IllegalMoveError } from './interface';
import { moveCategory, seededRng, SearchDeadlineReached, throwIfAborted, type Rng } from './ai-common';
import { arrowTriple, moveRelevance, openingMove, pairKey, planOf, type Plan } from './ai-judgement';

// =============================================================
// Tunables
// =============================================================

export interface RaceWeights {
    /** Per move of distance difference (opponent minus mine). */
    race: number;
    /** Convex urgency: weight on 1/(d+1), so moves near zero count most. */
    urgency: number;
    /** Value of being the side to move. */
    tempo: number;
    /** Per doubling of tied cheapest routes (one block can't cut them all). */
    redundancy: number;
    /** Per step of the cheapest route the opponent could undo in one move. */
    fragility: number;
    /**
     * Per move of objective-path difference (bjective path: the
     * cheapest complete path built to stand up to opposition - open slots
     * only, no opponent-controlled stations, steps into ringed stations
     * doubled). Capped like the distance.
     */
    objective: number;
}

export const RACE_WEIGHTS: RaceWeights = {
    race: 10,
    urgency: 30,
    tempo: 4,
    // The objective path covers what redundancy and fragility approximated
    // (robust, committed routes); with all three on, they pulled against each
    redundancy: 0,
    fragility: 0,
    objective: 4,
};

export interface MinimaxOptions {
    id?: string;
    label?: string;
    /** Wall-clock budget per move (ms). */
    timeMs?: number;
    maxDepth?: number;
    /** Depths that always complete regardless of the budget. */
    minDepth?: number;
    seed?: number;
    weights?: Partial<RaceWeights>;
    /** Interior-node width cap after relevance ordering. */
    width?: number;
    /** Resolve 1-move threats at the horizon (default true). */
    threatCheck?: boolean;
    /** Use the opening plan for the first moves (default true). */
    opening?: boolean;
    /** Root penalty for back-and-forth on a churned slot (default CHURN; 0 turns it off). */
    churnPenalty?: number;
    /** Root penalty for reversing back when a lock was available (default RESTORE_WITHOUT_LOCK; 0 turns it off). */
    restorePenalty?: number;
    /** Root penalty for a move with no measurable effect (default NO_EFFECT; 0 turns it off). */
    noEffectPenalty?: number;
    /** root filters: purposeless reversals, unsupported rings, early centre bridges (default true). */
    rootFilters?: boolean;
}

/**
 * Root penalty per time the opponent has already knocked my rings off a
 * station this game (capped at 3). Rebuilding behind a link they can undo just
 * trades two of my moves for one of theirs; the penalty makes the agent lock
 * or reroute first unless rebuilding is clearly best.
 */
const FUTILITY = 6;
/** Defences tried against a 1-move threat at the horizon. */
const DEFENCE_WIDTH = 14;
/** Reversal/removal moves kept per interior node, on top of `width`. */
const TACTICAL_WIDTH = 6;
const WIN = 1_000_000;
const NEAR_WIN = 100_000;
/** Per ply of delay: a later loss beats an earlier one, a sooner win beats a later one. */
const PLY_STEP = 1_000;
/** Race scores added to decided values only to rank them; kept below one PLY_STEP. */
const RACE_CLAMP = 400;
const clampRace = (v: number): number => Math.max(-RACE_CLAMP, Math.min(RACE_CLAMP, v));
const SLACK = 1;
/** Distances above this count as this in the evaluation (a full rebuild from scratch is 12-13). */
const DISTANCE_CAP = 15;
/**
 * Root penalty for a minor-effect move (see `minorEffect`) on a slot that has
 * already changed twice or more in the last CHURN_WINDOW plies. That is the
 * reversal / remove-and-replace back-and-forth: within a 2-ply search a
 * reversal looks durable because the opponent may not undo it immediately,
 * but two plies later they can, and both sides have spent moves for nothing.
 * Set above the value of one move of distance, so the agent breaks the cycle
 * whenever anything else is roughly as good.
 */
const CHURN = 12;
const CHURN_WINDOW = 16;
/**
 * Root penalty for reversing back a bridge the opponent reversed on the last
 * ply when a lock was available instead: a fresh bridge of the same colour and
 * direction in another slot of that pair. The opponent's reversed bridge then
 * runs the other way, so neither can be reversed again and the exchange ends;
 * reversing back invites them to reverse it once more.
 */
const RESTORE_WITHOUT_LOCK = 6;
/**
 * Root penalty for a move with no measurable effect at all: neither distance,
 * fragility, tied-route count nor ring count changes for either side. Such a
 * move must earn its place through the search (prevention, a setup two moves
 * deep); when the search finds it merely as good as a move that does
 * something, the move that does something wins. Half a move of distance.
 */
const NO_EFFECT = 4;
/**
 * Tony's rules (from his notes on the old minimax) are hard filters on the
 * moves the search considers, for both sides at every node; see tonyAllows().
 * As root penalties they were outbid: one move of race distance is worth 10.
 * Centre bridges wait until a path is predictable: until the player laying
 * its exit, or the player it blocks, is this many moves from finishing.
*/
const CENTER_OPEN = 6;
/**
 * Ten-round clock: the game is drawn when no ring is added or removed for
 * DRAW_ROUND_LIMIT rounds. When that would happen within the next two plies
 * and the agent isn't behind, a move that leaves the ring count unchanged pays
 * this penalty at the root. Seen in testing: two agents building only bridges
 * drew at ply 20, and an agent 5 moves ahead drew against one 9 away.
 */
const DRAW_CLOCK = 20;

// =============================================================
// Agent
// =============================================================

interface TTEntry {
    depth: number;
    flag: 'exact' | 'lower' | 'upper';
    score: number;
    move: MoveAction | null;
}

interface NodeInfo {
    readonly summary: Record<string, RouteSummary>;
    readonly plan: Record<string, Plan>;
}

export class MinimaxAgent implements PlayerAgent {
    readonly id: string;
    readonly label: string;
    readonly description = 'Alpha-beta over race distance with plan-relevant move pruning (2-player).';
    readonly author = 'built-in';
    readonly type = 'ai-builtin' as const;

    public nodes = 0;
    public lastDepth = 0;
    public lastScore = 0;

    private readonly timeMs: number;
    private readonly maxDepth: number;
    private readonly minDepth: number;
    private readonly w: RaceWeights;
    private readonly width: number;
    private readonly threatCheck: boolean;
    private readonly useOpening: boolean;
    private readonly churnPenalty: number;
    private readonly restorePenalty: number;
    private readonly noEffectPenalty: number;
    private readonly rootFilters: boolean;
    private readonly rng: Rng;

    private me!: PlayerColor;
    private opp!: PlayerColor;
    private deadline = Infinity;
    private ctx!: MoveContext;
    private tt = new Map<string, TTEntry>();
    private info = new Map<string, NodeInfo>();
    private defence = new Map<string, number | 'win' | null>();
    // Per-game memory: my rings per station after my last move, and how often
    // the opponent has orphaned my rings on each station since.
    private gameKey = '';
    private lastMoves = -1;
    private expectedRings: Map<string, number> | null = null;
    private knockedDown = new Map<string, number>();
    private killers: Array<MoveAction | null> = [];

    constructor(opts: MinimaxOptions = {}) {
        this.id = opts.id ?? 'ai-minimax';
        this.label = opts.label ?? 'Minimax';
        this.timeMs = Math.max(1, opts.timeMs ?? 1500);
        this.maxDepth = Math.max(1, opts.maxDepth ?? 4);
        this.minDepth = Math.max(1, opts.minDepth ?? 2);
        this.w = { ...RACE_WEIGHTS, ...(opts.weights ?? {}) };
        this.width = opts.width ?? 18;
        this.threatCheck = opts.threatCheck ?? true;
        this.useOpening = opts.opening ?? true;
        this.churnPenalty = opts.churnPenalty ?? CHURN;
        this.restorePenalty = opts.restorePenalty ?? RESTORE_WITHOUT_LOCK;
        this.noEffectPenalty = opts.noEffectPenalty ?? NO_EFFECT;
        this.rootFilters = opts.rootFilters ?? true;
        this.rng = seededRng(opts.seed ?? 0x7ace);
    }

    async move(color: PlayerColor, state: FinityGameState, ctx: MoveContext): Promise<MoveAction> {
        throwIfAborted(ctx);
        this.ctx = ctx;
        this.me = color;
        this.opp = state.config.playerColors.find((c) => c !== color)!;
        this.nodes = 0;
        this.lastDepth = 0;
        this.tt = new Map();
        this.info = new Map();
        this.defence = new Map();
        this.killers = [];
        this.rememberKnockdowns(state, color);

        const legal = legalMoves(state, color);
        if (legal.length === 0) throw new IllegalMoveError(color, { type: 'remove' }, 'no legal moves available');
        if (legal.length === 1) return legal[0];

        // 1. An immediate win is always played.
        const info = this.analyze(state);
        if (info.summary[color].distance <= 1) {
            const win = this.winningMove(state, color, legal);
            if (win) return this.played(state, color, win);
        }

        // 2. Opening plan (only while nobody is under any threat).
        if (this.useOpening) {
            const book = openingMove(state, color, legal, info.summary[color], info.summary[this.opp]);
            if (book) return this.played(state, color, book);
        }

        // 3. Search.
        const roots = this.rootCandidates(state, color, legal, info);
        const startTime = Date.now();
        const budgetEnd = startTime + this.timeMs;
        let best = roots[0].move;
        let scores = new Map<MoveAction, number>();

        for (let depth = 1; depth <= this.maxDepth; depth++) {
            this.deadline = depth <= this.minDepth ? Infinity : budgetEnd;
            try {
                const ordered = depth === 1 ? roots : [...roots].sort((a, b) => (scores.get(b.move) ?? -Infinity) - (scores.get(a.move) ?? -Infinity));
                const res = this.searchRoot(state, ordered, depth);
                best = res.move;
                scores = res.scores;
                this.lastDepth = depth;
                this.lastScore = res.score;
                // only a win the search actually reached ends deepening early. A
                // horizon "near-win" rests on a capped defence check (DEFENCE_WIDTH)
                // and can be wrong; a found loss might be delayed. Keep deepening.
                if (res.score >= WIN / 2) break;
            } catch (e) {
                if (e instanceof SearchDeadlineReached) break;
                throw e;
            }
            // don't start a depth that clearly can't finish
            const spent = Date.now() - startTime;
            if (Date.now() + spent * 3 > budgetEnd) break;
        }
        return this.played(state, color, best);
    }

    // ---------------------------------------------------------
    // Per-game memory
    // ---------------------------------------------------------

    private ringsByStation(state: FinityGameState, color: PlayerColor): Map<string, number> {
        const out = new Map<string, number>();
        for (const [name, st] of Object.entries(state.board.stations)) {
            const n = st.rings.filter((r) => r !== null && r.color === color).length;
            if (n > 0) out.set(name, n);
        }
        return out;
    }

    /** Count rings of mine that disappeared since my last move (the opponent orphaned them). */
    private rememberKnockdowns(state: FinityGameState, color: PlayerColor): void {
        const key = `${color}|${state.pathPattern.join('')}`;
        const moves = state.moveHistory.length;
        if (key !== this.gameKey || moves <= this.lastMoves || this.expectedRings === null) {
            this.gameKey = key;
            this.knockedDown = new Map();
            this.expectedRings = null;
            this.lastMoves = moves;
            return;
        }
        const now = this.ringsByStation(state, color);
        for (const [st, n] of this.expectedRings) {
            const lost = n - (now.get(st) ?? 0);
            if (lost > 0) this.knockedDown.set(st, (this.knockedDown.get(st) ?? 0) + lost);
        }
        this.lastMoves = moves;
    }

    private played(state: FinityGameState, color: PlayerColor, move: MoveAction): MoveAction {
        this.expectedRings = this.ringsByStation(applyMove(state, move), color);
        return move;
    }

    private futility(move: MoveAction): number {
        if (moveCategory(move) !== 'ring' || !move.station) return 0;
        return FUTILITY * Math.min(3, this.knockedDown.get(move.station) ?? 0);
    }

    // ---------------------------------------------------------
    // Analysis cache
    // ---------------------------------------------------------

    private analyze(state: FinityGameState): NodeInfo {
        const key = state.zobristHash;
        const hit = this.info.get(key);
        if (hit) return hit;
        const summary: Record<string, RouteSummary> = {};
        const plan: Record<string, Plan> = {};
        for (const c of state.config.playerColors) {
            summary[c] = routeSummary(state, c, SLACK, true);
            plan[c] = planOf(state, summary[c]);
        }
        const out = { summary, plan };
        this.info.set(key, out);
        return out;
    }

    // ---------------------------------------------------------
    // Root
    // ---------------------------------------------------------

    private rootCandidates(
        state: FinityGameState,
        color: PlayerColor,
        legal: MoveAction[],
        info: NodeInfo,
    ): Array<{ move: MoveAction; prior: number; pen: number }> {
        const other = this.opp;
        const scored: Array<{ move: MoveAction; prior: number; pen: number }> = [];
        for (const m of legal) {
            const t = isTactical(m)
                ? tacticalEffect(state, m, color, other, info)
                : null;

            const r = t ? t.value : moveRelevance(m, info.plan[color], info.plan[other]);
            if (r === null) continue;
            if (this.rootFilters && !this.rootAllow(state, m, color, info, t?.lostOp ?? 0)) continue;
            scored.push({ move: m, prior: r, pen: 0 });
        }
        if (scored.length === 0) {
            // nothing touches a route: fall back to everything, rings first
            for (const m of legal) scored.push({ move: m, prior: moveCategory(m) === 'ring' ? 1 : 0, pen: 0 });
        }
        const churned = recentSlotChanges(state, CHURN_WINDOW);
        const supported = new Set<MoveAction>();
        const progress = new Set<MoveAction>();
        // order by one-ply static value (cheap enough at the root)
        for (const s of scored) {
            const child = applyMove(state, s.move);
            if (!this.rootFilters || this.rootAllow(state, s.move, color, info, 0, child)) supported.add(s.move);
            if (this.analyze(child).summary[color].distance < info.summary[color].distance) progress.add(s.move);

            // the seeded jitter only breaks exact ties, reproducibly
            s.prior = s.prior * 0.01 + this.staticFromMover(child, color) + this.rng() * 1e-6;
            const slot = moveSlot(s.move);
            const churn = this.churnPenalty > 0 && slot !== null && (churned.get(slot) ?? 0) >= 2 && this.minorEffect(state, child, color)
                ? this.churnPenalty : 0;
            const restore = this.restorePenalty > 0 && isRestoreWithLockAvailable(state, s.move, legal) ? this.restorePenalty : 0;
            const idle = this.noEffectPenalty > 0 && churn === 0 && this.noEffect(state, child, color) ? this.noEffectPenalty : 0;
            const clock = this.drawClockPenalty(state, child, color, info);
            s.pen = this.futility(s.move) + churn + restore + idle + clock;
        }
        // scored.sort((a, b) => (b.prior - b.pen) - (a.prior - a.pen));
        // return scored;
        let kept = scored.filter((s) => supported.has(s.move));
        if (!kept.some((s) => progress.has(s.move))) {
            const doublings = kept.filter((s) => isDoubling(state, s.move)).map((s) => s.move);
            const clockLate = DRAW_ROUND_LIMIT * state.config.playerColors.length - (state.turnsSinceRingChange + 1) <= 2;
            kept = kept.concat(scored.filter((s) => !supported.has(s.move) && moveCategory(s.move) === 'ring' && progress.has(s.move) &&
                (clockLate || !doublings.some((d) => ringSafeAfter(state, d, s.move, color, other)))));
        }
        // never leave the root empty: if every candidate breaks a rule, keep them all
        if (kept.length === 0) kept = scored;
        kept.sort((a, b) => (b.prior - b.pen) - (a.prior - a.pen));
        return kept;
    }

    /**
     * A move whose effect the opponent can simply buy back with one move: it
     * doesn't shorten my route, adds at most 1 to theirs, orphans none of
     * their rings and doesn't answer a 1-move threat. On a slot that keeps
     * changing hands, such moves are the back-and-forth.
     */
    private minorEffect(before: FinityGameState, after: FinityGameState, mover: PlayerColor): boolean {
        if (after.playStatus === 'over') return false;
        const other = mover === this.me ? this.opp : this.me;
        const b = this.analyze(before).summary;
        const a = this.analyze(after).summary;
        if (a[mover].distance < b[mover].distance) return false;
        if (a[other].distance - b[other].distance >= 2) return false;
        if (b[other].distance <= 1 && a[other].distance >= 2) return false;
        if (ringsOf(after, other) < ringsOf(before, other)) return false;
        return true;
    }

    /** See DRAW_CLOCK. */
    private drawClockPenalty(before: FinityGameState, after: FinityGameState, me: PlayerColor, info: NodeInfo): number {
        if (after.playStatus === 'over' && after.winners.length > 0) return 0;
        const limit = DRAW_ROUND_LIMIT * before.config.playerColors.length;
        if (limit - (before.turnsSinceRingChange + 1) > 2) return 0;
        const opp = me === this.me ? this.opp : this.me;
        if (info.summary[me].distance > info.summary[opp].distance) return 0; // behind: a draw is fine
        const ringsChanged = ringsOf(after, me) !== ringsOf(before, me) || ringsOf(after, opp) !== ringsOf(before, opp);
        return ringsChanged ? 0 : DRAW_CLOCK;
    }

    /**
     * hard filters on the moves searched (both sides, every node):
     *  - a reversal must orphan a ring, answer a 1-move threat, or lay a step
     *    of the mover's objective path in a pair with no open slot (with an
     *    open slot, a fresh bridge lays the same step and doubles the link);
     *  - a centre bridge must answer a 1-move threat, be the mover's own exit
     *    once it is CENTRE_OPEN or fewer moves from finishing, or block the
     *    opponent's exit once they are;
     *  - with `after` (the root only, since it costs a move generation): a
     *    ring must not be one the opponent can orphan in one move, unless it
     *    wins or answers a 1-move threat.
     */
    private rootAllow(
        state: FinityGameState,
        m: MoveAction,
        stm: PlayerColor,
        info: NodeInfo,
        lostOp: number,
        after?: FinityGameState
    ): boolean {
        const other = stm === this.me ? this.opp : this.me;
        const threatened = info.summary[other].distance <= 1;
        const add = m.pieceToAdd;
        const cat = moveCategory(m);
        if (cat === 'reverse' && add?.type === 'arrow') {
            if (lostOp > 0 || threatened) return true;
            return (
                info.plan[stm].objective.has(arrowTriple(add)) &&
                openSlots(state, add.fromStation, add.toStation) === 0
            );
        }

        if (cat === 'arrow' && add?.type === 'arrow' &&
            (add.toStation === 'C' || add.fromStation === 'C')
        ) {
            if (threatened) return true;
            const k = arrowTriple(add);
            if (add.toStation === 'C' &&
                info.plan[stm].triples.has(k) &&
                info.summary[stm].distance <= CENTER_OPEN) return true;
            const theirs = info.plan[other];
            return (
                info.summary[other].distance <= CENTER_OPEN &&
                theirs.pairs.has(pairKey(add.fromStation, add.toStation)) &&
                !theirs.triples.has(k)
            );
        }

        if (cat === 'ring' && after) {
            if (after.winners.includes(stm) || threatened) return true;
            return !ringExposed(after, stm, other);
        }

        return true;
    }

    /** Nothing measurable changes for either side: distances, fragility, tied routes, rings. */
    private noEffect(before: FinityGameState, after: FinityGameState, mover: PlayerColor): boolean {
        if (after.playStatus === 'over') return false;
        const other = mover === this.me ? this.opp : this.me;
        const b = this.analyze(before).summary;
        const a = this.analyze(after).summary;
        for (const c of [mover, other]) {
            if (a[c].distance !== b[c].distance || a[c].fragility !== b[c].fragility || a[c].bestCount !== b[c].bestCount) return false;
            if (ringsOf(after, c) !== ringsOf(before, c)) return false;
        }
        return true;
    }

    private searchRoot(
        state: FinityGameState,
        roots: Array<{ move: MoveAction; prior: number; pen: number }>,
        depth: number,
    ): { move: MoveAction; score: number; scores: Map<MoveAction, number> } {
        let alpha = -Infinity;
        const beta = Infinity;
        let best = roots[0].move;
        let bestScore = -Infinity;
        let bestPrior = -Infinity;
        const scores = new Map<MoveAction, number>();

        for (const { move, prior, pen } of roots) {
            const child = applyMove(state, move);
            // search against a window shifted by the penalty, so pruning stays exact for the adjusted score
            const score = -this.search(child, this.opp, depth - 1, -beta, -(alpha + pen), 1) - pen;
            scores.set(move, score);
            if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && prior > bestPrior)) {
                bestScore = score;
                best = move;
                bestPrior = prior;
            }
            if (score > alpha) alpha = score - 1e-9;
        }
        return { move: best, score: bestScore, scores };
    }

    // ---------------------------------------------------------
    // Negamax. `stm` is the side to move at `state`; values are from its view.
    // ---------------------------------------------------------

    private search(state: FinityGameState, stm: PlayerColor, depth: number, alpha: number, beta: number, ply: number): number {
        this.checkBudget();
        this.nodes++;

        if (state.playStatus === 'over') return this.terminal(state, stm, ply);
        if (depth <= 0) return this.leaf(state, stm, ply);

        const key = state.zobristHash;
        const hit = this.tt.get(key);
        let ttMove: MoveAction | null = null;
        if (hit) {
            ttMove = hit.move;
            if (hit.depth >= depth) {
                if (hit.flag === 'exact') return hit.score;
                if (hit.flag === 'lower' && hit.score > alpha) alpha = hit.score;
                else if (hit.flag === 'upper' && hit.score < beta) beta = hit.score;
                if (alpha >= beta) return hit.score;
            }
        }

        const other = stm === this.me ? this.opp : this.me;
        const info = this.analyze(state);

        // A side with a 1-move win takes it.
        if (info.summary[stm].distance <= 1) {
            const win = this.winningMove(state, stm, legalMoves(state, stm));
            if (win) return WIN - ply;
        }

        const moves = this.candidates(state, stm, other, info, ttMove, ply);
        if (moves.length === 0) return this.leaf(state, stm, ply);

        const alphaOrig = alpha;
        let bestScore = -Infinity;
        let bestMove: MoveAction | null = null;
        for (let i = 0; i < moves.length; i++) {
            const child = applyMove(state, moves[i]);
            let score: number;
            if (i === 0) {
                score = -this.search(child, other, depth - 1, -beta, -alpha, ply + 1);
            } else {
                score = -this.search(child, other, depth - 1, -alpha - 1e-6, -alpha, ply + 1);
                if (score > alpha && score < beta) score = -this.search(child, other, depth - 1, -beta, -alpha, ply + 1);
            }
            if (score > bestScore) {
                bestScore = score;
                bestMove = moves[i];
            }
            if (score > alpha) alpha = score;
            if (alpha >= beta) {
                this.killers[ply] = moves[i];
                break;
            }
        }

        const flag = bestScore <= alphaOrig ? 'upper' : bestScore >= beta ? 'lower' : 'exact';
        this.tt.set(key, { depth, flag, score: bestScore, move: bestMove });
        return bestScore;
    }

    private candidates(
        state: FinityGameState,
        stm: PlayerColor,
        other: PlayerColor,
        info: NodeInfo,
        ttMove: MoveAction | null,
        ply: number,
    ): MoveAction[] {
        const all = legalMoves(state, stm);
        const killer = this.killers[ply];
        const quiet: Array<{ m: MoveAction; v: number }> = [];
        const sharp: Array<{ m: MoveAction; v: number }> = [];
        for (const m of all) {
            let v: number | null;
            let lostOp = 0;
            const tactical = isTactical(m);
            if (tactical) {
                // reversals and removals are judged by what they actually do:
                // a bridge both players use can still be worth cutting if it
                // orphans the opponent's rings
                const t = tacticalEffect(state, m, stm, other, info);
                v = t.value;
                lostOp = t.lostOp;
            } else {
                v = moveRelevance(m, info.plan[stm], info.plan[other]);
            }
            if (v === null) continue;
            // the opponent is searched under the same rules, so phantom purposeless
            // reversals don't make every line look fragile
            if (this.rootFilters && !this.rootAllow(state, m, stm, info, lostOp)) continue;

            if (ttMove && sameMove(m, ttMove)) v += 100;
            else if (killer && sameMove(m, killer)) v += 50;
            (tactical ? sharp : quiet).push({ m, v });
        }
        quiet.sort((a, b) => b.v - a.v);
        sharp.sort((a, b) => b.v - a.v);
        const merged = [...quiet.slice(0, this.width), ...sharp.slice(0, TACTICAL_WIDTH)];
        merged.sort((a, b) => b.v - a.v);
        return merged.map((x) => x.m);
    }

    // ---------------------------------------------------------
    // Values
    // ---------------------------------------------------------

    private terminal(state: FinityGameState, stm: PlayerColor, ply: number): number {
        if (state.winners.includes(stm)) return WIN - ply;
        if (state.winners.length > 0) return -(WIN - ply);
        if (state.endReason === 'repetition') {
            // void game: a loss for both, so bad for the root player either way
            return stm === this.me ? -(WIN - ply) : WIN - ply;
        }
        return 0;
    }

    /** Race value of a quiet position, from the view of the player whose summary is `x`. */
    private race(x: RouteSummary, y: RouteSummary, xToMove: boolean): number {
        const u = (d: number) => 1 / (d + 1);
        // "No route" (99) is worse than any real route, but only a little: a
        // player without a route who rebuilds one at distance 10 is still 10
        // moves away. Uncapped, the gap dwarfs every other term and the agent
        // spends its moves keeping the opponent routeless instead of finishing.
        const dx = Math.min(x.distance, DISTANCE_CAP);
        const dy = Math.min(y.distance, DISTANCE_CAP);
        const ox = Math.min(x.objective, DISTANCE_CAP);
        const oy = Math.min(y.objective, DISTANCE_CAP);
        return (
            this.w.race * (dy - dx) +
            this.w.objective * (oy - ox) +
            this.w.urgency * (u(dx) - u(dy)) +
            this.w.redundancy * (Math.log2(1 + x.bestCount) - Math.log2(1 + y.bestCount)) +
            this.w.fragility * (y.fragility - x.fragility) +
            (xToMove ? this.w.tempo : -this.w.tempo)
        );
    }

    /** Static value from the view of the player who just moved into `state`. */
    private staticFromMover(state: FinityGameState, mover: PlayerColor): number {
        if (state.playStatus === 'over') {
            if (state.winners.includes(mover)) return WIN;
            if (state.winners.length > 0) return -WIN;
            return state.endReason === 'repetition' ? -WIN : 0;
        }
        const other = mover === this.me ? this.opp : this.me;
        const info = this.analyze(state);
        const a = info.summary[mover];
        const b = info.summary[other];
        // left the opponent a 1-move win (unverified): rank such moves among themselves by the race
        if (b.distance <= 1) return -NEAR_WIN / 2 + clampRace(this.race(a, b, false));
        return this.race(a, b, false);
    }

    /** Horizon value from the side to move's view, with 1-move threats resolved. */
    private leaf(state: FinityGameState, stm: PlayerColor, ply: number): number {
        const other = stm === this.me ? this.opp : this.me;
        const info = this.analyze(state);
        const a = info.summary[stm];
        const b = info.summary[other];

        if (this.threatCheck) {
            if (a.distance <= 1 && this.winningMove(state, stm, legalMoves(state, stm))) return NEAR_WIN - PLY_STEP * ply;
            if (b.distance <= 1) return this.bestDefence(state, stm, other, info, ply);
        }
        return this.race(a, b, true);
    }

    /**
     * `other` threatens to complete next move and `stm` cannot win first.
     * Try stm's moves that touch other's routes; a defence works if it leaves
     * other at distance >= 2. Value = best surviving position, or a near-loss.
     *
     * A near-loss is graded, not flat: it is worse the sooner it comes, and
     * among equally soon losses the better race position ranks higher. With a
     * flat value every move of a lost position scores the same and the choice
     * is arbitrary; against a fallible opponent the graded choice keeps
     * building and keeps resisting, and wins when they miss the finish.
     */
    private bestDefence(state: FinityGameState, stm: PlayerColor, other: PlayerColor, info: NodeInfo, ply: number): number {
        const lost = -(NEAR_WIN - PLY_STEP * (ply + 1)) + clampRace(this.race(info.summary[stm], info.summary[other], true));
        const key = state.zobristHash;
        let found = this.defence.get(key);
        if (found === undefined) {
            found = this.searchDefences(state, stm, other, info);
            this.defence.set(key, found);
        }
        if (found === null) return lost;
        if (found === 'win') return NEAR_WIN - PLY_STEP * ply;
        return found;
    }

    /**
     * Best value over stm's defences that leave `other` at distance >= 2, 'win'
     * if a defence completes stm's own path, or null if none holds. Candidates
     * are stm's moves that touch other's routes (plus base moves), best first,
     * at most DEFENCE_WIDTH of them.
     */
    private searchDefences(state: FinityGameState, stm: PlayerColor, other: PlayerColor, info: NodeInfo): number | 'win' | null {
        const empty: Plan = { distance: 99, triples: new Map(), pairs: new Set(), stations: new Map(), starts: new Set(), relocateTo: null, objective: new Set() };
        const ranked: Array<{ m: MoveAction; r: number }> = [];
        for (const m of legalMoves(state, stm)) {
            const r = isTactical(m)
                ? tacticalValue(state, m, stm, other, { plan: { [stm]: empty, [other]: info.plan[other] } })
                : moveRelevance(m, empty, info.plan[other]);
            if (r === null && moveCategory(m) !== 'basePost') continue;
            ranked.push({ m, r: r ?? 0 });
        }
        ranked.sort((x, y) => y.r - x.r);
        let best: number | null = null;
        for (const { m } of ranked.slice(0, DEFENCE_WIDTH)) {
            this.checkBudget();
            const child = applyMove(state, m);
            if (child.playStatus === 'over') {
                if (child.winners.includes(stm)) return 'win';
                continue; // completing the opponent's path, or a void game, is no defence
            }
            const ci = this.analyze(child);
            if (ci.summary[other].distance <= 1) continue; // threat still there
            const v = this.race(ci.summary[stm], ci.summary[other], false);
            if (best === null || v > best) best = v;
        }
        return best;
    }

    /** A move that completes `color`'s path right now, if one exists. */
    private winningMove(state: FinityGameState, color: PlayerColor, moves: MoveAction[]): MoveAction | null {
        const info = this.analyze(state);
        const plan = info.plan[color];
        for (const m of moves) {
            const cat = moveCategory(m);
            // only moves that can matter for a route one move from done
            if (cat === 'blocker') continue;
            if (cat === 'ring' && !plan.stations.has(m.station!)) continue;
            if (cat === 'arrow' && !plan.triples.has(arrowTriple(m.pieceToAdd as never))) continue;
            const child = applyMove(state, m);
            if (child.winners.includes(color)) return m;
        }
        return null;
    }

    private checkBudget(): void {
        throwIfAborted(this.ctx);
        if (Date.now() >= this.deadline) throw new SearchDeadlineReached();
    }
}

/** The slot a bridge or blocker move acts on, or null for rings and base moves. */
function moveSlot(m: MoveAction): number | null {
    const add = m.pieceToAdd;
    if (add && (add.type === 'arrow' || add.type === 'blocker')) return add.slotId;
    const rem = m.pieceToRemove;
    if (rem && (rem.type === 'arrow' || rem.type === 'blocker')) return rem.slotId;
    return null;
}

/**
 * Reversing back the bridge the opponent reversed on the previous ply, when a
 * fresh bridge with the same colour and direction could go in another slot of
 * the same pair (which would lock the link instead).
 */
function isRestoreWithLockAvailable(state: FinityGameState, m: MoveAction, legal: MoveAction[]): boolean {
    if (m.type !== 'replace' || m.pieceToAdd?.type !== 'arrow') return false;
    const last = state.moveHistory[state.moveHistory.length - 1]?.move;
    if (!last || last.type !== 'replace' || last.pieceToAdd?.type !== 'arrow') return false;
    const want = m.pieceToAdd;
    if (last.pieceToAdd.slotId !== want.slotId) return false;
    return legal.some((x) =>
        x.type === 'place' && x.pieceToAdd?.type === 'arrow' && x.pieceToAdd.slotId !== want.slotId &&
        x.pieceToAdd.fromStation === want.fromStation && x.pieceToAdd.toStation === want.toStation &&
        x.pieceToAdd.color === want.color);
}

/** slot -> number of moves that touched it in the last `window` plies of the game. */
function recentSlotChanges(state: FinityGameState, window: number): Map<number, number> {
    const out = new Map<number, number>();
    const hist = state.moveHistory;
    for (let i = Math.max(0, hist.length - window); i < hist.length; i++) {
        const slot = moveSlot(hist[i].move);
        if (slot !== null) out.set(slot, (out.get(slot) ?? 0) + 1);
    }
    return out;
}

/** Reversals and bridge removals: few, and they can orphan rings. */
function isTactical(m: MoveAction): boolean {
    const cat = moveCategory(m);
    return cat === 'reverse' || (cat === 'remove' && m.pieceToRemove?.type === 'arrow');
}

/**
 * A reversal or removal judged by what it does when played: `value` ranks it
 * (rings it orphans on each side, then its effect on the two plans; null when
 * it does nothing for either side), `lostOp` is the opponent rings it orphans.
 */
function tacticalEffect(
    state: FinityGameState,
    m: MoveAction,
    stm: PlayerColor,
    other: PlayerColor,
    info: { plan: Record<string, Plan> },
): { value: number | null; lostOp: number } {
    const before = { me: ringsOf(state, stm), op: ringsOf(state, other) };
    const after = applyMove(state, m);
    const lostOp = before.op - ringsOf(after, other);
    const lostMe = before.me - ringsOf(after, stm);
    const route = moveRelevance(m, info.plan[stm], info.plan[other]) ?? 0;
    const v = 4 * lostOp - 4 * lostMe + route;

    return { value: v > 0 ? v : null, lostOp };
}

/** Rank of a reversal or removal */
function tacticalValue(
    state: FinityGameState,
    m: MoveAction,
    stm: PlayerColor,
    other: PlayerColor,
    info: { plan: Record<string, Plan> },
): number | null {
    return tacticalEffect(state, m, stm, other, info).value;
}

/** Can `opp` orphan one of `color`'s rings with a single reversal or removal? */
function ringExposed(state: FinityGameState, color: PlayerColor, opp: PlayerColor): boolean {
    const mine = ringsOf(state, color);
    return legalMoves(state, opp).some((x) => isTactical(x) && ringsOf(applyMove(state, x), color) < mine);
}

/** A bridge placement whose same-colour return bridge is already on the board: it locks that link. */
function isDoubling(state: FinityGameState, m: MoveAction): boolean {
    const a = m.pieceToAdd;
    if (m.type !== 'place' || a?.type !== 'arrow') return false;
    return state.board.slots.some((sl) => sl.contains?.type === 'arrow' && sl.contains.color === a.color &&
        sl.contains.fromStation === a.toStation && sl.contains.toStation === a.fromStation);
}

/** Would `ring` be safe from a one-move orphaning if `lock` were played first (and the opponent passed)? */
function ringSafeAfter(state: FinityGameState, lock: MoveAction, ring: MoveAction, me: PlayerColor, opp: PlayerColor): boolean {
    const locked = { ...applyMove(state, lock), turnIndex: state.turnIndex };
    const again = legalMoves(locked, me).find((x) => x.type === 'place' && x.pieceToAdd?.type === 'ring' && x.station === ring.station);
    return !!again && !ringExposed(applyMove(locked, again), me, opp);
}

/** Empty, unblocked slots between two stations. */
function openSlots(state: FinityGameState, a: string, b: string): number {
    let n = 0;
    state.board.slots.forEach((sl, id) => {
        const [x, y] = SLOT_TO_STATIONS[id];
        if (((x === a && y === b) || (x === b && y === a)) && sl.contains === null && !sl.blocked) n++;
    });
    return n;
}

function ringsOf(state: FinityGameState, color: PlayerColor): number {
    let n = 0;
    for (const st of Object.values(state.board.stations)) for (const r of st.rings) if (r && r.color === color) n++;
    return n;
}

// Structural move equality (ordering only).
function sameMove(a: MoveAction, b: MoveAction): boolean {
    if (a.type !== b.type || a.station !== b.station) return false;
    const pa = a.pieceToAdd as unknown as Record<string, unknown> | undefined;
    const pb = b.pieceToAdd as unknown as Record<string, unknown> | undefined;
    const ra = a.pieceToRemove as unknown as Record<string, unknown> | undefined;
    const rb = b.pieceToRemove as unknown as Record<string, unknown> | undefined;
    const same = (x?: Record<string, unknown>, y?: Record<string, unknown>) =>
        x === y || (!!x && !!y && x.type === y.type && x.slotId === y.slotId && x.color === y.color &&
            x.fromStation === y.fromStation && x.toStation === y.toStation && x.size === y.size);
    return same(pa, pb) && same(ra, rb);
}
