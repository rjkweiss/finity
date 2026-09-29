/**
 * Finity Game Engine — Public API
 *
 * This is the only entry point for consumers of the engine.
 * All types and functions are re-exported from here.
 */

// Types
export type {
    FinityGameState,
    GameConfig,
    BoardState,
    StationState,
    SlotState,
    ArrowState,
    RingState,
    BlockerState,
    BasePostMove,
    MoveAction,
    RecordedMove,
    ValidationResult,
    GameRecord,
    GameResult,
    AgentInfo,
    PlayerColor,
    ArrowColor,
    StationName,
    StationCoord,
    StationNumber,
    Channel,
    GamePiece,
    BoardTopology,
    UserAgent,
    AgentStats,
    MatchRecord,
} from './types';

// Type guards
export {
    isArrow,
    isRing,
    isBlocker,
    isBasePost,
} from './types';

// Topology
export {
    COORD_TO_NAME,
    NAME_TO_COORD,
    NAME_TO_NUMBER,
    NUMBER_TO_NAME,
    toStationName,
    toCoord,
    STATIONS_BY_PLAYER_COUNT,
    START_STATIONS,
    STATION_SLOTS,
    SLOT_INTERFERENCES,
    SLOT_NEIGHBORS,
    SLOT_TO_STATIONS,
    getSlotInterferences,
    getSlotNeighbors,
    buildTopology,
    slotName,
    slotChannel
} from './topology';

// Engine core
export {
    createGame,
    applyMove,
    currentPlayer,
    isGameOver,
    stationRingCount,
    topmostOpening,
    stationControlledBy,
    occupiesHighPoint,
    getAllArrows,
    getAllBlockers,
    getAllRings,
    arrowCount,
    ringCount,
    outArrows,
    canBlockSlot,
    isRedundant,
    DEFAULT_REPETITION_LIMIT
} from './engine';

// Path analysis
export {
    basePostStation,
    reachableStations,
    hasFullPath,
    legalPaths,
    longestLegalPathLength,
    reachableStationCount,
} from './path-analyzer';

export {
    possibleMoves,
    legalMoves
} from './possible-moves';

export { evaluate, DEFAULT_WEIGHTS, type EvalWeights } from './evaluation';

export { computeZobristHash } from './zobrist';

export { boardHash, filterImmediateUndo, violatesReplacementRule } from './no-undo';

export { generatePathPattern, PATTERN_POOL, PATTERN_LENGTH } from './pattern';

export { layeredPlan, movesToWin, type LayeredPlan } from './layered';
