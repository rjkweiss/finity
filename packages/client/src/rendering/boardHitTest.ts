// packages/client/src/rendering/boardHitTest.ts
//
// Pixel -> BoardTarget resolution against the same geometry the renderer uses
// (computeLayout in layout.ts). Rather than a pure geometric "what's under the
// cursor", we snap a click to the nearest CURRENTLY-SELECTABLE target. That does two
// things at once: it lets the player click near a highlighted target, and it sidesteps
// the tight L/C/R slot spacing (only legal channels are candidates), which would
// otherwise be near-impossible to click precisely.

import type { BoardTarget } from './moveInputHandler';
import type { LayoutData } from './layout';

/** Pixel position of a board target: station center, or slot midpoint. */
export function targetPixel(target: BoardTarget, layout: LayoutData): [number, number] | null {
    if (target.kind === 'station') {
        return layout.stationPositions[target.station] ?? null;
    }
    return layout.slotLayouts[target.slotId]?.midpoint ?? null;
}

/**
 * Nearest target to (x, y) among `candidates`, within `maxDist` pixels — or null.
 * Pass the currently-selectable targets so clicks snap to legal choices.
 */
export function nearestTarget(
    x: number,
    y: number,
    candidates: readonly BoardTarget[],
    layout: LayoutData,
    maxDist: number,
): BoardTarget | null {
    let best: BoardTarget | null = null;
    let bestD2 = maxDist * maxDist;
    for (const t of candidates) {
        const p = targetPixel(t, layout);
        if (!p) continue;
        const dx = p[0] - x;
        const dy = p[1] - y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestD2) {
            bestD2 = d2;
            best = t;
        }
    }
    return best;
}
