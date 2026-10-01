/**
 * Finity — Overnight Weight Tuning
 *
 * Tests every tunable weight, one at a time, most important first. For each
 * weight it plays the current AI against a version with just that weight
 * changed (by default half as strong and twice as strong), using the
 * self-play runner, and writes the results to an easy-to-read report after
 * every comparison. Any change that looks clearly better is then re-tested on
 * a fresh set of patterns before being called confirmed.
 *
 * USAGE (keep the Mac awake with caffeinate):
 *
 *   caffeinate -i npx tsx tools/selfplay/tune.ts
 *
 *   # preview the plan and time estimate without playing anything
 *   npx tsx tools/selfplay/tune.ts --dry-run
 *
 * Re-running the same command resumes: finished comparisons are skipped.
 *
 * OUTPUT (runs/tune/<name>/):
 *   results.md         the report — start here
 *   results.csv        one row per comparison, for a spreadsheet
 *   results.json       everything, machine-readable
 *   comparisons/<nn>-<weight>-x<factor>/
 *                      shard-*.jsonl (per-game results), log.txt, records/
 *                      (a GameRecord for every game, viewable in the History tab)
 *   share-with-tony/   the record folders of the best comparison for each
 *                      metric, with a README
 *
 * OPTIONS
 *   --name N          run name, so separate runs don't mix (default overnight)
 *   --games N         games per comparison, even (default 40)
 *   --shards N        parallel processes, at most your core count (default 4)
 *   --time MS         thinking time per move (default 1000, medium)
 *   --depth D         search depth cap (default 3, medium)
 *   --max-moves N     move cap per game (default 300)
 *   --seed S          patterns for the screening phase (default 7)
 *   --factors a,b     multipliers to try on each weight (default 0.5,2)
 *   --only a,b        test only these weights (names as in the report)
 *   --skip-confirm    don't re-test winners on fresh patterns
 *   --dry-run         print the plan and time estimate, then stop
 */

import { spawn } from 'node:child_process';
import {
    appendFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_WEIGHTS } from '@finity/engine';
import { MOVE_BONUS } from '@finity/agents';
import { readRows, signTest, type GameRow } from './selfplay';

// =============================================================
// The weights, most important first
// =============================================================

type DialKind = 'w' | 'b'; // evaluation weight | root move bonus

interface Dial {
    kind: DialKind;
    name: string;
    /** Why it's placed where it is — shown in the report. */
    why: string;
}

/**
 * Ordering rationale: first the terms with measured impact (the ring and
 * base-post terms produced the 16-0 result), then the terms that shape how
 * the AI builds and converts (progress, supported path), then the ones that
 * shape its fights (reversals, blocking, orphan defence), then the rest.
 */
const PRIORITY: Dial[] = [
    { kind: 'w', name: 'ringsOnBoard', why: 'Tony 3; part of the 16-0 result' },
    { kind: 'w', name: 'ringSpread', why: 'Tony 4; part of the 16-0 result' },
    { kind: 'w', name: 'baseThreatsAgainst', why: 'Tony 7; part of the 16-0 result, heaviest weight' },
    { kind: 'w', name: 'progress', why: 'distance to a finished path; the main lever on game length' },
    { kind: 'w', name: 'longestSupportedPath', why: 'largest original evaluation term' },
    { kind: 'b', name: 'orphanPerRing', why: 'Tony 1; decides which reversals are worth making' },
    { kind: 'b', name: 'wastedReversal', why: 'Tony 1; cut wasted reversals from 48% to 17%' },
    { kind: 'w', name: 'orphanVulnerability', why: 'the main defensive term' },
    { kind: 'w', name: 'closedChannels', why: 'Tony: blocked channels' },
    { kind: 'b', name: 'channelClosed', why: 'Tony 2; the bonus behind the opening blunder' },
    { kind: 'b', name: 'blockPerSlot', why: 'Tony 2; value of each slot a block takes' },
    { kind: 'w', name: 'controlledStationCount', why: 'high-point control' },
    { kind: 'w', name: 'baseThreatsBy', why: 'Tony 7, attacking side' },
    { kind: 'w', name: 'channelRedundancy', why: 'Tony: room to double up' },
    { kind: 'b', name: 'escape', why: 'base post escape when boxed in' },
    { kind: 'b', name: 'ownRoute', why: 'Tony 1; reversals toward your own route' },
    { kind: 'w', name: 'reachableStationCount', why: 'reach' },
    { kind: 'w', name: 'ringDeficit', why: 'rings still needed on your route' },
    { kind: 'b', name: 'doubleUp', why: 'Tony 5; no measured effect at default' },
    { kind: 'b', name: 'idleCentre', why: 'Tony 6; no measured effect at default' },
    { kind: 'w', name: 'longestBridgePath', why: 'raw arrow reach, ignoring rings' },
    { kind: 'w', name: 'stationPairStrength', why: 'consolidated structure' },
];

