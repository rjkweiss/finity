/**
 * PlayerPanel — ported from PlayerPanel.js
 * Shows agent selector, control panel or AI info, and medal overlays.
 */

import { useState } from 'react';
import type { PlayerColor } from '@finity/engine';

interface PlayerPanelProps {
  color: PlayerColor;
  isTurn: boolean;
  winners: PlayerColor[];
  onAgentChange?: (color: PlayerColor, agent: string) => void;
  onMoveSelect?: (color: PlayerColor, moveType: string) => void;
}

type AgentType = 'human-loc' | 'ai-random' | 'ai-easy' | 'ai-medium' | 'ai-hard';

export default function PlayerPanel({
  color,
  isTurn,
  winners,
  onAgentChange,
  onMoveSelect,
}: PlayerPanelProps) {
  const [agent, setAgent] = useState<AgentType>('human-loc');
  const [moveType, setMoveType] = useState<string>('select');

  const winIndex = winners.indexOf(color);

  const handleAgentChange = (value: string) => {
    setAgent(value as AgentType);
    onAgentChange?.(color, value);
  };

  const handleMoveSelect = (value: string) => {
    setMoveType(value);
    onMoveSelect?.(color, value);
  };

  return (
    <div
      id={`player_${color}`}
      className={`player-panel ${isTurn ? 'to-play' : ''}`}
    >
      {/* Agent selector */}
      <select
        className="form-select"
        value={agent}
        onChange={(e) => handleAgentChange(e.target.value)}
      >
        <option value="human-loc">Local Human</option>
        <option value="human-rem" disabled>Remote Human</option>
        <option value="ai-random">Random Moves AI</option>
        <option value="ai-easy">Easy AI</option>
        <option value="ai-medium">Medium AI</option>
        <option value="ai-hard">Hard AI</option>
        <option value="ai-custom" disabled>Custom AI</option>
      </select>

      {/* Control panel or AI info */}
      {agent === 'human-loc' ? (
        <HumanControlPanel
          color={color}
          isTurn={isTurn}
          moveType={moveType}
          onMoveSelect={handleMoveSelect}
        />
      ) : (
        <AiInfoPanel color={color} isTurn={isTurn} />
      )}

      {/* Overlay: not-your-turn dimmer or medal */}
      {!isTurn && (
        <div className="no-play-panel">
          {winIndex === 0 && <MedalDisplay type="gold" />}
          {winIndex === 1 && <MedalDisplay type="silver" />}
          {winIndex === 2 && <MedalDisplay type="bronze" />}
        </div>
      )}
    </div>
  );
}

// ===============================
// Sub-components
// ===============================

function HumanControlPanel({
  color,
  isTurn,
  moveType,
  onMoveSelect,
}: {
  color: PlayerColor;
  isTurn: boolean;
  moveType: string;
  onMoveSelect: (value: string) => void;
}) {
  return (
    <div className="player-controls">
      <select
        className="form-select"
        value={moveType}
        onChange={(e) => onMoveSelect(e.target.value)}
      >
        <option value="select">Select Move</option>
        <option value="b-arrow">Place Black Arrow</option>
        <option value="w-arrow">Place White Arrow</option>
        <option value="ring">Place Ring</option>
        <option value="base-post">Move Base Post</option>
        <option value="blocker">Move Blocker</option>
        <option value="rev-arrow">Reverse Arrow</option>
        <option value="rem-arrow">Remove Arrow</option>
        <option value="opp-blocker" disabled>Remove Opponent's Blocker</option>
        <option value="concede">Concede the Game</option>
      </select>

      {isTurn && moveType === 'ring' && (
        <div className="moveInstruction">Click on a station to place a ring</div>
      )}
      {isTurn && moveType === 'base-post' && (
        <div className="moveInstruction">Click on a station to move the base post to</div>
      )}
      {isTurn && moveType === 'blocker' && (
        <div className="moveInstruction">Choose one of your blockers to move</div>
      )}
      {isTurn && (moveType === 'b-arrow' || moveType === 'w-arrow') && (
        <div className="moveInstruction">Click on a slot to place an arrow</div>
      )}
      {isTurn && moveType === 'rev-arrow' && (
        <div className="moveInstruction">Click on an arrow to reverse it</div>
      )}
      {isTurn && moveType === 'rem-arrow' && (
        <div className="moveInstruction">Click on an arrow to remove it</div>
      )}
    </div>
  );
}

function AiInfoPanel({ color, isTurn }: { color: PlayerColor; isTurn: boolean }) {
  return (
    <div className="ai-info">
      {isTurn && (
        <div className="moveInstruction">
          {color} AI is thinking about its move...
        </div>
      )}
    </div>
  );
}

function MedalDisplay({ type }: { type: 'gold' | 'silver' | 'bronze' }) {
  return (
    <img
      src={`img/medal-${type}.png`}
      alt={`${type} medal`}
      className="medal"
    />
  );
}
