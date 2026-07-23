// Step-by-step play log. Subscribes to the orchestrator's turn:end / game:over
// events and renders one human-readable line per applied move — this is what makes
// AI-vs-AI games legible move by move (paired with the orchestrator's turnDelayMs).
// Clears itself on reset (moveHistory back to 0) and when the orchestrator is
// replaced by a seat change.

import { useEffect, useRef, useState } from 'react';
import type { MoveAction } from '@finity/engine';
import type { GameOrchestrator } from '../orchestrator';
import { moveCategory, primaryTarget } from '../rendering/moveInputHandler';

function describeMove(move: MoveAction): string {
    const target = primaryTarget(move);
    const where =
        target == null
            ? ''
            : target.kind === 'station'
                ? ` on station ${target.station}`
                : ` at slot ${target.slotId}`;

    switch (moveCategory(move)) {
        case 'ring':
            return `places a ring${where}`;
        case 'basePost':
            return `moves base post${where}`;
        case 'arrow': {
            const c = move.pieceToAdd?.type === 'arrow' ? move.pieceToAdd.color : undefined;
            const shade = c === 'b' ? 'black ' : c === 'w' ? 'white ' : '';
            return `places a ${shade}arrow${where}`;
        }
        case 'reverse':
            return `reverses an arrow${where}`;
        case 'blocker':
            return `moves a blocker${where}`;
        case 'remove':
            return `removes a piece${where}`;
        default:
            return `moves${where}`;
    }
}

export default function MoveLog({ orchestrator }: { orchestrator: GameOrchestrator }) {
    const [entries, setEntries] = useState<string[]>([]);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setEntries([]);
        const offTurn = orchestrator.on('turn:end', ({ color, moveIndex, move }) => {
            setEntries((prev) => [...prev, `${moveIndex + 1}. ${color} ${describeMove(move)}`]);
        });
        const offOver = orchestrator.on('game:over', (result) => {
            setEntries((prev) => [
                ...prev,
                result.winners.length > 0
                    ? `★ ${result.winners.join(', ')} wins (${result.reason})`
                    : `★ game over: ${result.reason}`,
            ]);
        });
        // reset() re-notifies with an empty moveHistory — clear the log.
        const offState = orchestrator.subscribe((s) => {
            if (s.moveHistory.length === 0) setEntries([]);
        });
        return () => {
            offTurn();
            offOver();
            offState();
        };
    }, [orchestrator]);

    // Keep the newest move in view.
    useEffect(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [entries]);

    if (entries.length === 0) return null;
    return (
        <div className="move-log" ref={listRef} role="log" aria-label="Move log">
            {entries.map((line, i) => (
                <div key={i}>{line}</div>
            ))}
        </div>
    );
}
