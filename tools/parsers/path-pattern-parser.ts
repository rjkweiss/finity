/**
 * Finity — Path Pattern Parser (parser 1 of 2)
 *
 * Input: the scraped HTML data (one game id line, then one line of token
 * <div>s) recovered from BGA. Output: each game's 8-cone b/w sequence, the
 * `pathPattern` the engine's createGame expects.
 *
 * The tokens appear in the HTML in path-pattern order (per the file header).
 * pathWhiteSide -> 'w', pathBlackSide -> 'b'.
 *
 */

import type { ArrowColor } from '@finity/engine';

const GAME_ID_RE = /^\d{6,}$/;
const TOKEN_RE = /class="token path(White|Black)Side"/g;

/** Parse one HTML token line into its ordered cone sequence. */
export function parsePatternLine(html: string): ArrowColor[] {
    return [...html.matchAll(TOKEN_RE)].map(m => (m[1] === 'White' ? 'w' : 'b'));
}

/**
 * Parse the full dump into gameId -> 8-cone sequence.
 * Uses a Map so iteration order follows the file (plain objects reorder
 * integer-like keys numerically).
 */
export function parsePathPatterns(text: string): Map<string, ArrowColor[]> {
    const out = new Map<string, ArrowColor[]>();
    let gameId: string | null = null;

    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;

        if (GAME_ID_RE.test(line)) {
            gameId = line;
            continue;
        }
        if (gameId && line.includes('class="token path')) {
            out.set(gameId, parsePatternLine(line));
            gameId = null;
        }
    }
    return out;
}
