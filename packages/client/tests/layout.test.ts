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
import { computeLayout } from '../src/rendering/layout';

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
        expect(computeLayout(3).stationPositions['E']).toBeDefined();
        expect(computeLayout(3).stationPositions['W']).toBeUndefined();
        for (const f of ['FNW', 'FNE', 'FSE', 'FSW'] as const) {
            expect(computeLayout(4).stationPositions[f], f).toBeDefined();
        }
    });

    it('2-player board is pixel-identical to the original constants (the reference framing)', () => {
        // Original hardcoded geometry: cx=400, cy=325, near=145, far=290, vsm=83.
        const l = computeLayout(2);
        expect(l.scale).toBe(1);
        expect(l.stationPositions['C']).toEqual([400, 325]);
        expect(l.stationPositions['N']).toEqual([400, 325 - 166]);
        expect(l.stationPositions['S']).toEqual([400, 325 + 166]);
        expect(l.stationPositions['W']).toEqual([400 - 290, 325]);
        expect(l.stationPositions['E']).toEqual([400 + 290, 325]);
        expect(l.stationPositions['NW']).toEqual([400 - 145, 325 - 83]);
        expect(l.stationSize).toEqual([200, 200]);
    });

    it('3p/4p boards shrink to fit: nothing clipped, clear of the indicator column', () => {
        for (const n of [3, 4] as const) {
            const l = computeLayout(n);
            expect(l.scale).toBeLessThan(1);
            expect(l.scale).toBeGreaterThan(0.8); // sanity: mild shrink, not a postage stamp
            const half = l.stationSize[0] / 2;
            for (const [name, pos] of Object.entries(l.stationPositions)) {
                const [x, y] = pos as [number, number];
                expect(x - half, `${n}p ${name} left`).toBeGreaterThan(0);
                expect(x + half, `${n}p ${name} right (indicator column starts ~800)`).toBeLessThan(800);
                expect(y - half, `${n}p ${name} top`).toBeGreaterThan(0);
                expect(y + half, `${n}p ${name} bottom`).toBeLessThan(l.canvasHeight);
            }
        }
    });

    it('boards are centered in the drawable region (2p framing carried over)', () => {
        // Drawable region is x in [10, 790], y in [10, 640] -> center (400, 325).
        for (const n of [2, 3, 4] as const) {
            const l = computeLayout(n);
            const xs = Object.values(l.stationPositions).map((p) => (p as [number, number])[0]);
            const ys = Object.values(l.stationPositions).map((p) => (p as [number, number])[1]);
            const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
            const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
            expect(Math.abs(cx - 400), `${n}p horizontal center`).toBeLessThan(1e-6);
            expect(Math.abs(cy - 325), `${n}p vertical center`).toBeLessThan(1e-6);
        }
    });

    it('scaled geometry stays proportional (slot midpoints between scaled stations)', () => {
        const l = computeLayout(4);
        // For any two adjacent stations, their connecting slots' midpoints must sit
        // at the segment midpoint offset by the channel distance — spot-check C<->N
        // via the geometric midpoint falling between the two scaled centers.
        const c = l.stationPositions['C'] as [number, number];
        const nPos = l.stationPositions['N'] as [number, number];
        const midY = (c[1] + nPos[1]) / 2;
        const mids = l.slotLayouts
            .filter((sl) => sl.midpoint && Math.abs(sl.midpoint[0] - 400) < l.scale * 40)
            .map((sl) => sl.midpoint![1]);
        expect(mids.some((y) => Math.abs(y - midY) < 1)).toBe(true);
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