// =============================================================
// Settings
// =============================================================

interface Settings {
    name: string;
    games: number;
    shards: number;
    timeMs: number;
    depth: number;
    maxMoves: number;
    seed: number;
    factors: number[];
    only: string[] | null;
    confirm: boolean;
    dryRun: boolean;
}

function parseArgs(argv: string[]): Settings {
    const s: Settings = {
        name: 'overnight', games: 40, shards: 4, timeMs: 1000, depth: 3, maxMoves: 300,
        seed: 7, factors: [0.5, 2], only: null, confirm: true, dryRun: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`${flag} needs a value`);
            return v;
        };
        switch (flag) {
            case '--name': s.name = next(); break;
            case '--games': s.games = Number(next()); break;
            case '--shards': s.shards = Number(next()); break;
            case '--time': s.timeMs = Number(next()); break;
            case '--depth': s.depth = Number(next()); break;
            case '--max-moves': s.maxMoves = Number(next()); break;
            case '--seed': s.seed = Number(next()); break;
            case '--factors': s.factors = next().split(',').map(Number); break;
            case '--only': s.only = next().split(','); break;
            case '--skip-confirm': s.confirm = false; break;
            case '--dry-run': s.dryRun = true; break;
            default: throw new Error(`Unknown flag ${flag}`);
        }
    }
    s.games += s.games % 2; // whole pattern pairs
    if (s.factors.some((f) => !Number.isFinite(f))) throw new Error('--factors must be numbers');

    return s;
}

// =============================================================
// Plan
// =============================================================

interface Comparison {
    id: string;              // folder name, e.g. "01-ringsOnBoard-x2"
    phase: 'screen' | 'confirm';
    dial: Dial;
    defaultValue: number;
    value: number;
    factor: number;
    seed: number;
}

function defaultOf(d: Dial): number | undefined {
    const table = (d.kind === 'w' ? DEFAULT_WEIGHTS : MOVE_BONUS) as unknown as Record<string, number>;
    return table[d.name];
}

const round = (x: number) => Math.round(x * 1000) / 1000;

function buildPlan(s: Settings): { plan: Comparison[]; skipped: string[] } {
    const plan: Comparison[] = [];
    const skipped: string[] = [];
    let n = 0;
    for (const dial of PRIORITY) {
        if (s.only && !s.only.includes(dial.name)) continue;
        const def = defaultOf(dial);
        if (def === undefined) {
            skipped.push(`${dial.name} (not in this build)`);
            continue;
        }
        n++;
        for (const factor of s.factors) {
            // A weight that is 0 by default can't be scaled; try +/-1 instead.
            const value = def === 0 ? round(factor >= 1 ? 1 : -1) : round(def * factor);
            plan.push({
                id: `${String(n).padStart(2, '0')}-${dial.name}-x${factor}`,
                phase: 'screen', dial, defaultValue: def, value, factor, seed: s.seed,
            });
        }
    }

    return { plan, skipped };
}

// =============================================================
// Running one comparison
// =============================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const SELFPLAY = join(HERE, 'selfplay.ts');

function specs(s: Settings, c: Comparison): { a: string; b: string } {
    const base = `minimax:timeMs=${s.timeMs},maxDepth=${s.depth}`;
    const label = `${c.dial.name}=${c.value}`;
    return {
        a: `${base},${c.dial.kind}.${c.dial.name}=${c.value},label=${label}`,
        b: `${base},label=current`,
    };
}

