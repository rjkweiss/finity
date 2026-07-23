// packages/client/src/orchestrator.ts
//
// STEP 3 — The turn loop. Replaces the old GameManager. It is the single source of
// truth for game state, and it depends ONLY on the engine + agent interface — no
// React, no p5, no pixels. That is what lets step 4 prove it headlessly.
//
// LOCATION NOTE: the design doc puts this at packages/client/src/orchestrator.ts.
// It imports nothing from React/p5, so it could be promoted to its own package later.

import {
    applyMove,
    createGame,
    currentPlayer,
    isGameOver,
    possibleMoves,
    type ArrowColor,
    type FinityGameState,
    type GameConfig,
    type GameResult,
    type MoveAction,
    type PlayerColor,
    type RecordedMove,
} from '@finity/engine';
import {
    IllegalMoveError,
    MoveAbortedError,
    MoveTimeoutError,
    type AbortReason,
    type AgentType,
    type PlayerAgent,
} from '@finity/agents';

/** Phase 3 will provide the real recorder; the orchestrator only needs this slice. */
export interface GameRecorderLike {
    recordMove(move: MoveAction, color: PlayerColor, state: FinityGameState): void;
    finalize(result: GameResult): void;
}

export type PlayMode = 'paused' | 'playing';

/** PlayerColor is a strict 4-member union, so the agent map is partial — a 2-player
 *  game only fills cyan/yellow. */
export type AgentMap = Partial<Record<PlayerColor, PlayerAgent>>;

export interface OrchestratorEvents {
    state: (state: FinityGameState) => void;
    'turn:start': (info: { color: PlayerColor; moveIndex: number }) => void;
    'turn:end': (info: { color: PlayerColor; moveIndex: number; move: MoveAction }) => void;
    'game:over': (result: GameResult) => void;
    error: (error: Error) => void;
}

export interface OrchestratorOptions {
    config: GameConfig;
    agents: AgentMap;
    /** The 8-cone b/w sequence. REQUIRED unless `initialState` is supplied — the engine
     *  does NOT generate it (createGame takes it as an argument). */
    pathPattern?: ArrowColor[];
    recorder?: GameRecorderLike;
    /** Per-agent-type move budget in ms. `null` = no limit (the default for humans). */
    timeouts?: Partial<Record<AgentType, number | null>>;
    /** Replay/restore: start from this exact state instead of createGame(). This is how
     *  step 4 injects a known path pattern. */
    initialState?: FinityGameState;
    /** Phase 6: when true, every move is checked for membership in possibleMoves() before
     *  applying (defends against untrusted agents). The engine has no standalone
     *  validateMove(), and possibleMoves IS the legality oracle, so this is the check.
     *  Default false: Phase 2 sources (human picks, scripted replays) are already legal. */
    validateMoves?: boolean;
    /**
     * Pause between auto-played (play() loop only; step() is never delayed).
     *  Makes AI-vs-AI games watchable move by move. Default 0 (no pacing).
     */
    turnDelayMs?: number;
    /**
     * End game as a draw when the same position (state.zobristHash) recurs this many
     * times. CONFIRM W/ TONY
     */
    repetitionLimit?: number | null;
    /**
     * Absolute safety net: force a draw at this many total moves - default 1000
     */
    maxMoves?: number | null;
    now?: () => number; // injectable clock for deterministic tests
}

const DEFAULT_TIMEOUTS: Record<AgentType, number | null> = {
    'human-local': null,
    'human-remote': null,
    scripted: null,
    'ai-builtin': 30_000,
    'ai-custom': 10_000,
    'ai-ml': 15_000,
};

export class GameOrchestrator {
    private state: FinityGameState;
    private readonly agents: AgentMap;
    private readonly recorder?: GameRecorderLike;
    private readonly timeouts: Record<AgentType, number | null>;
    private readonly now: () => number;
    private readonly initialState: FinityGameState;
    private readonly validateMoves: boolean;
    private readonly turnDelayMs: number;
    private readonly repetitionLimit: number | null;
    private readonly maxMoves: number | null;
    private readonly positionCounts = new Map<string, number>();

    private playMode: PlayMode = 'paused';
    private turnInFlight = false;
    private running = false;
    private currentAbort: AbortController | null = null;
    private startedAt: number;
    private result: GameResult | null = null;

    private listeners: { [K in keyof OrchestratorEvents]: Set<OrchestratorEvents[K]> } = {
        state: new Set(),
        'turn:start': new Set(),
        'turn:end': new Set(),
        'game:over': new Set(),
        error: new Set(),
    };

