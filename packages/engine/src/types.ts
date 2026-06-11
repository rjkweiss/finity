/**
 * Finity Game Engine — Type Definitions
 *
 * All types are plain JSON-serializable objects.
 * No classes, no prototypes, no circular references.
 * This enables: structuredClone for AI search, JSON.stringify for
 * game records/network, and cross-realm transfer via postMessage.
 *
*/

// =============================================================
// Game Configuration
// =============================================================

export interface GameConfig {
    playerColors: PlayerColor[];
    boardSize: 2 | 3 | 4;
    randomSeed?: string;
}

export type PlayerColor = 'cyan' | 'yellow' | 'red' | 'purple';

// =============================================================
// Station Naming — Three Systems
// =============================================================

/** Compass-based station names (human-facing primary) */
export type StationName =
    | 'C'                                    // Center
    | 'N' | 'NE' | 'SE' | 'S' | 'SW' | 'NW'  // Inner ring
    | 'W' | 'E'                              // 2-player outer
    | 'FNW' | 'FNE' | 'FSE' | 'FSW';         // 4-player outer

/** Numeric ring-ordered station IDs (0 = center, 1-6 inner CW, 7-12 outer CW) */
export type StationNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/** Internal axial coordinate keys (used for topology math) */
export type StationCoord = string; // e.g. "0,0", "-1,1", "1,0"

/** Slot channel position within a station pair */
export type Channel = 'L' | 'C' | 'R';

// =============================================================
// Board State
// =============================================================

export interface FinityGameState {
    version: 1;
    gsId: string;
    config: GameConfig;
    board: BoardState;
    turnIndex: number;
    playStatus: 'setup' | 'playing' | 'over';
    moveHistory: RecordedMove[];
    winners: PlayerColor[];
    pathPattern: ArrowColor[];           // The 8-cone sequence
    turnsSinceRingChange: number;        // For deadlock detection
    zobristHash: string;
}

export interface BoardState {
    stations: Record<StationName, StationState>;
    slots: SlotState[];                  // Indexed 0-71
}

export interface StationState {
    id: StationName;
    coord: StationCoord;
    rings: [RingState | null, RingState | null, RingState | null];  // [small, medium, large]
    basePost: PlayerColor | null;
}

export interface SlotState {
    id: number;                          // 0-71
    contains: ArrowState | BlockerState | null;
    blocked: boolean;
}

// =============================================================
// Game Pieces — Discriminated Unions
// =============================================================

export type ArrowColor = 'b' | 'w';

export interface ArrowState {
    type: 'arrow';
    color: ArrowColor;
    fromStation: StationName;
    toStation: StationName;
    slotId: number;
}

export interface RingState {
    type: 'ring';
    color: PlayerColor;
    size: 's' | 'm' | 'l';
}

export interface BlockerState {
    type: 'blocker';
    color: PlayerColor;
    slotId: number;
}

export interface BasePostMove {
    type: 'basePost';
    color: PlayerColor;
    toStation: StationName;
}

/** Union of all piece types for type dispatch */
export type GamePiece = ArrowState | RingState | BlockerState | BasePostMove;

// =============================================================
// Type Guards
// =============================================================

export function isArrow(p: GamePiece): p is ArrowState {
    return p.type === 'arrow';
}

export function isRing(p: GamePiece): p is RingState {
    return p.type === 'ring';
}

export function isBlocker(p: GamePiece): p is BlockerState {
    return p.type === 'blocker';
}

export function isBasePost(p: GamePiece): p is BasePostMove {
    return p.type === 'basePost';
}

// =============================================================
// Moves
// =============================================================

export interface MoveAction {
    type: 'place' | 'remove' | 'replace';
    pieceToAdd?: ArrowState | RingState | BlockerState | BasePostMove;
    pieceToRemove?: ArrowState | BlockerState;
}

export interface RecordedMove {
    move: MoveAction;
    color: PlayerColor;
    timestamp: number;
    moveIndex: number;
}

// =============================================================
// Validation
// =============================================================

export interface ValidationResult {
    valid: boolean;
    reason?: string;
}

// =============================================================
// Game Recording
// =============================================================

export interface GameRecord {
    version: 1;
    gameId: string;
    timestamp: number;
    config: GameConfig;
    pathPattern: ArrowColor[];
    initialState: FinityGameState;
    agents: Record<PlayerColor, AgentInfo>;
    moves: RecordedMove[];
    result: GameResult | null;
    metadata?: Record<string, unknown>;
}

export interface GameResult {
    winners: PlayerColor[];
    reason: 'path_complete' | 'concession' | 'deadlock' | 'timeout' | 'forfeit';
    finalState: FinityGameState;
    totalMoves: number;
    durationMs: number;
}

export interface AgentInfo {
    id: string;
    type: 'human-local' | 'human-remote' | 'ai-builtin' | 'ai-custom' | 'ai-ml';
    label: string;
    author: string;
    version?: string;
}

// =============================================================
// Custom Agent Profiles
// =============================================================

export interface UserAgent {
    id: string;
    userId: string;
    name: string;
    description: string;
    language: 'javascript' | 'python';
    code: string;
    version: number;
    isPublic: boolean;
    forkedFrom?: string;
    stats: AgentStats;
    tags: string[];
    createdAt: number;
    updatedAt: number;
}

export interface AgentStats {
    gamesPlayed: number;
    wins: number;
    losses: number;
    draws: number;
    winRate: number;
    avgMoveTimeMs: number;
    eloRating?: number;
    matchHistory: MatchRecord[];
}

export interface MatchRecord {
    gameId: string;
    opponentAgentId: string;
    opponentType: string;
    result: 'win' | 'loss' | 'draw';
    totalMoves: number;
    date: number;
}

// =============================================================
// Board Topology (static, precomputed per board size)
// =============================================================

export interface BoardTopology {
    /** All station names active for this board size */
    stations: StationName[];

    /** Starting stations per player count */
    startStations: StationName[];

    /** fromStation → toStation → channel → slot index */
    stationSlotMapping: Record<StationName, Record<StationName, Partial<Record<Channel, number>>>>;

    /** slot index → list of interfering slot indices */
    slotInterferences: number[][];

    /** slot index → list of neighbor slot indices (same station pair) */
    slotNeighbors: number[][];

    /** slot index → [stationA, stationB] */
    slotStations: [StationName, StationName][];
}

// =============================================================
// Player Agent Interface
// =============================================================

export interface PlayerAgent {
    id: string;
    label: string;
    description: string;
    author: string;
    type: 'human-local' | 'human-remote' | 'ai-builtin' | 'ai-custom' | 'ai-ml';

    move(color: PlayerColor, state: FinityGameState): Promise<MoveAction>;

    onGameStart?(config: GameConfig): void;
    onGameEnd?(result: GameResult): void;
    onOpponentMove?(move: RecordedMove): void;
    dispose?(): void;
}