function runShard(
    s: Settings, c: Comparison, dir: string, i: number, onGame: () => void,
): Promise<void> {
    const { a, b } = specs(s, c);
    const args = [
        'tsx', SELFPLAY, '--a', a, '--b', b,
        '--games', String(s.games), '--seed', String(c.seed), '--max-moves', String(s.maxMoves),
        '--shard', `${i}/${s.shards}`,
        '--out', join(dir, `shard-${i}.jsonl`),
        '--records', join(dir, 'records'),
    ];
    return new Promise((res, rej) => {
        const child = spawn('npx', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        child.stderr.on('data', (d: Buffer) => {
            const text = d.toString();
            appendFileSync(join(dir, 'log.txt'), text);
            for (const line of text.split('\n')) if (/^\[\d+\/\d+\]/.test(line)) onGame();
        });
        child.on('error', rej);
        child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`shard ${i} exited with ${code}; see ${dir}/log.txt`))));
    });
}

function rowsIn(dir: string): GameRow[] {
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => f.startsWith('shard-') && f.endsWith('.jsonl')).map((f) => join(dir, f));
    return files.length ? readRows(files) : [];
}

// =============================================================
// Metrics
// =============================================================

interface Result {
    id: string;
    phase: 'screen' | 'confirm';
    weight: string;
    kind: DialKind;
    why: string;
    defaultValue: number;
    value: number;
    factor: number;
    seed: number;
    games: number;
    aWins: number;
    bWins: number;
    winsP: number;
    combinedA: number;
    combinedB: number;
    combinedP: number;
    score: number;
    ci: number;
    completionRate: number;   // share of games ending in a completed path
    avgLength: number;
    moveCaps: number;
    verdict: string;
    minutes: number;
    records: string;
    finishedAt: string;
}

function measure(rows: GameRow[]) {
    const n = rows.length;
    const aWins = rows.filter((r) => r.winner === 'A').length;
    const bWins = rows.filter((r) => r.winner === 'B').length;
    const nonWins = rows.filter((r) => r.winner === null);
    const aAhead = nonWins.filter((r) => r.graded.ahead === 'A').length;
    const bAhead = nonWins.filter((r) => r.graded.ahead === 'B').length;
    const scores: number[] = rows.map((r) =>
        r.winner === 'A' ? 1 : r.winner === 'B' ? 0 : r.winner === 'both' ? 0.5
            : r.graded.ahead === 'A' ? 1 : r.graded.ahead === 'B' ? 0 : 0.5);
    const mean = scores.reduce((x, y) => x + y, 0) / Math.max(1, n);
    const sd = Math.sqrt(scores.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, n - 1));
    const combinedA = aWins + aAhead;
    const combinedB = bWins + bAhead;
    const combinedP = signTest(combinedA, combinedB);

    let verdict = 'no clear difference';
    if (combinedP < 0.05) verdict = mean > 0.5 ? 'BETTER' : 'WORSE';
    else if (combinedP < 0.2) verdict = mean > 0.5 ? 'leaning better' : 'leaning worse';

    return {
        games: n, aWins, bWins, winsP: signTest(aWins, bWins),
        combinedA, combinedB, combinedP,
        score: mean, ci: (1.96 * sd) / Math.sqrt(Math.max(1, n)),
        completionRate: rows.filter((r) => r.reason === 'path_complete').length / Math.max(1, n),
        avgLength: rows.reduce((x, r) => x + r.moves, 0) / Math.max(1, n),
        moveCaps: rows.filter((r) => r.reason === 'move_cap').length,
        verdict,
    };
}

// =============================================================
// Reports
// =============================================================

const pct = (x: number) => `${Math.round(x * 100)}%`;
const p3 = (p: number) => (p < 0.001 ? p.toExponential(1) : p.toFixed(3));