    constructor(opts: OrchestratorOptions) {
        this.now = opts.now ?? (() => Date.now());
        if (opts.initialState) {
            this.initialState = opts.initialState;
        } else if (opts.pathPattern) {
            this.initialState = createGame(opts.config, opts.pathPattern);
        } else {
            throw new Error('GameOrchestrator needs either `initialState` or `pathPattern` (the engine does not generate the cone pattern).');
        }
        this.state = this.initialState;
        this.agents = opts.agents;
        this.recorder = opts.recorder;
        this.timeouts = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts ?? {}) };
        this.validateMoves = opts.validateMoves ?? false;
        this.turnDelayMs = Math.max(0, opts.turnDelayMs ?? 0);
        this.repetitionLimit = opts.repetitionLimit === undefined ? 3 : opts.repetitionLimit;
        this.maxMoves = opts.maxMoves === undefined ? 1000 : opts.maxMoves;
        this.startedAt = this.now();
        for (const agent of this.allAgents()) agent.onGameStart?.(opts.config);
    }

    // ---- read access (the hook's snapshot source) -----------------------------

    getState(): FinityGameState {
        return this.state;
    }
    getResult(): GameResult | null {
        return this.result;
    }
    getPlayMode(): PlayMode {
        return this.playMode;
    }
    currentColor(): PlayerColor {
        return currentPlayer(this.state);
    }
    legalMoves(): MoveAction[] {
        return possibleMoves(this.state, this.currentColor());
    }
    agentFor(color: PlayerColor): PlayerAgent | undefined {
        return this.agents[color];
    }
    isOver(): boolean {
        return this.state.playStatus === 'over' || isGameOver(this.state);
    }

    // ---- subscriptions ---------------------------------------------------------

    subscribe(onState: OrchestratorEvents['state']): () => void {
        return this.on('state', onState);
    }

    on<K extends keyof OrchestratorEvents>(event: K, handler: OrchestratorEvents[K]): () => void {
        this.listeners[event].add(handler);
        return () => this.listeners[event].delete(handler);
    }

    private emit<K extends keyof OrchestratorEvents>(
        event: K,
        ...args: Parameters<OrchestratorEvents[K]>
    ): void {
        for (const handler of this.listeners[event]) {
            (handler as (...a: unknown[]) => void)(...(args as unknown[]));
        }
    }

    // ---- control ---------------------------------------------------------------

    async play(): Promise<GameResult | null> {
        // set the mode first so play() acts as "resume" when a loop is already running
        this.playMode = 'playing';
        if (this.running) return this.result
        this.running = true;

        try {
            while (this.playMode === 'playing' && !this.isOver()) {
                await this.playTurn();
                await this.interTurnDelay();
            }
        } finally {
            this.running = false;
        }

        return this.result;
    }

    pause(): void {
        this.playMode = 'paused';
    }

    async step(): Promise<void> {
        if (this.running || this.turnInFlight) {
            throw new Error('Cannot step while a turn is in flight');
        }
        await this.playTurn();
    }

    abortCurrentTurn(reason: AbortReason): void {
        this.currentAbort?.abort(reason);
    }

    reset(toState?: FinityGameState): void {
        this.abortCurrentTurn({ kind: 'new-game' });
        this.playMode = 'paused';
        this.result = null;
        this.startedAt = this.now();
        this.state = toState ?? this.initialState;
        this.notifyState();
        this.positionCounts.clear();
    }

    dispose(): void {
        // stop the play() loop once the aborted turn unwinds
        this.playMode = 'paused';
        this.abortCurrentTurn({ kind: 'disposed' });
        for (const agent of this.allAgents()) agent.dispose?.();
        (Object.keys(this.listeners) as (keyof OrchestratorEvents)[]).forEach((k) =>
            this.listeners[k].clear(),
        );
    }

    // ---- the turn -------------------------------------------------------------

    private async playTurn(): Promise<void> {
        if (this.turnInFlight) throw new Error('A turn is already in flight');
        if (this.isOver()) return;

        this.turnInFlight = true;
        const color = this.currentColor();
        const agent = this.agents[color];
        if (!agent) {
            this.turnInFlight = false;
            throw new Error(`No agent registered for color "${color}"`);
        }
        const moveIndex = this.state.moveHistory.length;
        const ac = new AbortController();
        this.currentAbort = ac;
        this.emit('turn:start', { color, moveIndex });

        const budget = this.timeouts[agent.type];
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (budget != null) {
            timer = setTimeout(() => ac.abort({ kind: 'timeout' } as AbortReason), budget);
        }

        try {
            // Agents receive a clone — they cannot mutate the canonical state.
            const snapshot = structuredClone(this.state);

            let move: MoveAction;
            try {
                move = await this.callWithAbort(agent, color, snapshot, ac, moveIndex, budget);
            } catch (err) {
                if (err instanceof MoveTimeoutError) throw err;
                if (err instanceof MoveAbortedError) return; // cancelled externally — don't advance
                throw err;
            }

            // The engine has no standalone validateMove(); possibleMoves() is the legality
            // oracle. Only enforce membership when guarding untrusted agents (Phase 6).
            if (this.validateMoves && !this.isLegal(color, move)) {
                throw new IllegalMoveError(color, move, 'not in possibleMoves()');
            }

            this.state = applyMove(this.state, move);

            // Repetition tracking: ZobristHash is a full-fold of the hashes mean equal positions
            if (this.repetitionLimit != null && this.state.winners.length === 0) {
                const n = (this.positionCounts.get(this.state.zobristHash) ?? 0) + 1;
                this.positionCounts.set(this.state.zobristHash, n);
                if (n >= this.repetitionLimit) {
                    this.state = { ...this.state, playStatus: 'over' };
                }
            }

            // Absolute cap so no agent pairing can produce an unbounded game
            if (this.maxMoves != null && this.state.winners.length === 0
                && this.state.moveHistory.length >= this.maxMoves) {
                    this.state = { ...this.state, playStatus: 'over' };
            }

            this.recorder?.recordMove(move, color, this.state);
            this.broadcastOpponentMove(color, move, moveIndex);
            this.emit('turn:end', { color, moveIndex, move });
            this.notifyState();

            if (this.isOver()) this.finishGame();
        } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            this.playMode = 'paused';
            this.emit('error', e);
            throw e;
        } finally {
            if (timer) clearTimeout(timer);
            this.currentAbort = null;
            this.turnInFlight = false;
        }
    }

    private async interTurnDelay(): Promise<void> {
        if (this.turnDelayMs <= 0) return;
        if (this.playMode !== 'playing' || this.isOver()) return;
        if (this.agents[this.currentColor()]?.type === 'human-local') return;
        await new Promise((resolve) => setTimeout(resolve, this.turnDelayMs));
    }

    private abortedByTimeout(ac: AbortController): boolean {
        return ac.signal.aborted && (ac.signal.reason as AbortReason | undefined)?.kind === 'timeout';
    }

    /**
     * Awaits the agent's move, but a timeout or external abort rejects the await even
     * if the agent never honors its signal. A misbehaving agent's promise is then
     * orphaned (the real sandbox would terminate its worker); the orchestrator does
     * not hang.
     */
    private callWithAbort(
        agent: PlayerAgent,
        color: PlayerColor,
        snapshot: FinityGameState,
        ac: AbortController,
        moveIndex: number,
        budget: number | null,
    ): Promise<MoveAction> {
        return new Promise<MoveAction>((resolve, reject) => {
            const rejectForAbort = () =>
                reject(
                    this.abortedByTimeout(ac)
                        ? new MoveTimeoutError(budget ?? 0)
                        : new MoveAbortedError(ac.signal.reason as AbortReason | undefined),
                );
            if (ac.signal.aborted) {
                rejectForAbort();
                return;
            }
            const onAbort = () => rejectForAbort();
            ac.signal.addEventListener('abort', onAbort, { once: true });
            agent.move(color, snapshot, { signal: ac.signal, moveIndex }).then(
                (m) => {
                    ac.signal.removeEventListener('abort', onAbort);
                    resolve(m);
                },
                (e) => {
                    ac.signal.removeEventListener('abort', onAbort);
                    reject(e);
                },
            );
        });
    }

    private isLegal(color: PlayerColor, move: MoveAction): boolean {
        return possibleMoves(this.state, color).some((m) => sameMove(m, move));
    }

    private allAgents(): PlayerAgent[] {
        return Object.values(this.agents).filter((a): a is PlayerAgent => a != null);
    }

    private broadcastOpponentMove(color: PlayerColor, move: MoveAction, moveIndex: number): void {
        const recorded: RecordedMove = { move, color, timestamp: this.now(), moveIndex };
        for (const [c, agent] of Object.entries(this.agents)) {
            if (c !== color) agent?.onOpponentMove?.(recorded);
        }
    }

    private finishGame(): void {
        // The engine knows *that* the game is over; deriving *why* (path_complete vs
        // deadlock draw) ideally comes from the engine too. See PHASE2-NOTES "MISS #5".
        const reason: GameResult['reason'] =
            this.state.winners.length > 0 ? 'path_complete' : 'deadlock';
        this.result = {
            winners: this.state.winners,
            reason,
            finalState: this.state,
            totalMoves: this.state.moveHistory.length,
            durationMs: this.now() - this.startedAt,
        };
        this.playMode = 'paused';
        for (const agent of this.allAgents()) agent.onGameEnd?.(this.result);
        this.recorder?.finalize(this.result);
        this.emit('game:over', this.result);
    }

    private notifyState(): void {
        this.emit('state', this.state);
    }
}

/** Structural move equality — the engine moves are plain JSON, so compare the fields
 *  that define a move. Used only for the optional membership check. */
function sameMove(a: MoveAction, b: MoveAction): boolean {
    return (
        a.type === b.type &&
        a.station === b.station &&
        samePiece(a.pieceToAdd, b.pieceToAdd) &&
        samePiece(a.pieceToRemove, b.pieceToRemove)
    );
}

function samePiece(a: unknown, b: unknown): boolean {
    if (a == null || b == null) return a === b;
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of keys) if (x[k] !== y[k]) return false;
    return true;
}
