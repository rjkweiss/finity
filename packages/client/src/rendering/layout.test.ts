// Regression tests for the missing-stations bug (3p board rendered without FNW/FSW,
// 4p board rendered without all four far corners). Root cause: FinityCanvas captured
// a layout in p5 setup() (which runs once) and kept drawing with it after the player
// count changed; DisplayHandler silently skips any station the layout has no position
// for. The fix threads PlayView's reactive layout into FinityCanvas as a prop.
//
// These tests pin the two halves of the contract:
//   1. Completeness — for each board size, computeLayout(n) has a position for EVERY
//      station createGame(n) puts in the state (nothing can be silently skipped when
//      state and layout agree on board size).
//   2. The mismatch is real — a 3p/4p state paired with a 2p layout IS missing the
//      far stations, which is exactly the on-screen symptom. If this ever stops
//      failing-by-design, the skip-guard in DisplayHandler changed and the canvas
//      wiring should be re-audited.

import { describe, it, expect } from 'vitest';
import {
    createGame,
    STATIONS_BY_PLAYER_COUNT,
    type ArrowColor,
    type GameConfig,
    type PlayerColor,
    type StationName,
} from '@finity/engine';
import { computeLayout } from './layout';

const PATTERN: ArrowColor[] = ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'];
const COLORS: PlayerColor[] = ['cyan', 'yellow', 'red', 'purple'];

function stateFor(n: 2 | 3 | 4) {
    const config: GameConfig = { playerColors: COLORS.slice(0, n), boardSize: n };
    return createGame(config, PATTERN);
}

describe('computeLayout — station completeness per board size', () => {
    for (const n of [2, 3, 4] as const) {
        it(`${n}-player: every station in the game state has a layout position`, () => {
            const state = stateFor(n);
            const layout = computeLayout(n);
            const missing = Object.keys(state.board.stations).filter(
                (name) => !layout.stationPositions[name as StationName],
            );
            expect(missing).toEqual([]);
            expect(Object.keys(state.board.stations).sort()).toEqual(
                [...STATIONS_BY_PLAYER_COUNT[n]].sort(),
            );
        });

        it(`${n}-player: all station positions are inside the canvas`, () => {
            const layout = computeLayout(n);
            for (const [name, pos] of Object.entries(layout.stationPositions)) {
                expect(pos, `station ${name}`).toBeDefined();
                const [x, y] = pos as [number, number];
                expect(x).toBeGreaterThan(0);
                expect(x).toBeLessThan(layout.canvasWidth);
                expect(y).toBeGreaterThan(0);
                expect(y).toBeLessThan(layout.canvasHeight);
            }
        });
    }

    it('far stations exist exactly where expected per board size', () => {
        expect(computeLayout(2).stationPositions['FNW']).toBeUndefined();
        expect(computeLayout(3).stationPositions['FNW']).toBeDefined();
        expect(computeLayout(3).stationPositions['FSW']).toBeDefined();
        expect(computeLayout(3).stationPositions['E']).toBeUndefined();
        for (const f of ['FNW', 'FNE', 'FSE', 'FSW'] as const) {
            expect(computeLayout(4).stationPositions[f], f).toBeDefined();
        }
    });

    it('documents the bug: a 3p/4p state paired with a STALE 2p layout drops stations', () => {
        const stale2pLayout = computeLayout(2);

        const missing3p = Object.keys(stateFor(3).board.stations).filter(
            (name) => !stale2pLayout.stationPositions[name as StationName],
        );
        expect(missing3p.sort()).toEqual(['FNW', 'FSW']); // what screenshot 2 showed missing

        const missing4p = Object.keys(stateFor(4).board.stations).filter(
            (name) => !stale2pLayout.stationPositions[name as StationName],
        );
        expect(missing4p.sort()).toEqual(['FNE', 'FNW', 'FSE', 'FSW']); // screenshot 3
    });
});
