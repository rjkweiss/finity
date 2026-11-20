import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyMove, createGame } from '../src/engine';
import { hasFullPath } from '../src/path-analyzer';
import { raceDistance, routeSummary } from '../src/race';
import type { FinityGameState, GameConfig } from '../src/types';

// The 17 BGA game records (GameRecord JSON) used for the strategy work.
const FIXTURES = fileURLToPath(new URL('../../../tools/validate/fixtures', import.meta.url));
const haveFixtures = existsSync(FIXTURES);
const CONFIG = { playerColors: ['cyan', 'yellow'], boardSize: 2 } as GameConfig;

function replay(gameId: string): FinityGameState[] {
    const rec = JSON.parse(readFileSync(join(FIXTURES, `${gameId}.json`), 'utf8'));
    let s = createGame(rec.config, rec.pathPattern);
    const out = [s];
    for (const mv of rec.moves) {
        s = applyMove(s, mv.move);
        out.push(s);
    }
    return out;
}

describe('race distance', () => {
    it('prices the opening position as a full build (8 bridges + rings)', () => {
        const s = createGame(CONFIG, ['w', 'w', 'b', 'b', 'b', 'w', 'b', 'w']);
        for (const c of ['cyan', 'yellow'] as const) {
            const r = routeSummary(s, c);
            expect(r.fromBase).toBe(13);
            expect(r.distance).toBe(13);
            expect(r.relocateTo).toBeNull();
            expect(r.bestCount).toBeGreaterThan(1);
        }
    });

    it.skipIf(!haveFixtures)('is 0 exactly when hasFullPath holds, on every corpus position', () => {
        let positions = 0;
        for (const f of readdirSync(FIXTURES).filter((x) => x.endsWith('.json'))) {
            for (const s of replay(f.replace('.json', ''))) {
                for (const c of ['cyan', 'yellow'] as const) {
                    positions++;
                    expect(routeSummary(s, c, 0, false).fromBase === 0).toBe(hasFullPath(s, c));
                }
            }
        }
        expect(positions).toBeGreaterThan(1500);
    });

    it.skipIf(!haveFixtures)('counts one ring per visit (layered planner reported 0 here)', () => {
        // 181021113 after move 24: cyan's route revisits NW twice with one ring there
        const s = replay('181021113')[25];
        expect(hasFullPath(s, 'cyan')).toBe(false);
        expect(routeSummary(s, 'cyan').fromBase).toBe(1);
    });

    it.skipIf(!haveFixtures)('sees a win by base relocation that the board distance hides', () => {
        // 189707486 before move 37: yellow is 4 from its base, 1 via base -> S
        const s = replay('189707486')[37];
        const r = routeSummary(s, 'yellow');
        expect(r.fromBase).toBe(4);
        expect(r.distance).toBe(1);
        expect(r.relocateTo).toBe('S');
        expect(raceDistance(s, 'yellow')).toBe(1);
    });
});
