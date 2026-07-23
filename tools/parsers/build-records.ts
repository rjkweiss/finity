/**
 * Finity — Batch Record Builder / Join
 *
 * Joins a folder of BGA game logs to the scraped path-pattern file by game id
 * (log filename `<id>.txt` == the id before the HTML block in path_patterns).
 * For each game that has BOTH a log and a pattern, it builds a GameRecord,
 * validates the replay against the log's own orphan/winner annotations, and
 * (optionally) writes `<outDir>/<id>.json`.
 *
 * Usage:
 *   npx tsx tools/parsers/build-records.ts <logsDir> <patternsFile> [outDir]
 *
 * Programmatic: import { buildGameRecords } and use the returned summary.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGameLog } from './game-log-parser';
import { parsePathPatterns } from './path-pattern-parser';
import { toGameRecord } from './record-builder';
import { validateReplay } from './replay-validator';

export interface BuildSummary {
    matched: string[];                              // had both log + pattern
    validated: string[];                            // matched AND replay-validated
    invalid: { id: string; failures: string[] }[];  // matched but replay mismatched
    errored: {id: string; error: string }[]         // replay CRASHED (parser/engine threw)
    logOnly: string[];                              // log present, no scraped pattern
    patternOnly: string[];                          // pattern present, no log
}

export function buildGameRecords(
    logsDir: string,
    patternsFile: string,
    outDir?: string,
): BuildSummary {
    const patterns = parsePathPatterns(readFileSync(patternsFile, 'utf8'));
    const logFiles = readdirSync(logsDir).filter(
        f => f.endsWith('.txt') && f !== basename(patternsFile),
    );
    if (outDir && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const summary: BuildSummary = {
        matched: [], validated: [], invalid: [], errored: [], logOnly: [], patternOnly: [],
    };
    const logIds = new Set<string>();

    for (const file of logFiles) {
        const id = basename(file, '.txt');
        logIds.add(id);

        const pattern = patterns.get(id);
        if (!pattern) { summary.logOnly.push(id); continue; }

        const game = parseGameLog(readFileSync(join(logsDir, file), 'utf8'));
        summary.matched.push(id);

        try {
            const record = toGameRecord(game, pattern, { gameId: id });
            const report = validateReplay(game, pattern);
            if (report.ok) summary.validated.push(id);
            else summary.invalid.push({ id, failures: report.failures });
            if (outDir) writeFileSync(join(outDir, `${id}.json`), JSON.stringify(record, null, 2));
        } catch (err) {
            summary.errored.push({ id, error: err instanceof Error ? err.message: String(err) });
        }
    }

    for (const id of patterns.keys()) {
        if (!logIds.has(id)) summary.patternOnly.push(id);
    }
    return summary;
}

// --- CLI entry ---
// Run the CLI only when this file is the program entry point (rename-proof),
// not when it's imported as a library.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [, , logsDir, patternsFile, outDir] = process.argv;
    if (!logsDir || !patternsFile) {
        console.error('usage: build-records <logsDir> <patternsFile> [outDir]');
        process.exit(1);
    }
    const s = buildGameRecords(logsDir, patternsFile, outDir);
    console.log(JSON.stringify({
        matched: s.matched.length,
        validated: s.validated.length,
        invalid: s.invalid,
        logOnly: s.logOnly.length,
        patternOnly: s.patternOnly.length,
    }, null, 2));
}
