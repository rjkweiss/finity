import { describe, it, expect } from 'vitest';
import {
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
  canBlockSlot,
  isRedundant,
  canMakeArrowMoveInSlot,
} from '../src/engine';
import type {
  FinityGameState,
  GameConfig,
  MoveAction,
  ArrowState,
  StationName,
} from '../src/types';

// =============================================================
// Test Fixtures
// =============================================================

function make2PlayerConfig(): GameConfig {
  return { playerColors: ['cyan', 'yellow'], boardSize: 2 };
}

function make4PlayerConfig(): GameConfig {
  return { playerColors: ['cyan', 'yellow', 'red', 'purple'], boardSize: 4 };
}

/** Standard path pattern for consistent tests */
const TEST_PATTERN: ('b' | 'w')[] = ['b', 'w', 'b', 'w', 'b', 'w', 'b', 'w'];

function createTestGame(config?: GameConfig): FinityGameState {
  return createGame(config ?? make4PlayerConfig(), TEST_PATTERN);
}

/** Helper to create an arrow placement move */
function placeArrowMove(
  color: 'b' | 'w',
  from: StationName,
  to: StationName,
  slotId: number,
): MoveAction {
  return {
    type: 'place',
    pieceToAdd: { type: 'arrow', color, fromStation: from, toStation: to, slotId },
  };
}

// =============================================================
// Game Creation
// =============================================================

describe('createGame', () => {
  it('creates a game with correct version', () => {
    const game = createTestGame();
    expect(game.version).toBe(1);
  });

  it('stores the path pattern', () => {
    const game = createTestGame();
    expect(game.pathPattern).toEqual(TEST_PATTERN);
    expect(game.pathPattern).toHaveLength(8);
  });

  it('starts in playing status', () => {
    const game = createTestGame();
    expect(game.playStatus).toBe('playing');
  });

  it('starts at turn index 0', () => {
    const game = createTestGame();
    expect(game.turnIndex).toBe(0);
  });

  it('starts with empty move history', () => {
    const game = createTestGame();
    expect(game.moveHistory).toHaveLength(0);
  });

  it('starts with no winners', () => {
    const game = createTestGame();
    expect(game.winners).toHaveLength(0);
  });

  it('preserves config', () => {
    const config = make4PlayerConfig();
    const game = createGame(config, TEST_PATTERN);
    expect(game.config.playerColors).toEqual(['cyan', 'yellow', 'red', 'purple']);
    expect(game.config.boardSize).toBe(4);
  });
});

describe('Initial board state — 4 player', () => {
  const game = createTestGame(make4PlayerConfig());

  it('has center station', () => {
    expect(game.board.stations['C']).toBeDefined();
  });

  it('has all 72 slots', () => {
    expect(game.board.slots).toHaveLength(72);
  });

  it('places base posts at start stations', () => {
    // 4-player starts: NW, NE, SE, SW → cyan, yellow, red, purple
    expect(game.board.stations['NW'].basePost).toBe('cyan');
    expect(game.board.stations['NE'].basePost).toBe('yellow');
    expect(game.board.stations['SE'].basePost).toBe('red');
    expect(game.board.stations['SW'].basePost).toBe('purple');
  });

  it('non-start stations have no base posts', () => {
    expect(game.board.stations['C'].basePost).toBeNull();
    expect(game.board.stations['N'].basePost).toBeNull();
    expect(game.board.stations['S'].basePost).toBeNull();
  });

  it('center station has initial rings', () => {
    const centerRings = game.board.stations['C'].rings;
    // 4 players reversed: purple, red, yellow, cyan — but only 3 ring slots
    // First 3 get large rings
    expect(centerRings[0]).not.toBeNull();
    expect(centerRings[1]).not.toBeNull();
    expect(centerRings[2]).not.toBeNull();
  });

  it('center rings are all large size', () => {
    for (const ring of game.board.stations['C'].rings) {
      if (ring) expect(ring.size).toBe('l');
    }
  });

  it('non-center stations have no rings initially', () => {
    for (const [name, station] of Object.entries(game.board.stations)) {
      if (name !== 'C') {
        expect(station.rings.every(r => r === null)).toBe(true);
      }
    }
  });

  it('initial blockers are placed (8 total for 4 players)', () => {
    const blockers = getAllBlockers(game);
    expect(blockers).toHaveLength(8);
  });

  it('each player has exactly 2 blockers', () => {
    const blockers = getAllBlockers(game);
    for (const color of ['cyan', 'yellow', 'red', 'purple'] as const) {
      expect(blockers.filter(b => b.color === color)).toHaveLength(2);
    }
  });

  it('no arrows initially', () => {
    expect(getAllArrows(game)).toHaveLength(0);
    expect(arrowCount(game)).toBe(0);
  });
});