function writeReports(root: string, s: Settings, results: Result[], planned: number, skipped: string[]): void {
    writeFileSync(join(root, 'results.json'), JSON.stringify({ settings: s, results }, null, 2));

    const cols = ['id', 'phase', 'weight', 'kind', 'defaultValue', 'value', 'factor', 'seed', 'games',
        'aWins', 'bWins', 'winsP', 'combinedA', 'combinedB', 'combinedP', 'score', 'ci',
        'completionRate', 'avgLength', 'moveCaps', 'verdict', 'minutes', 'records'] as const;
    writeFileSync(join(root, 'results.csv'),
        [cols.join(','), ...results.map((r) => cols.map((c) => JSON.stringify((r as never)[c] ?? '')).join(','))].join('\n') + '\n');

    const screen = results.filter((r) => r.phase === 'screen');
    const confirm = results.filter((r) => r.phase === 'confirm');
    const best = bestPerMetric(screen);

    const lines: string[] = [];
    lines.push(`# Weight tuning — ${s.name}`, '');
    lines.push(`${screen.length} of ${planned} screening comparisons done` +
        (confirm.length ? `, ${confirm.length} confirmation runs` : '') + `. Updated ${new Date().toLocaleString()}.`, '');
    lines.push(`Each comparison: **${s.games} games** at ${s.timeMs} ms per move (depth ${s.depth}), ` +
        `the current AI against a copy with **one weight changed**. Patterns are played in pairs ` +
        `with seats swapped, so luck and first-move advantage cancel.`, '');

    lines.push('## How to read this', '');
    lines.push('- **Verdict** — BETTER / WORSE mean the difference is unlikely to be luck (p < 0.05). ' +
        '"Leaning" means suggestive (p < 0.2). Anything else: keep the current value.');
    lines.push('- **Wins** — changed AI vs current AI. The cleanest signal.');
    lines.push('- **Combined** — wins plus, for unfinished games, who ended closer to completing a path.');
    lines.push('- **Score** — the changed AI\'s average result (1 win, 0.5 even, 0 loss). Above 0.50 is better.');
    lines.push('- **Completed** — share of games that ended with a finished path. Higher is better.');
    lines.push('- **Length** — average moves per game. Good human games run about 100.');
    lines.push('- A BETTER result is only trusted once **confirmed** on a fresh set of patterns (bottom section).', '');

    if (confirm.length) {
        lines.push('## Confirmed changes', '');
        lines.push('| Weight | Current | New | Screen | Confirm | Keep? |', '|---|---|---|---|---|---|');
        for (const c of confirm) {
            const sc = screen.find((r) => r.weight === c.weight && r.value === c.value);
            const keep = c.verdict === 'BETTER' || c.verdict === 'leaning better' ? '**yes**' : 'no';
            lines.push(`| ${c.weight} | ${c.defaultValue} | ${c.value} | ${sc?.verdict ?? ''} (${sc ? sc.score.toFixed(2) : ''}) | ` +
                `${c.verdict} (${c.score.toFixed(2)}) | ${keep} |`);
        }
        lines.push('');
    }

    lines.push('## Best comparison for each metric', '');
    if (!best.length) lines.push('_Nothing stands out yet._', '');
    if (best.length) {
        lines.push('| Metric | Weight | Value | Result | Game records |', '|---|---|---|---|---|');
        for (const b of best) {
            lines.push(`| ${b.metric} | ${b.r.weight} | ${b.r.defaultValue} → ${b.r.value} | ${b.detail} | \`${b.r.records}\` |`);
        }
        lines.push('', 'Copies of these record folders are in `share-with-tony/`.', '');
    }

    lines.push('## All screening results (in the order tested)', '');
    lines.push('| # | Weight | Current → tested | Verdict | Wins | Combined (p) | Score | Completed | Length | Caps |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const r of screen) {
        const v = r.verdict === 'BETTER' || r.verdict === 'WORSE' ? `**${r.verdict}**` : r.verdict;
        lines.push(`| ${r.id.slice(0, 2)} | ${r.weight} | ${r.defaultValue} → ${r.value} | ${v} | ` +
            `${r.aWins}–${r.bWins} | ${r.combinedA}–${r.combinedB} (${p3(r.combinedP)}) | ` +
            `${r.score.toFixed(2)} ± ${r.ci.toFixed(2)} | ${pct(r.completionRate)} | ${Math.round(r.avgLength)} | ${r.moveCaps} |`);
    }
    lines.push('');

    const pending = planned - screen.length;
    if (pending > 0) lines.push(`_${pending} screening comparison(s) still to run._`, '');
    if (skipped.length) lines.push(`Skipped: ${skipped.join(', ')}.`, '');

    lines.push('## Weights, in the order tested', '');
    for (const d of PRIORITY) {
        const def = defaultOf(d);
        if (def !== undefined) lines.push(`- **${d.name}** (${d.kind === 'w' ? 'evaluation' : 'move bonus'}, currently ${def}) — ${d.why}`);
    }
    lines.push('');

    writeFileSync(join(root, 'results.md'), lines.join('\n'));
    refreshShareFolder(root, best);
}

