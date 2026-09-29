/**
 * Finity Game Engine — Path Pattern
 *
 * The path pattern is 8 cones drawn without replacement from a pool of six
 * black and six white. It lives in the engine so the browser, the self-play
 * runner, and anything else that starts a game all draw it the same way.
 *
 * Drawing without replacement matters: independent coin flips would allow
 * patterns such as eight black, which a real draw can never produce, and
 * would shift the whole distribution. Every legal pattern has between two and
 * six cones of each colour.
 */

import type { ArrowColor } from './types';

/** Cones in the bag: six of each colour. */
export const PATTERN_POOL: readonly ArrowColor[] = ['b', 'b', 'b', 'b', 'b', 'b', 'w', 'w', 'w', 'w', 'w', 'w'];

/** Cones drawn for a path. */
export const PATTERN_LENGTH = 8;

/**
 * Draw a path pattern. `rng` returns values in [0, 1); pass a seeded one for
 * reproducible games, or omit it for Math.random.
 */
export function generatePathPattern(rng: () => number = Math.random): ArrowColor[] {
    const pool = [...PATTERN_POOL];
    const out: ArrowColor[] = [];
    for (let i = 0; i < PATTERN_LENGTH; i++) {
        const j = Math.floor(rng() * pool.length);
        out.push(pool.splice(j, 1)[0]);
    }

    return out;
}
