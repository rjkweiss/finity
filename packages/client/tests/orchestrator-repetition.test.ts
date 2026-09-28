// The orchestrator reports an engine-voided game as reason 'repetition'.
// Cycle: cyan places, yellow places, cyan removes, yellow removes — twice
// returns to the start position for the third time and voids the game.

import { describe, it, expect } from 'vitest';
import {
    applyMove,
    basePostStation,
    createGame,
    legalMoves,
    type ArrowColor,
    type FinityGameState,
    type GameConfig,
    type MoveAction,
    type PlayerColor,
} from '@finity/engine';
import { ScriptedAgent } from '@finity/agents';
import { GameOrchestrator } from '../src/orchestrator';

const PATTERN: ArrowColor[] = ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'];
const CONFIG: GameConfig = { playerColors: ['cyan', 'yellow'], boardSize: 2 };

// A player may remove an arrow pointing INTO a station whose high point they
// hold, so each side places its arrow into its own base-post station.
const firstPlacement = (s: FinityGameState, c: PlayerColor): MoveAction => {
    const home = basePostStation(s, c);
    const m = legalMoves(s, c).find(
        (x) => x.type === 'place' && x.pieceToAdd?.type === 'arrow' && x.pieceToAdd.toStation === home
    );
    if (!m) throw new Error(`no arrow placement into ${home} for ${c}`);
    return m;
};

const removalOf = (s: FinityGameState, c: PlayerColor, slotId: number): MoveAction => {
    const m = legalMoves(s, c).find((x) => x.type === 'remove' && x.pieceToRemove?.slotId === slotId);
    if (!m) throw new Error(`${c} cannot remove the arrow in slot ${slotId}`);
    return m;
};

/** One cycle: cyan places, yellow places, cyan removes, yellow removes. */
function cycleMoves(start: FinityGameState): MoveAction[] {
    const a = firstPlacement(start, 'cyan');
    const s1 = applyMove(start, a);
    const b = firstPlacement(s1, 'yellow');
    const s2 = applyMove(s1, b);
    const ra = removalOf(s2, 'cyan', (a.pieceToAdd as { slotId: number }).slotId);
    const rb = removalOf(applyMove(s2, ra), 'yellow', (b.pieceToAdd as { slotId: number }).slotId);

    return [a, b, ra, rb];
}

describe('repetition through the orchestrator', () => {
    it('ends the game with reason "repetition" and no winner', async () => {
        const [placeA, placeB, removeA, removeB] = cycleMoves(createGame(CONFIG, PATTERN));

        const orch = new GameOrchestrator({
            config: CONFIG,
            pathPattern: PATTERN,
            agents: {
                cyan: new ScriptedAgent([placeA, removeA, placeA, removeA]),
                yellow: new ScriptedAgent([placeB, removeB, placeB, removeB]),
            },
            validateMoves: true,
        });

        const result = await orch.play();
        expect(result?.reason).toBe('repetition');
        expect(result?.winners).toEqual([]);
        expect(result?.totalMoves).toBe(8);
    });
});