/**
 * The standout comparison for each metric — only where something actually
 * stands out, so the share folder never fills with arbitrary picks:
 *   score / win margin: only changes that beat the current AI;
 *   completed paths / game length: only when the best clearly differs from
 *   the typical comparison (5 points of completion rate, or 10 moves).
 */
function bestPerMetric(results: Result[]) {
    const out: Array<{ metric: string; r: Result; detail: string }> = [];
    if (!results.length) return out;
    const pick = (cmp: (a: Result, b: Result) => number) => [...results].sort(cmp)[0];
    const median = (xs: number[]) => {
        const v = [...xs].sort((a, b) => a - b);
        return v.length ? v[Math.floor(v.length / 2)] : 0;
    };

    const byScore = pick((a, b) => b.score - a.score);
    if (byScore.score > 0.5 && byScore.verdict !== 'no clear difference') {
        out.push({ metric: 'Highest score', r: byScore, detail: `${byScore.score.toFixed(2)} (${byScore.verdict})` });
    }
    const byWins = pick((a, b) => (b.aWins - b.bWins) - (a.aWins - a.bWins));
    if (byWins.aWins - byWins.bWins > 0) {
        out.push({ metric: 'Biggest win margin', r: byWins, detail: `${byWins.aWins}–${byWins.bWins} wins (p ${p3(byWins.winsP)})` });
    }
    const byCompletion = pick((a, b) => b.completionRate - a.completionRate);
    if (byCompletion.completionRate - median(results.map((r) => r.completionRate)) >= 0.05) {
        out.push({ metric: 'Most completed paths', r: byCompletion, detail: `${pct(byCompletion.completionRate)} of games` });
    }
    const byLength = pick((a, b) => a.avgLength - b.avgLength);
    if (median(results.map((r) => r.avgLength)) - byLength.avgLength >= 10) {
        out.push({ metric: 'Shortest games', r: byLength, detail: `${Math.round(byLength.avgLength)} moves on average` });
    }

    return out;
}

function refreshShareFolder(root: string, best: ReturnType<typeof bestPerMetric>): void {
    const share = join(root, 'share-with-tony');
    rmSync(share, { recursive: true, force: true });
    if (!best.length) return;
    mkdirSync(share, { recursive: true });
    const readme = ['# Finity AI tuning — game records', '',
        'Each folder holds every game from one comparison: the current AI against a copy with one',
        'weight changed. Each .json file is one complete game; open it in the History tab to replay it',
        'move by move. The file metadata records the seed, the pattern, and both AI settings.', ''];
    for (const b of best) {
        const folder = `${b.metric.toLowerCase().replace(/[^a-z]+/g, '-')}__${b.r.weight}-${b.r.value}`;
        const src = join(root, b.r.records);
        if (existsSync(src)) cpSync(src, join(share, folder), { recursive: true });
        readme.push(`- **${folder}** — ${b.metric}: ${b.r.weight} ${b.r.defaultValue} → ${b.r.value}, ${b.detail}.`);
    }
    readme.push('', 'In each game, "A" is the changed AI and "B" the current one; seats alternate between games.');
    writeFileSync(join(share, 'README.md'), readme.join('\n') + '\n');
}

// =============================================================
// Main
// =============================================================

async function runComparison(s: Settings, root: string, c: Comparison, label: string): Promise<Result> {
    const dir = join(root, 'comparisons', c.id);
    // A half-finished comparison can't be resumed cleanly (shards append), so start it over.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'records'), { recursive: true });

    const started = Date.now();
    let done = 0;
    const tick = () => {
        done++;
        const mins = (Date.now() - started) / 60000;
        process.stdout.write(`\r${label}  game ${done}/${s.games}  (${mins.toFixed(0)} min)   `);
    };
    await Promise.all(Array.from({ length: s.shards }, (_, i) => runShard(s, c, dir, i, tick)));
    process.stdout.write('\n');

    const m = measure(rowsIn(dir));
    return {
        id: c.id, phase: c.phase, weight: c.dial.name, kind: c.dial.kind, why: c.dial.why,
        defaultValue: c.defaultValue, value: c.value, factor: c.factor, seed: c.seed,
        ...m,
        minutes: Math.round((Date.now() - started) / 60000),
        records: join('comparisons', c.id, 'records'),
        finishedAt: new Date().toISOString(),
    };
}

