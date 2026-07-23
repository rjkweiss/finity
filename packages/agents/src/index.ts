// packages/agents/src/index.ts
export * from './interface';
export { ScriptedAgent, type ScriptedAgentOptions } from './scripted-agent';
export { LocalHumanAgent } from './human-local';
export { RandomAgent, WeightedRandomAgent, type RandomAgentOptions } from './ai-random';

// search-based opponents
export { MinimaxAgent, type MinimaxOptions } from './ai-minimax';
export { MCTSAgent, type MctsOptions } from './ai-mcts';
export { createBuiltinAgent, type Difficulty } from './ai-builtin';

// Shared AI helpers (exported for tests / custom-agent authors)
export {
    moveCategory,
    type MoveCategory,
    type CategoryWeights,
    DEFAULT_CATEGORY_WEIGHTS,
    seededRng,
    type Rng,
} from './ai-common';