describe('Initial board state — 2 player', () => {
  const game = createTestGame(make2PlayerConfig());

  it('places base posts at N and S', () => {
    expect(game.board.stations['N'].basePost).toBe('cyan');
    expect(game.board.stations['S'].basePost).toBe('yellow');
  });

  it('has 4 blockers (2 per player)', () => {
    const blockers = getAllBlockers(game);
    expect(blockers).toHaveLength(4);
  });
});

// =============================================================
// State Queries
// =============================================================

describe('currentPlayer', () => {
  it('returns first player color at turn 0', () => {
    const game = createTestGame();
    expect(currentPlayer(game)).toBe('cyan');
  });
});

describe('stationRingCount', () => {
  it('center has 3 rings initially (4-player)', () => {
    const game = createTestGame(make4PlayerConfig());
    expect(stationRingCount(game.board.stations['C'])).toBe(3);
  });

  it('empty station has 0 rings', () => {
    const game = createTestGame();
    expect(stationRingCount(game.board.stations['N'])).toBe(0);
  });
});

describe('topmostOpening', () => {
  it('empty station opens at small', () => {
    const game = createTestGame();
    expect(topmostOpening(game.board.stations['N'])).toBe('s');
  });

  it('full station returns null', () => {
    const game = createTestGame(make4PlayerConfig());
    // Center has 3 rings in 4-player
    expect(topmostOpening(game.board.stations['C'])).toBeNull();
  });
});

describe('stationControlledBy', () => {
  it('station with base post is controlled by that color', () => {
    const game = createTestGame();
    expect(stationControlledBy(game.board.stations['NW'])).toBe('cyan');
  });

  it('empty station is controlled by no one', () => {
    const game = createTestGame();
    expect(stationControlledBy(game.board.stations['N'])).toBeNull();
  });

  it('center with rings is controlled by smallest ring color', () => {
    const game = createTestGame(make4PlayerConfig());
    const controller = stationControlledBy(game.board.stations['C']);
    // First ring (index 0, smallest position) controls
    expect(controller).toBe(game.board.stations['C'].rings[0]!.color);
  });
});

describe('occupiesHighPoint', () => {
  it('player with base post occupies high point', () => {
    const game = createTestGame();
    expect(occupiesHighPoint(game, 'cyan', 'NW')).toBe(true);
  });

  it('player without presence does not occupy high point', () => {
    const game = createTestGame();
    expect(occupiesHighPoint(game, 'cyan', 'N')).toBe(false);
  });

  it('wrong player does not occupy high point', () => {
    const game = createTestGame();
    expect(occupiesHighPoint(game, 'yellow', 'NW')).toBe(false);
  });
});

describe('ringCount', () => {
  it('each player has initial rings from center (4-player)', () => {
    const game = createTestGame(make4PlayerConfig());
    // 4 players, 3 ring slots → 3 players get rings on center
    const totalRings = game.config.playerColors.reduce(
      (sum, c) => sum + ringCount(game, c), 0
    );
    expect(totalRings).toBe(3);
  });
});

// =============================================================
// Move Application
// =============================================================

describe('applyMove — immutability', () => {
  it('does not mutate the input state', () => {
    const game = createTestGame();
    const originalJson = JSON.stringify(game);
    const move = placeArrowMove('b', 'C', 'N', 1);

    const next = applyMove(game, move);

    expect(JSON.stringify(game)).toBe(originalJson);
    expect(next).not.toBe(game);
  });

  it('returns a new state object', () => {
    const game = createTestGame();
    const move = placeArrowMove('b', 'C', 'N', 1);
    const next = applyMove(game, move);
    expect(next).not.toBe(game);
    expect(next.board).not.toBe(game.board);
  });
});

