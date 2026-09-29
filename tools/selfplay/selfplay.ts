/**
 * Finity — Headless Self-Play Runner
 *
 * Plays many seeded games between two agent configurations and reports how
 * they compare. It drives the real GameOrchestrator, so every game follows the
 * same rules as the browser: legality checking, the no-undo rule, the
 * third-repetition void, the ten-round forced draw, and the move cap.
 *
 * DESIGN
 *
 *   Paired seats. Games come in pairs that share a path pattern, with the two
 *   agents swapping seats between them. Pattern luck and first-move advantage
 *   hit both agents equally and cancel, so fewer games are needed to see a
 *   real difference.
 *
 *   Seeded. One --seed determines every pattern and every agent's random
 *   stream. Time-budgeted search is NOT reproducible, though: how deep
 *   iterative deepening gets depends on CPU speed. For bit-exact replays, fix
 *   the depth and lift the time limit (timeMs=inf).
 *
 *   Graded. Most Finity games do not end in a win, so wins alone say little.
 *   Every non-win is also graded by who finished closer to completing a path.
 *   A sign test reports whether the difference is more than chance.
 *
 *   Resumable and parallel. Results stream to a JSONL file one game at a time.
 *   --shard i/n runs a slice of the games, so several processes can run side
 *   by side; --summarize merges their files afterwards.
 *
 * USAGE
 *
 *   npx tsx tools/selfplay/selfplay.ts \
 *       --a "minimax:timeMs=300,maxDepth=2,label=rings" \
 *       --b "minimax:timeMs=300,maxDepth=2,w.progress=0,w.ringDeficit=0,label=norings" \
 *       --games 40 --seed 1 --out runs/rings.jsonl
 *
 *   npx tsx tools/selfplay/selfplay.ts --summarize runs/rings.jsonl
 *
 * AGENT SPECS
 *
 *   kind[:key=value,key=value,...]
 *
 *   kinds:  minimax | mcts | random | weighted | easy | medium | hard
 *   keys:   label=<name>        name shown in reports (default: the spec)
 *           timeMs=<n|inf>      per-move budget
 *           maxDepth=<n>        minimax depth cap
 *           rolloutDepth=<n>    MCTS playout depth
 *           opponentWeight=<x>  minimax differential weight (see ai-common)
 *           rootBonuses=<0|1>   minimax root move bonuses on/off (default on)
 *           killerHistory=<0|1> minimax killer/history move ordering on/off (default on)
 *           b.<name>=<x>        override one root judgement weight, e.g. b.doubleUp=0
 *           w.<term>=<x>        override one evaluation weight
 *
 *   Unknown keys and unknown weight names are errors, not silent no-ops: a
 *   typo in w.progress would otherwise run the wrong experiment quietly.
 *
 * See docs/selfplay.md for how to read the report.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as engine from '@finity/engine';
import {
    DEFAULT_WEIGHTS,
    generatePathPattern,
    longestLegalPathLength,
    type EvalWeights,
    type FinityGameState,
    type GameConfig,
    type GameResult,
    type MoveAction,
    type PlayerColor,
} from '@finity/engine';
import {
    MinimaxAgent,
    MCTSAgent,
    RandomAgent,
    WeightedRandomAgent,
    createBuiltinAgent,
    MOVE_BONUS,
    type Difficulty,
    type PlayerAgent,
} from '@finity/agents';
import { GameRecorder, agentInfoMap } from '@finity/recorder';
// The orchestrator depends only on the engine and the agent interface, so it
// runs headlessly. It lives in the client package; adjust if it moves.
import { GameOrchestrator, type AgentMap } from '../../packages/client/src/orchestrator';

// =============================================================
// Randomness
// =============================================================

export type Rng = () => number;

/** Mulberry32: small, fast, seedable. Matches seededRng in ai-common. */
export function mulberry32(seed: number): Rng {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Derive an independent 32-bit seed from a parent seed and a label, so that
 * pattern, seat A, and seat B each get their own stream from one --seed.
 */
export function deriveSeed(parent: number, ...parts: number[]): number {
    let h = parent >>> 0;
    for (const p of parts) {
        h = Math.imul(h ^ (p + 0x9e3779b9), 0x85ebca6b) >>> 0;
        h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
        h = (h ^ (h >>> 16)) >>> 0;
    }

    return h;
}

// =============================================================
// Agent specs
// =============================================================

const KINDS = ['minimax', 'mcts', 'random', 'weighted', 'easy', 'medium', 'hard'] as const;
export type AgentKind = (typeof KINDS)[number];

export interface AgentSpec {
    kind: AgentKind;
    label: string;
    timeMs?: number;
    maxDepth?: number;
    rolloutDepth?: number;
    opponentWeight?: number;
    /** 0 turns off minimax's root move bonuses (reversal value, block impact). */
    rootBonuses?: number;
    /** 0 turns off minimax's killer-move and history ordering. */
    killerHistory?: number;
    weights: Partial<EvalWeights>;
    /** Per-agent overrides of minimax's root judgement weights (MOVE_BONUS). */
    bonus: Record<string, number>;
}

const NUMERIC_KEYS = ['timeMs', 'maxDepth', 'rolloutDepth', 'opponentWeight', 'rootBonuses', 'killerHistory'] as const;

export function parseAgentSpec(text: string): AgentSpec {
    const [kindPart, rest = ''] = text.split(':', 2);
    const kind = kindPart.trim() as AgentKind;
    if (!KINDS.includes(kind)) {
        throw new Error(`Unknown agent kind "${kindPart}". Expected one of: ${KINDS.join(', ')}`);
    }

    const spec: AgentSpec = { kind, label: text, weights: {}, bonus: {} };
    const weightNames = new Set(Object.keys(DEFAULT_WEIGHTS));

    for (const pair of rest.split(',').map((s) => s.trim()).filter(Boolean)) {
        const eq = pair.indexOf('=');
        if (eq < 0) throw new Error(`Malformed option "${pair}" in "${text}" (expected key=value)`);
        const key = pair.slice(0, eq).trim();
        const raw = pair.slice(eq + 1).trim();

        if (key === 'label') {
            spec.label = raw;
            continue;
        }

        const value = raw === 'inf' ? Number.MAX_SAFE_INTEGER : Number(raw);
        if (!Number.isFinite(value)) throw new Error(`Option "${key}" needs a number, got "${raw}"`);

        if (key.startsWith('b.')) {
            const name = key.slice(2);
            if (!(name in MOVE_BONUS)) {
                throw new Error(`Unknown move bonus "${name}". Known: ${Object.keys(MOVE_BONUS).join(', ')}`);
            }
            spec.bonus[name] = value;
            continue;
        }

        if (key.startsWith('w.')) {
            const term = key.slice(2);
            if (!weightNames.has(term)) {
                throw new Error(
                    `Unknown evaluation weight "${term}". Known: ${[...weightNames].join(', ')}`
                );
            }
            (spec.weights as Record<string, number>)[term] = value;
            continue;
        }

        if ((NUMERIC_KEYS as readonly string[]).includes(key)) {
            (spec as unknown as Record<string, number>)[key] = value;
            continue;
        }

        throw new Error(`Unknown option "${key}" in "${text}"`);
    }

    return spec;
}

type MinimaxOptions = NonNullable<ConstructorParameters<typeof MinimaxAgent>[0]>;

export function buildAgent(
    spec: AgentSpec,
    seat: PlayerColor,
    seed: number,
    playerCount: number
): PlayerAgent {
    const id = `${spec.label}-${seat}`;
    const weights: EvalWeights = { ...DEFAULT_WEIGHTS, ...spec.weights };

    switch (spec.kind) {
        case 'minimax': {
            const opts: Record<string, unknown> = {
                id,
                label: spec.label,
                timeMs: spec.timeMs ?? 1000,
                maxDepth: spec.maxDepth ?? 3,
                weights,
                seed,
            };
            if (spec.opponentWeight !== undefined) opts.opponentWeight = spec.opponentWeight;
            if (spec.rootBonuses !== undefined) opts.rootBonuses = spec.rootBonuses !== 0;
            if (spec.killerHistory !== undefined) opts.killerHistory = spec.killerHistory !== 0;
            if (Object.keys(spec.bonus).length) opts.moveBonus = spec.bonus;
            const agent = new MinimaxAgent(opts as MinimaxOptions);

            // Guard against an agent that silently ignores the option.
            if (
                spec.opponentWeight !== undefined &&
                (agent as unknown as { opponentWeight?: number }).opponentWeight !== spec.opponentWeight
            ) {
                throw new Error(
                    'MinimaxAgent does not support opponentWeight yet. Add it to MinimaxOptions ' +
                    'and pass it to differentialScore in leaf() (see docs/selfplay.md).'
                );
            }

            return agent;
        }
        case 'mcts':
            return new MCTSAgent({
                id,
                label: spec.label,
                timeMs: spec.timeMs ?? 1000,
                rolloutDepth: spec.rolloutDepth,
                evalWeights: weights,
                rng: mulberry32(seed),
            });
        case 'random':
            return new RandomAgent({ id, label: spec.label, rng: mulberry32(seed) });
        case 'weighted':
            return new WeightedRandomAgent({ id, label: spec.label, rng: mulberry32(seed) });
        default:
            if (Object.keys(spec.weights).length || spec.timeMs || spec.maxDepth) {
                throw new Error(
                    `"${spec.kind}" uses the built-in budgets and default weights. ` +
                    'Use kind "minimax" or "mcts" to override them.'
                );
            }
            return createBuiltinAgent(spec.kind as Difficulty, playerCount, seed);
    }
}

// =============================================================
// One game
// =============================================================

export type Side = 'A' | 'B';
export type MoveKind = 'ring' | 'arrow' | 'reverse' | 'remove' | 'blocker' | 'basePost';
const MOVE_KINDS: MoveKind[] = ['ring', 'arrow', 'reverse', 'remove', 'blocker', 'basePost'];

export function moveKind(move: MoveAction): MoveKind {
    const add = move.pieceToAdd;
    if (move.type === 'remove' || !add) return 'remove';
    if (add.type === 'arrow') return move.type === 'replace' ? 'reverse' : 'arrow';
    if (add.type === 'ring' || add.type === 'blocker' || add.type === 'basePost') return add.type;

    return 'remove';
}

export interface GradedScore {
    /** Name of the measure used. */
    metric: string;
    A: number;
    B: number;
    ahead: Side | 'level';
}

export interface GameRow {
    matchup: string;
    labels: Record<Side, string>;
    seed: number;
    pair: number;
    game: number;
    pattern: string;
    seats: Record<Side, PlayerColor>;
    agentSeeds: Record<Side, number>;
    reason: GameResult['reason'] | 'error';
    winner: Side | 'both' | null;
    moves: number;
    durationMs: number;
    /** Primary grading: distance to a complete path (lower is better). */
    graded: GradedScore;
    /** Cross-check: longest legal path (higher is better). */
    gradedAlt: GradedScore;
    mix: Record<Side, Record<MoveKind, number>>;
    msPerMove: Record<Side, number>;
    error?: string;
}

/**
 * movesToWin is exported once the layered planner is in the engine. Without
 * it, grading falls back to longest legal path, and the report says so.
 */
const movesToWin = (engine as unknown as Record<string, unknown>).movesToWin as
    | ((s: FinityGameState, c: PlayerColor) => number)
    | undefined;

function grade(
    metric: string,
    a: number,
    b: number,
    lowerIsBetter: boolean
): GradedScore {
    const ahead: Side | 'level' =
        a === b ? 'level' : (lowerIsBetter ? a < b : a > b) ? 'A' : 'B';

    return { metric, A: a, B: b, ahead };
}

export interface GameSettings {
    seed: number;
    maxMoves: number;
    repetitionLimit: number;
    recordsDir?: string;
}

export async function playGame(
    a: AgentSpec,
    b: AgentSpec,
    game: number,
    settings: GameSettings
): Promise<GameRow> {
    const pair = Math.floor(game / 2);
    const swapped = game % 2 === 1;
    const colors: PlayerColor[] = ['cyan', 'yellow'];
    const seats: Record<Side, PlayerColor> = swapped
        ? { A: 'yellow', B: 'cyan' }
        : { A: 'cyan', B: 'yellow' };

    // Both games of a pair share a pattern; each agent gets its own stream.
    const patternSeed = deriveSeed(settings.seed, pair, 0);
    const pattern = generatePathPattern(mulberry32(patternSeed));
    const agentSeeds: Record<Side, number> = {
        A: deriveSeed(settings.seed, pair, 1, game),
        B: deriveSeed(settings.seed, pair, 2, game),
    };

    const config: GameConfig = {
        playerColors: colors,
        boardSize: 2,
        repetitionLimit: settings.repetitionLimit,
    };
    const agents: AgentMap = {
        [seats.A]: buildAgent(a, seats.A, agentSeeds.A, 2),
        [seats.B]: buildAgent(b, seats.B, agentSeeds.B, 2),
    };
    const sideOf = (c: PlayerColor): Side => (c === seats.A ? 'A' : 'B');

    const recorder = settings.recordsDir
        ? new GameRecorder({
            agents: agentInfoMap(agents),
            metadata: { selfplay: { seed: settings.seed, game, pattern: pattern.join(''), agentSeeds, a, b } },
        })
        : undefined;

    const orch = new GameOrchestrator({
        config,
        agents,
        pathPattern: pattern,
        validateMoves: true,
        maxMoves: settings.maxMoves,
        recorder,
    });

    const mix: Record<Side, Record<MoveKind, number>> = {
        A: Object.fromEntries(MOVE_KINDS.map((k) => [k, 0])) as Record<MoveKind, number>,
        B: Object.fromEntries(MOVE_KINDS.map((k) => [k, 0])) as Record<MoveKind, number>,
    };
    const thinkMs: Record<Side, number> = { A: 0, B: 0 };
    const count: Record<Side, number> = { A: 0, B: 0 };
    let turnStarted = 0;

    orch.on('turn:start', () => {
        turnStarted = performance.now();
    });
    orch.on('turn:end', ({ color, move }) => {
        const side = sideOf(color);
        mix[side][moveKind(move)]++;
        thinkMs[side] += performance.now() - turnStarted;
        count[side]++;
    });

    const started = performance.now();
    let result: GameResult | null = null;
    let error: string | undefined;
    try {
        result = await orch.play();
    } catch (err) {
        // An illegal move or timeout forfeits the game; the orchestrator has
        // already recorded the default. Keep the row, flag the error.
        error = err instanceof Error ? err.message : String(err);
        result = orch.getResult();
    } finally {
        orch.dispose();
    }

    const state = orch.getState();
    const winners = result?.winners ?? state.winners;
    const aWon = winners.includes(seats.A);
    const bWon = winners.includes(seats.B);

    const graded = movesToWin
        ? grade('movesToWin', movesToWin(state, seats.A), movesToWin(state, seats.B), true)
        : grade(
            'longestLegalPath',
            longestLegalPathLength(state, seats.A),
            longestLegalPathLength(state, seats.B),
            false
        );
    const gradedAlt = grade(
        'longestLegalPath',
        longestLegalPathLength(state, seats.A),
        longestLegalPathLength(state, seats.B),
        false
    );

    const row: GameRow = {
        matchup: `${a.label} vs ${b.label}`,
        labels: { A: a.label, B: b.label },
        seed: settings.seed,
        pair,
        game,
        pattern: pattern.join(''),
        seats,
        agentSeeds,
        reason: result?.reason ?? (error ? 'error' : 'move_cap'),
        winner: aWon && bWon ? 'both' : aWon ? 'A' : bWon ? 'B' : null,
        moves: state.moveHistory.length,
        durationMs: Math.round(performance.now() - started),
        graded,
        gradedAlt,
        mix,
        msPerMove: {
            A: count.A ? Math.round(thinkMs.A / count.A) : 0,
            B: count.B ? Math.round(thinkMs.B / count.B) : 0,
        },
        ...(error ? { error } : {}),
    };

    if (recorder && settings.recordsDir) {
        const record = recorder.toRecord();
        if (record) {
            mkdirSync(settings.recordsDir, { recursive: true });
            const file = join(settings.recordsDir, `${settings.seed}-g${String(game).padStart(4, '0')}.json`);
            writeFileSync(file, JSON.stringify(record, null, 2));
        }
    }

    return row;
}

// =============================================================
// Match
// =============================================================

export interface MatchOptions extends GameSettings {
    games: number;
    shard?: { index: number; count: number };
    out?: string;
    onGame?: (row: GameRow, done: number, total: number) => void;
}

export async function runMatch(a: AgentSpec, b: AgentSpec, opts: MatchOptions): Promise<GameRow[]> {
    // Whole pairs only: a lone game would leave one agent with an unmatched seat.
    const games = opts.games + (opts.games % 2);
    const mine: number[] = [];
    for (let g = 0; g < games; g++) {
        const pair = Math.floor(g / 2);
        if (!opts.shard || pair % opts.shard.count === opts.shard.index) mine.push(g);
    }

    if (opts.out) mkdirSync(dirname(opts.out), { recursive: true });

    const rows: GameRow[] = [];
    for (const g of mine) {
        const row = await playGame(a, b, g, opts);
        rows.push(row);
        // Append as we go so a long run survives an interruption.
        if (opts.out) appendFileSync(opts.out, JSON.stringify(row) + '\n');
        opts.onGame?.(row, rows.length, mine.length);
    }

    return rows;
}

// =============================================================
// Summary
// =============================================================

/** Two-sided exact sign test: probability of a split at least this lopsided. */
export function signTest(wins: number, losses: number): number {
    const n = wins + losses;
    if (n === 0) return 1;
    const k = Math.max(wins, losses);
    let tail = 0;
    let term = Math.pow(0.5, n); // C(n,0) / 2^n
    for (let i = 0; i <= n; i++) {
        if (i >= k) tail += term;
        term = (term * (n - i)) / (i + 1);
    }

    return Math.min(1, 2 * tail);
}

/** Per-game score for A: 1 win or ahead, 0.5 level, 0 behind or loss. */
function scoreForA(row: GameRow): number {
    if (row.winner === 'A') return 1;
    if (row.winner === 'B') return 0;
    if (row.winner === 'both') return 0.5;
    return row.graded.ahead === 'A' ? 1 : row.graded.ahead === 'B' ? 0 : 0.5;
}

const pct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}%` : '-');

export function summarize(rows: GameRow[]): string {
    const groups = new Map<string, GameRow[]>();
    for (const r of rows) {
        const list = groups.get(r.matchup) ?? [];
        list.push(r);
        groups.set(r.matchup, list);
    }

    const out: string[] = [];
    for (const [matchup, list] of groups) {
        const { A, B } = list[0].labels;
        const n = list.length;
        const reasons = new Map<string, number>();
        for (const r of list) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);

        const aWins = list.filter((r) => r.winner === 'A').length;
        const bWins = list.filter((r) => r.winner === 'B').length;
        const nonWins = list.filter((r) => r.winner === null);

        const tally = (key: 'graded' | 'gradedAlt') => ({
            a: nonWins.filter((r) => r[key].ahead === 'A').length,
            b: nonWins.filter((r) => r[key].ahead === 'B').length,
            level: nonWins.filter((r) => r[key].ahead === 'level').length,
        });
        const g1 = tally('graded');
        const g2 = tally('gradedAlt');
        const metric = list[0].graded.metric;

        const scores = list.map(scoreForA);
        const mean = scores.reduce((s, x) => s + x, 0) / n;
        const sd = Math.sqrt(scores.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
        const ci = (1.96 * sd) / Math.sqrt(n);

        const lengths = list.map((r) => r.moves);
        const errors = list.filter((r) => r.error);

        const verdict = (p: number): string =>
            p < 0.05 ? 'unlikely to be chance' : p < 0.2 ? 'suggestive, not conclusive' : 'consistent with chance';
        out.push(`\n${matchup}  —  A = ${A}, B = ${B}`);
        out.push(`  ${n} games (${Math.ceil(n / 2)} patterns x 2 seats)\n`);
        out.push(`  Outcome   A wins ${aWins} | B wins ${bWins} | ` +
            [...reasons].map(([k, v]) => `${k} ${v}`).join(' | '));
        if (aWins + bWins > 0) {
            // Wins are the only unbiased signal, so they get their own test.
            const pw = signTest(aWins, bWins);
            out.push(`            wins sign test p = ${pw < 0.001 ? pw.toExponential(1) : pw.toFixed(3)}: ${verdict(pw)}`);
        }

        const p1 = signTest(g1.a, g1.b);
        out.push(`  Graded    A ahead ${g1.a} | B ahead ${g1.b} | level ${g1.level}` +
            `   (non-wins, by ${metric})`);
        out.push(`            sign test p = ${p1.toFixed(3)}: ${verdict(p1)}`);
        if (metric !== 'longestLegalPath') {
            const p2 = signTest(g2.a, g2.b);
            out.push(`  Cross-chk A ahead ${g2.a} | B ahead ${g2.b} | level ${g2.level}` +
                `   (by longestLegalPath, p = ${p2.toFixed(3)})`);
        }
        const pc = signTest(aWins + g1.a, bWins + g1.b);
        out.push(`  Combined  A ${aWins + g1.a} | B ${bWins + g1.b}   (wins + graded, p = ` +
            `${pc < 0.001 ? pc.toExponential(1) : pc.toFixed(3)}: ${verdict(pc)})`);
        out.push(`  Score     A ${mean.toFixed(2)} ± ${ci.toFixed(2)} (95% CI; 0.50 = even)`);
        out.push(`  Length    mean ${Math.round(lengths.reduce((s, x) => s + x, 0) / n)} moves` +
            ` (min ${Math.min(...lengths)}, max ${Math.max(...lengths)})`);

        const avg = (side: Side) =>
            Math.round(list.reduce((s, r) => s + r.msPerMove[side], 0) / n);
        out.push(`  Speed     A ${avg('A')} ms/move | B ${avg('B')} ms/move\n`);

        out.push(`  Move mix  ${MOVE_KINDS.map((k) => k.padStart(9)).join('')}`);
        for (const side of ['A', 'B'] as Side[]) {
            const totals = MOVE_KINDS.map((k) => list.reduce((s, r) => s + r.mix[side][k], 0));
            const all = totals.reduce((s, x) => s + x, 0);
            out.push(`    ${side}       ${totals.map((t) => pct(t, all).padStart(9)).join('')}`);
        }

        if (errors.length) {
            out.push(`\n  ${errors.length} game(s) ended in an error:`);
            for (const r of errors.slice(0, 5)) out.push(`    game ${r.game}: ${r.error}`);
        }
    }

    return out.join('\n');
}

export function readRows(files: string[]): GameRow[] {
    const rows: GameRow[] = [];
    for (const f of files) {
        for (const line of readFileSync(f, 'utf8').split('\n')) {
            if (line.trim()) rows.push(JSON.parse(line) as GameRow);
        }
    }

    return rows;
}

// =============================================================
// CLI
// =============================================================

interface Cli {
    a?: string;
    b?: string;
    games: number;
    seed: number;
    maxMoves: number;
    repetition: number;
    out?: string;
    records?: string;
    shard?: { index: number; count: number };
    summarize: string[];
}

function parseCli(argv: string[]): Cli {
    const cli: Cli = { games: 20, seed: 1, maxMoves: 300, repetition: 3, summarize: [] };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const next = (): string => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`${flag} needs a value`);
            return v;
        };
        switch (flag) {
            case '--a': cli.a = next(); break;
            case '--b': cli.b = next(); break;
            case '--games': cli.games = Number(next()); break;
            case '--seed': cli.seed = Number(next()); break;
            case '--max-moves': cli.maxMoves = Number(next()); break;
            case '--repetition': cli.repetition = Number(next()); break;
            case '--out': cli.out = next(); break;
            case '--records': cli.records = next(); break;
            case '--shard': {
                const [i2, n] = next().split('/').map(Number);
                if (!(n > 0 && i2 >= 0 && i2 < n)) throw new Error('--shard expects i/n with 0 <= i < n');
                cli.shard = { index: i2, count: n };
                break;
            }
            case '--summarize':
                while (argv[i + 1] && !argv[i + 1].startsWith('--')) cli.summarize.push(argv[++i]);
                break;
            case '--help':
            case '-h':
                console.log(USAGE);
                process.exit(0);
            default:
                throw new Error(`Unknown flag ${flag}\n\n${USAGE}`);
        }
    }

    return cli;
}

const USAGE = `Usage:
  npx tsx tools/selfplay/selfplay.ts --a <spec> --b <spec> [options]
  npx tsx tools/selfplay/selfplay.ts --summarize <file.jsonl> [more files...]

