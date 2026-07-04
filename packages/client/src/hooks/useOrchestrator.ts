// packages/client/src/hooks/useOrchestrator.ts
//
// STEP 7 — React binding. The orchestrator remains the single source of truth; this
// hook only MIRRORS it. We use useSyncExternalStore so there is no tearing when an
// AI-vs-AI game updates many times per second. The hook also owns one MoveInputHandler
// instance, bound to whichever LocalHumanAgent is currently on the clock.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { FinityGameState, GameResult, MoveAction, PlayerColor } from '@finity/engine';
import { LocalHumanAgent, type AbortReason } from '@finity/agents';
import type { GameOrchestrator, PlayMode } from '../orchestrator';
import { MoveInputHandler } from '../rendering/moveInputHandler';

export interface UseOrchestrator {
    state: FinityGameState;
    currentColor: PlayerColor;
    isOver: boolean;
    result: GameResult | null;
    playMode: PlayMode;
    /** True while a LocalHumanAgent is parked waiting for this device's input. */
    isAwaitingHumanInput: boolean;
    /** Legal moves for the player on the clock (empty if game over). */
    legalMoves: MoveAction[];
    /** The bound input state machine (drives board affordances). */
    input: MoveInputHandler;
    controls: {
        play: () => void;
        pause: () => void;
        step: () => void;
        reset: () => void;
        resign: (color: PlayerColor) => void;
    };
}

export function useOrchestrator(orch: GameOrchestrator): UseOrchestrator {
    // A version counter bumped on every event that should re-render. getSnapshot returns
    // it (a primitive), so React's Object.is comparison reliably detects change — including
    // turn:start, which doesn't change the state object's identity.
    const versionRef = useRef(0);

    const subscribe = useCallback(
        (cb: () => void) => {
            const bump = () => {
                versionRef.current++;
                cb();
            };
            const unsubs = [
                orch.on('state', bump),
                orch.on('turn:start', bump),
                orch.on('turn:end', bump),
                orch.on('game:over', bump),
            ];
            return () => unsubs.forEach((u) => u());
        },
        [orch],
    );

    useSyncExternalStore(subscribe, () => versionRef.current);

    // Read everything fresh each render from the canonical source.
    const state = orch.getState();
    const currentColor = orch.currentColor();
    const isOver = orch.isOver();
    const result = orch.getResult();
    const playMode = orch.getPlayMode();

    const currentAgent = orch.agentFor(currentColor);
    const human = currentAgent instanceof LocalHumanAgent ? currentAgent : null;
    const isAwaitingHumanInput = human?.isAwaitingInput() ?? false;
    const legalMoves = !isOver && human ? orch.legalMoves() : [];

    // One input handler for the hook's lifetime; submit routes to whoever is on the clock.
    const input = useMemo(
        () =>
            new MoveInputHandler({
                submit: (move: MoveAction) => {
                    const c = orch.currentColor();
                    const a = orch.agentFor(c);
                    return a instanceof LocalHumanAgent ? a.submitMove(move) : false;
                },
            }),
        [orch],
    );

    // Refresh the input handler when it becomes (or stops being) a human's turn.
    useEffect(() => {
        if (isAwaitingHumanInput) input.refresh(state, currentColor);
        else input.clear();
        // state identity changes per applied move, so the handler always sees fresh legal moves.
    }, [input, isAwaitingHumanInput, state, currentColor]);

    const controls = useMemo(
        () => ({
            play: () => void orch.play(),
            pause: () => orch.pause(),
            step: () => void orch.step(),
            reset: () => orch.reset(),
            resign: (color: PlayerColor) => orch.abortCurrentTurn({ kind: 'resign', color } as AbortReason),
        }),
        [orch],
    );

    return {
        state,
        currentColor,
        isOver,
        result,
        playMode,
        isAwaitingHumanInput,
        legalMoves,
        input,
        controls,
    };
}