describe('applyMove — arrow placement', () => {
  it('places an arrow in the specified slot', () => {
    const game = createTestGame();
    const move = placeArrowMove('b', 'C', 'N', 1);
    const next = applyMove(game, move);

    expect(next.board.slots[1].contains).not.toBeNull();
    expect(next.board.slots[1].contains!.type).toBe('arrow');
    expect((next.board.slots[1].contains as ArrowState).color).toBe('b');
    expect((next.board.slots[1].contains as ArrowState).fromStation).toBe('C');
    expect((next.board.slots[1].contains as ArrowState).toStation).toBe('N');
  });

  it('original slot remains empty after arrow placed in new state', () => {
    const game = createTestGame();
    const move = placeArrowMove('b', 'C', 'N', 1);
    applyMove(game, move);

    // Original state unchanged
    expect(game.board.slots[1].contains).toBeNull();
  });

  it('arrow count increases by 1', () => {
    const game = createTestGame();
    expect(arrowCount(game)).toBe(0);

    const move = placeArrowMove('b', 'C', 'N', 1);
    const next = applyMove(game, move);
    expect(arrowCount(next)).toBe(1);
  });

  it('places arrow and applies slot interference', () => {
    const game = createTestGame();
    // Slot 0 interferes with slots 17 and 18
    const move = placeArrowMove('b', 'C', 'N', 0);
    const next = applyMove(game, move);

    expect(next.board.slots[17].blocked).toBe(true);
    expect(next.board.slots[18].blocked).toBe(true);
    // Original not blocked
    expect(game.board.slots[17].blocked).toBe(false);
  });
});

describe('applyMove — arrow removal', () => {
  it('removes an arrow and clears interference', () => {
    // First place an arrow
    let game = createTestGame();
    const placeMove = placeArrowMove('b', 'C', 'N', 0);
    game = applyMove(game, placeMove);

    expect(game.board.slots[0].contains).not.toBeNull();
    expect(game.board.slots[17].blocked).toBe(true);

    // Now remove it
    const removeMove: MoveAction = {
      type: 'remove',
      pieceToRemove: { type: 'arrow', color: 'b', fromStation: 'C', toStation: 'N', slotId: 0 },
    };
    const next = applyMove(game, removeMove);

    expect(next.board.slots[0].contains).toBeNull();
    expect(next.board.slots[17].blocked).toBe(false);
    expect(next.board.slots[18].blocked).toBe(false);
  });
});

describe('applyMove — arrow reversal', () => {
  it('replaces arrow direction in same slot', () => {
    let game = createTestGame();
    const placeMove = placeArrowMove('b', 'C', 'N', 1);
    game = applyMove(game, placeMove);

    const reverseMove: MoveAction = {
      type: 'replace',
      pieceToRemove: { type: 'arrow', color: 'b', fromStation: 'C', toStation: 'N', slotId: 1 },
      pieceToAdd: { type: 'arrow', color: 'b', fromStation: 'N', toStation: 'C', slotId: 1 },
    };
    const next = applyMove(game, reverseMove);

    const arrow = next.board.slots[1].contains as ArrowState;
    expect(arrow.fromStation).toBe('N');
    expect(arrow.toStation).toBe('C');
    expect(arrow.color).toBe('b');
  });
});

describe('applyMove — blocker removal', () => {
  it('removes a blocker from its slot', () => {
    const game = createTestGame();
    // Find a blocker slot
    const blockerSlot = game.board.slots.find(s => s.contains?.type === 'blocker');
    expect(blockerSlot).toBeDefined();

    const removeMove: MoveAction = {
      type: 'remove',
      pieceToRemove: blockerSlot!.contains as any,
    };
    const next = applyMove(game, removeMove);
    expect(next.board.slots[blockerSlot!.id].contains).toBeNull();
  });
});

describe('applyMove — base post move', () => {
  it('moves base post from one station to another', () => {
    const game = createTestGame();
    expect(game.board.stations['NW'].basePost).toBe('cyan');
    expect(game.board.stations['N'].basePost).toBeNull();

    const move: MoveAction = {
      type: 'replace',
      pieceToAdd: { type: 'basePost', color: 'cyan', toStation: 'N' },
    };
    const next = applyMove(game, move);

    expect(next.board.stations['NW'].basePost).toBeNull();
    expect(next.board.stations['N'].basePost).toBe('cyan');
  });
});

// =============================================================
// Turn Management
// =============================================================