Options:
  --games N        games to play, rounded up to an even number (default 20)
  --seed S         master seed for patterns and agents (default 1)
  --max-moves N    move cap per game (default 300)
  --repetition N   void a game when a position occurs N times (default 3; 0 = off)
  --out FILE       append one JSON line per game
  --records DIR    also write each game's GameRecord JSON
  --shard i/n      play only pairs where pair % n == i (run n processes in parallel)

Spec:  kind[:key=value,...]
  kinds  minimax | mcts | random | weighted | easy | medium | hard
  keys   label, timeMs (number or inf), maxDepth, rolloutDepth, opponentWeight,
         rootBonuses (0 or 1), killerHistory (0 or 1), w.<weight>, b.<bonus>`;

async function main(): Promise<void> {
    const cli = parseCli(process.argv.slice(2));

    if (cli.summarize.length) {
        console.log(summarize(readRows(cli.summarize)));
        return;
    }
    if (!cli.a || !cli.b) throw new Error(`--a and --b are required\n\n${USAGE}`);

    const a = parseAgentSpec(cli.a);
    const b = parseAgentSpec(cli.b);
    if (a.label === b.label) {
        a.label = `${a.label} (A)`;
        b.label = `${b.label} (B)`;
    }

    const started = Date.now();
    const rows = await runMatch(a, b, {
        games: cli.games,
        seed: cli.seed,
        maxMoves: cli.maxMoves,
        repetitionLimit: cli.repetition,
        recordsDir: cli.records,
        shard: cli.shard,
        out: cli.out,
        onGame: (r, done, total) => {
            const secs = Math.round(r.durationMs / 1000);
            const who = r.winner ? `${r.winner} wins` : `${r.graded.ahead === 'level' ? 'level' : r.graded.ahead + ' ahead'}`;
            process.stderr.write(
                `[${done}/${total}] game ${r.game} (A=${r.seats.A})  ${r.reason.padEnd(12)} ` +
                `${String(r.moves).padStart(4)} moves  ${who.padEnd(8)} ${secs}s\n`
            );
        },
    });

    console.log(summarize(rows));
    console.log(`\n  Finished in ${Math.round((Date.now() - started) / 1000)}s` +
        (cli.out ? `; results in ${cli.out}` : ''));
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
    main().catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    });
}