async function main(): Promise<void> {
    const s = parseArgs(process.argv.slice(2));
    const root = resolve('runs', 'tune', s.name);
    mkdirSync(root, { recursive: true });

    const { plan, skipped } = buildPlan(s);
    const estMinutes = (s.games / s.shards) * (190 * s.timeMs / 1000) / 60;
    console.log(`Tuning run "${s.name}" -> ${root}`);
    console.log(`${plan.length} screening comparisons (${plan.length / s.factors.length} weights x ${s.factors.length} values), ` +
        `${s.games} games each, ${s.shards} in parallel.`);
    console.log(`Estimate: ~${Math.round(estMinutes)} min per comparison, ~${(plan.length * estMinutes / 60).toFixed(1)} h for screening` +
        (s.confirm ? ', plus confirmation of any clear winners.' : '.'));
    if (skipped.length) console.log(`Skipped: ${skipped.join(', ')}`);

    if (s.dryRun) {
        for (const c of plan) console.log(`  ${c.id}: ${c.dial.name} ${c.defaultValue} -> ${c.value}`);
        return;
    }

    // Resume: keep results for comparisons that finished with every game.
    const saved = existsSync(join(root, 'results.json'))
        ? (JSON.parse(readFileSync(join(root, 'results.json'), 'utf8')).results as Result[])
        : [];
    const results = saved.filter((r) => r.games === s.games);

    for (let k = 0; k < plan.length; k++) {
        const c = plan[k];
        if (results.some((r) => r.id === c.id && r.phase === 'screen')) continue;
        const label = `[${k + 1}/${plan.length}] ${c.dial.name} ${c.defaultValue} -> ${c.value}`;
        let r: Result;
        try {
            r = await runComparison(s, root, c, label);
        } catch (err) {
            // Don't lose the night to one failure: note it and move on. It isn't
            // saved as done, so re-running the command will retry it.
            console.log(`\n   FAILED: ${err instanceof Error ? err.message : err}`);
            appendFileSync(join(root, 'errors.log'), `${new Date().toISOString()} ${c.id}: ${err}\n`);
            continue;
        }
        results.push(r);
        console.log(`   ${r.verdict.padEnd(20)} wins ${r.aWins}-${r.bWins}, score ${r.score.toFixed(2)}, ` +
            `completed ${pct(r.completionRate)}, ${Math.round(r.avgLength)} moves`);
        writeReports(root, s, results, plan.length, skipped);
    }

    if (s.confirm) {
        const winners = results.filter((r) => r.phase === 'screen' && r.verdict === 'BETTER');
        for (const w of winners) {
            const dial = PRIORITY.find((d) => d.name === w.weight)!;
            const c: Comparison = {
                id: `${w.id}-confirm`, phase: 'confirm', dial,
                defaultValue: w.defaultValue, value: w.value, factor: w.factor,
                seed: s.seed + 1000, // fresh patterns
            };
            if (results.some((r) => r.id === c.id)) continue;
            let r: Result;
            try {
                r = await runComparison(s, root, c, `[confirm] ${dial.name} ${w.defaultValue} -> ${w.value}`);
            } catch (err) {
                console.log(`\n   FAILED: ${err instanceof Error ? err.message : err}`);
                appendFileSync(join(root, 'errors.log'), `${new Date().toISOString()} ${c.id}: ${err}\n`);
                continue;
            }
            results.push(r);
            console.log(`   confirm: ${r.verdict} (score ${r.score.toFixed(2)})`);
            writeReports(root, s, results, plan.length, skipped);
        }
    }

    writeReports(root, s, results, plan.length, skipped);
    console.log(`\nDone. Report: ${join(root, 'results.md')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    });
}
