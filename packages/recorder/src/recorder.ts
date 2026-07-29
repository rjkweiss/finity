// The real GameRecorder behind the orchestrator's GameRecorderLike seam.
// Every game played through the orchestrator (human or AI) produces a `GameRecord`
// in the SAME format the BGA pipeline's record-builder emits, so live games and
// scraped games flow into one corpus. Like the orchestrator, this module depends
// only on the engine — no React, no DOM — so it runs identically in the browser,
// Web Workers, and a headless Node tournament runner.
//
// Lifecycle (driven by the orchestrator):
//   begin(initialState)   — construction and every reset(); starts a fresh record
//   recordMove(move, ...) — after each applied move
//   finalize(result)      — when the game ends
//   toRecord()            — snapshot at ANY point (result is null mid-game), so an
//                           in-progress game can be exported/inspected too.

import type {
    AgentInfo,
    FinityGameState,
    GameRecord,
    GameResult,
    MoveAction,
    PlayerColor,
    RecordedMove,
} from '@finity/engine';
import type { PlayerAgent } from '@finity/agents';

/** Structural twin of the client orchestrator's seat map (Partial: only seated
 *  colors are present). Declared here so the recorder never imports from client. */
export type SeatMap = Partial<Record<PlayerColor, PlayerAgent>>;

/** AgentInfo is the persisted subset of PlayerAgent (id/type/label/author). */
export function agentInfoFrom(agent: PlayerAgent): AgentInfo {
    return { id: agent.id, type: agent.type, label: agent.label, author: agent.author };
}

/** Derive the record's agent map from the orchestrator's AgentMap (seated colors only —
 *  same partial-fill convention as record-builder's BGA records). */
export function agentInfoMap(agents: SeatMap): Record<PlayerColor, AgentInfo> {
    const out = {} as Record<PlayerColor, AgentInfo>;
    for (const [color, agent] of Object.entries(agents)) {
        if (agent) out[color as PlayerColor] = agentInfoFrom(agent);
    }
    return out;
}

function newGameId(): string {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return c.randomUUID();
    return `game-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface GameRecorderOptions {
    /** Who is seated where — persisted verbatim into the record. */
    agents: Record<PlayerColor, AgentInfo>;
    /** Provide to pin the id (e.g. round-trip tests); otherwise a fresh id is
     *  generated on every begin(). */
    gameId?: string;
    /** Merged into record.metadata (alongside source: 'live'). */
    metadata?: Record<string, unknown>;
    now?: () => number; // injectable clock for deterministic tests
}

export class GameRecorder {
    private readonly agents: Record<PlayerColor, AgentInfo>;
    private readonly pinnedGameId?: string;
    private readonly metadata?: Record<string, unknown>;
    private readonly now: () => number;

    private gameId = '';
    private startedAt = 0;
    private initialState: FinityGameState | null = null;
    private moves: RecordedMove[] = [];
    private result: GameResult | null = null;

    constructor(opts: GameRecorderOptions) {
        this.agents = opts.agents;
        this.pinnedGameId = opts.gameId;
        this.metadata = opts.metadata;
        this.now = opts.now ?? (() => Date.now());
    }

    /** Start a fresh record from `initialState`. The orchestrator calls this on
     *  construction and on every reset(); the state is deep-cloned so later engine
     *  transitions can never reach back into the record. */
    begin(initialState: FinityGameState): void {
        this.gameId = this.pinnedGameId ?? newGameId();
        this.startedAt = this.now();
        this.initialState = structuredClone(initialState);
        this.moves = [];
        this.result = null;
    }

    /** Called by the orchestrator AFTER the move was applied (and after its
     *  repetition/max-move overrides), so `moves` is exactly the applied sequence.
     *  moveIndex is derived from our own array — replay = fold(applyMove, moves). */
    recordMove(move: MoveAction, color: PlayerColor, _state: FinityGameState): void {
        if (!this.initialState) return; // begin() not called — nothing to attach to
        this.moves.push({
            move: structuredClone(move),
            color,
            timestamp: this.now(),
            moveIndex: this.moves.length,
        });
    }

    finalize(result: GameResult): void {
        this.result = result;
    }

    /** Snapshot the record. Safe to call mid-game (result is null until finalize).
     *  Returns null only before the first begin(). */
    toRecord(): GameRecord | null {
        if (!this.initialState) return null;
        return {
            version: 1,
            gameId: this.gameId,
            timestamp: this.startedAt,
            config: structuredClone(this.initialState.config),
            pathPattern: this.initialState.pathPattern.slice(),
            initialState: structuredClone(this.initialState),
            agents: this.agents,
            moves: this.moves.map((m) => structuredClone(m)),
            result: this.result,
            metadata: { source: 'live', ...(this.metadata ?? {}) },
        };
    }
}
