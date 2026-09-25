// Play / pause / step controls.
//
// Reproduces the "Play does nothing" hang: when a turn is already in flight —
// started by Step, typically a human turn waiting for a click — pressing Play
// used to throw "A turn is already in flight" silently. The play loop died,
// and when the human then moved, nothing picked up the next turn.
//
// These run against the REAL engine and agents. The AI side plays the first
// legal move, so the tests exercise the loop without depending on strategy.

import { describe, it, expect } from 'vitest';
import {
    legalMoves,
    type ArrowColor,
    type FinityGameState,
    type GameConfig,
    type MoveAction,
    type PlayerColor,
} from '@finity/engine';
import { LocalHumanAgent, type MoveContext, type PlayerAgent } from '@finity/agents';
import { GameOrchestrator, type PlayMode } from '../src/orchestrator';

const CONFIG: GameConfig = { playerColors: ['cyan', 'yellow'], boardSize: 2 };
const PATTERN: ArrowColor[] = ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'];

class FirstLegalAgent implements PlayerAgent {
    readonly type = 'ai-builtin' as const;
    readonly id = 'first-legal';
    readonly label = 'First Legal';
    readonly description = 'Plays legalMoves()[0]';
    readonly author = 'test';

    async move(color: PlayerColor, state: FinityGameState, _ctx: MoveContext): Promise<MoveAction> {
        return legalMoves(state, color)[0];
    }
}

/** Human (cyan, moves first) against the first-legal AI (yellow). */
function humanVsAi() {
    const human = new LocalHumanAgent();
    const orch = new GameOrchestrator({
        config: CONFIG,
        agents: { cyan: human, yellow: new FirstLegalAgent() },
        pathPattern: PATTERN,
    });

    return { orch, human };
}

/** The first legal move for whoever is on the clock. */
function anyLegal(orch: GameOrchestrator): MoveAction {
    return orch.legalMoves()[0];
}

/** Yield to the event loop until `pred` holds, failing after `ms`. */
async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 0));
    }
}

describe('play / pause / step controls', () => {
    it('Play after Step keeps the game going once the human moves', async () => {
        const { orch, human } = humanVsAi();

        // Step starts cyan's turn, which waits for a click.
        const stepping = orch.step();
        await waitFor(() => human.isAwaitingInput());

        // Play pressed while that turn is pending. Previously this threw
        // "A turn is already in flight" and the play loop died.
        const playing = orch.play();

        // The human clicks.
        expect(human.submitMove(anyLegal(orch))).toBe(true);
        await stepping;

        // The loop must pick up yellow's reply and come back to the human.
        await waitFor(() => orch.getState().moveHistory.length >= 2 && human.isAwaitingInput());
        expect(orch.getPlayMode()).toBe('playing');

        orch.dispose();
        await playing;
    });

    it('Step while a turn is already pending does nothing instead of throwing', async () => {
        const { orch, human } = humanVsAi();

        const first = orch.step();
        await waitFor(() => human.isAwaitingInput());

        // A second Step while cyan is still thinking.
        await orch.step();
        expect(orch.getState().moveHistory.length).toBe(0);

        human.submitMove(anyLegal(orch));
        await first;
        expect(orch.getState().moveHistory.length).toBe(1);

        orch.dispose();
    });

    it('Step while playing pauses after the current turn instead of throwing', async () => {
        const orch = new GameOrchestrator({
            config: CONFIG,
            agents: { cyan: new FirstLegalAgent(), yellow: new FirstLegalAgent() },
            pathPattern: PATTERN,
        });

        const playing = orch.play();
        await orch.step();
        await playing;

        expect(orch.getPlayMode()).toBe('paused');
        // Stopped early: nowhere near a finished game.
        expect(orch.getState().moveHistory.length).toBeLessThan(5);

        orch.dispose();
    });

    it('play and pause announce the mode so the buttons stay in sync', async () => {
        const { orch, human } = humanVsAi();
        const modes: PlayMode[] = [];
        orch.on('mode', (m) => modes.push(m));

        const playing = orch.play();
        await waitFor(() => human.isAwaitingInput());
        orch.pause();

        expect(modes).toEqual(['playing', 'paused']);

        orch.dispose();
        await playing;
    });

    it('Reset during a pending stepped turn, then Play, starts the new game', async () => {
        const { orch, human } = humanVsAi();

        const stepping = orch.step();
        await waitFor(() => human.isAwaitingInput());

        orch.reset();
        await stepping; // the aborted turn unwinds without advancing

        const playing = orch.play();
        await waitFor(() => human.isAwaitingInput());
        human.submitMove(anyLegal(orch));
        await waitFor(() => orch.getState().moveHistory.length >= 2 && human.isAwaitingInput());

        orch.dispose();
        await playing;
    });

    it('Play still starts a fresh game normally', async () => {
        const { orch, human } = humanVsAi();

        const playing = orch.play();
        await waitFor(() => human.isAwaitingInput());
        human.submitMove(anyLegal(orch));

        await waitFor(() => orch.getState().moveHistory.length >= 2 && human.isAwaitingInput());

        orch.dispose();
        await playing;
    });
});