describe('Turn management', () => {
  it('advances turn after a move', () => {
    const game = createTestGame(make4PlayerConfig());
    expect(currentPlayer(game)).toBe('cyan');

    const move = placeArrowMove('b', 'C', 'N', 1);
    const next = applyMove(game, move);
    expect(next.turnIndex).toBe(1);
    expect(currentPlayer(next)).toBe('yellow');
  });

  it('wraps turn index around player count', () => {
    const config = make2PlayerConfig();
    let game = createGame(config, TEST_PATTERN);

    // Turn 0: cyan
    expect(currentPlayer(game)).toBe('cyan');
    game = applyMove(game, placeArrowMove('b', 'C', 'N', 1));

    // Turn 1: yellow
    expect(currentPlayer(game)).toBe('yellow');
    game = applyMove(game, placeArrowMove('w', 'C', 'S', 10));

    // Turn 2: back to cyan
    expect(currentPlayer(game)).toBe('cyan');
  });

  it('records moves in history', () => {
    let game = createTestGame();
    game = applyMove(game, placeArrowMove('b', 'C', 'N', 1));
    game = applyMove(game, placeArrowMove('w', 'C', 'S', 10));

    expect(game.moveHistory).toHaveLength(2);
    expect(game.moveHistory[0].moveIndex).toBe(0);
    expect(game.moveHistory[1].moveIndex).toBe(1);
  });
});

// =============================================================
// Validation Helpers
// =============================================================

describe('canMakeArrowMoveInSlot — no-undo rule', () => {
  it('allows any move when history is empty', () => {
    const game = createTestGame();
    expect(canMakeArrowMoveInSlot(game, 1, 'b', 'place')).toBe(true);
    expect(canMakeArrowMoveInSlot(game, 1, 'b', 'remove')).toBe(true);
    expect(canMakeArrowMoveInSlot(game, 1, 'b', 'replace')).toBe(true);
  });

  it('blocks placing arrow that was just removed from same slot', () => {
    let game = createTestGame();
    // Place arrow
    game = applyMove(game, placeArrowMove('b', 'C', 'N', 1));
    // Remove it
    const removeMove: MoveAction = {
      type: 'remove',
      pieceToRemove: { type: 'arrow', color: 'b', fromStation: 'C', toStation: 'N', slotId: 1 },
    };
    game = applyMove(game, removeMove);

    // Now trying to place same color arrow in same slot should be blocked
    expect(canMakeArrowMoveInSlot(game, 1, 'b', 'place')).toBe(false);
  });

  it('allows placing different color arrow in same slot after removal', () => {
    let game = createTestGame();
    game = applyMove(game, placeArrowMove('b', 'C', 'N', 1));
    const removeMove: MoveAction = {
      type: 'remove',
      pieceToRemove: { type: 'arrow', color: 'b', fromStation: 'C', toStation: 'N', slotId: 1 },
    };
    game = applyMove(game, removeMove);

    // Different color should be allowed
    expect(canMakeArrowMoveInSlot(game, 1, 'w', 'place')).toBe(true);
  });
});

describe('isRedundant', () => {
  it('returns false when no neighbor has same color+direction', () => {
    const game = createTestGame();
    // Slot 1 neighbors are 0 and 2, both empty
    expect(isRedundant(game, 1, 'N', 'b')).toBe(false);
  });

  it('returns true when neighbor has same color arrow to same destination', () => {
    let game = createTestGame();
    // Place arrow in slot 0 going to N with color b
    game = applyMove(game, placeArrowMove('b', 'C', 'N', 0));

    // Slot 1 is a neighbor of slot 0. Trying to place same color to same destination
    expect(isRedundant(game, 1, 'N', 'b')).toBe(true);
  });

  it('returns false when neighbor has different color', () => {
    let game = createTestGame();
    game = applyMove(game, placeArrowMove('b', 'C', 'N', 0));

    // Different color should not be redundant
    expect(isRedundant(game, 1, 'N', 'w')).toBe(false);
  });
});

// =============================================================
// isGameOver
// =============================================================

describe('isGameOver', () => {
  it('returns false for a fresh game', () => {
    const game = createTestGame();
    expect(isGameOver(game)).toBe(false);
  });

  it('returns true when play status is over', () => {
    const game = createTestGame();
    game.playStatus = 'over'; // directly set for testing
    expect(isGameOver(game)).toBe(true);
  });
});
