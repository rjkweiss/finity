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
    PlayerAgent,
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
    canMakeArrowMoveInSlot,
} from './engine';

// Path analysis
export {
    basePostStation,
    reachableStations,
    hasFullPath,
    legalPaths,
    longestLegalPathLength,
    longestSupportedPathLength,
    reachableStationCount,
} from './path_analyzer';
