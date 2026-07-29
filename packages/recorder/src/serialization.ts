// GameRecord <-> JSON (DOM-free: usable from Node, tests, tournament
// runner). The browser download helper lives in the client (recordExport.ts).
// Records are plain JSON end to end (the engine state holds no Maps/Sets/bigints —
// zobristHash is a hex string), so JSON.parse(JSON.stringify(record)) is lossless.

import type { GameRecord } from '@finity/engine';

export function recordToJson(record: GameRecord): string {
    return JSON.stringify(record, null, 2);
}

export function recordFileName(record: GameRecord): string {
    const d = new Date(record.timestamp);
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    return `finity-${stamp}-${record.gameId.slice(0, 8)}.json`;
}

/** Parse + structurally validate an imported record. Throws Error with a
 *  human-readable message on anything that would break replay. */
export function parseGameRecord(text: string): GameRecord {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new Error('Not valid JSON');
    }
    if (typeof raw !== 'object' || raw === null) throw new Error('Not a JSON object');
    const r = raw as Record<string, unknown>;

    if (r.version !== 1) throw new Error(`Unsupported record version: ${String(r.version)}`);
    if (typeof r.gameId !== 'string' || r.gameId.length === 0) throw new Error('Missing gameId');
    if (typeof r.timestamp !== 'number') throw new Error('Missing timestamp');
    if (!Array.isArray(r.pathPattern) || r.pathPattern.length === 0) throw new Error('Missing pathPattern');

    const init = r.initialState as Record<string, unknown> | undefined;
    if (!init || typeof init !== 'object') throw new Error('Missing initialState');
    if (typeof init.zobristHash !== 'string') throw new Error('initialState missing zobristHash');
    if (!init.board || typeof init.board !== 'object') throw new Error('initialState missing board');

    if (!Array.isArray(r.moves)) throw new Error('Missing moves array');
    for (let i = 0; i < r.moves.length; i++) {
        const m = r.moves[i] as Record<string, unknown>;
        if (!m || typeof m !== 'object' || !m.move || typeof m.color !== 'string') {
            throw new Error(`Malformed move at index ${i}`);
        }
    }

    if (!r.agents || typeof r.agents !== 'object') throw new Error('Missing agents map');
    if (!r.config || typeof r.config !== 'object') throw new Error('Missing config');

    return raw as GameRecord;
}
