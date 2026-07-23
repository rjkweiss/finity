// Regression harness: replays all matched BGA games through the engine and asserts
// the four cross-validated fixtures stay clean. Skips (rather than fails) when the
// data files aren't present, so CI without the scraped data still passes.

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameRecords } from './build-records';

// ---- adjust to your data locations ----
const LOGS_DIR = fileURLToPath(new URL('../../data/logs', import.meta.url));
const PATTERNS_FILE = fileURLToPath(new URL('../../data/path_patterns.txt', import.meta.url));
// ----------------------------------------

const CROSS_VALIDATED = ['309267648', '321734839', '358437863', '359771409'];

const dataPresent = existsSync(LOGS_DIR) && existsSync(PATTERNS_FILE);

describe.skipIf(!dataPresent)('replay validation against real BGA games', () => {
    const summary = buildGameRecords(LOGS_DIR, PATTERNS_FILE);

    it('replays the four cross-validated games clean', () => {
        for (const id of CROSS_VALIDATED) {
            const failure = summary.invalid.find((g) => g.id === id);
            expect(failure, failure ? failure.failures.join('\n') : undefined).toBeUndefined();
            expect(summary.validated).toContain(id);
        }
    });

    it('reports no invalid replays among matched games', () => {
        // If the draw rule (DRAW_ROUND_LIMIT) ever truncates a real game mid-replay,
        // it shows up here with per-move detail — data for Tony, not silence.
        expect(summary.invalid, JSON.stringify(summary.invalid, null, 2)).toEqual([]);
    });
});
