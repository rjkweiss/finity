// Step-by-step play log. Subscribes to the orchestrator's turn:end / game:over
// events and renders one human-readable line per applied move — this is what makes
// AI-vs-AI games legible move by move (paired with the orchestrator's turnDelayMs).
// Clears itself on reset (moveHistory back to 0) and when the orchestrator is
// replaced by a seat change.

import { useEffect, useRef, useState } from 'react';
import { MoveAction, slotName } from '@finity/engine';
import type { GameOrchestrator } from '../orchestrator';
import { moveCategory, primaryTarget } from '../rendering/moveInputHandler';


export function describeMove(move: MoveAction): string {
    const target = primaryTarget(move);
    const where =
        target == null
            ? ''
            : target.kind === 'station'
                ? ` on station ${target.station}`
                : ` at ${slotName(target.slotId)} (slot ${target.slotId})`;

    const arrow = move.pieceToAdd?.type === 'arrow' ? move.pieceToAdd : undefined;
    const shade = arrow?.color === 'b' ? 'black ' : arrow?.color === 'w' ? 'white ' : '';
    const heading = arrow ? ` pointing ${arrow.fromStation}->${arrow.toStation}` : '';

    switch (moveCategory(move)) {
        case 'ring':
            return `places a ring${where}`;
        case 'basePost':
            return `moves base post${where}`;
        case 'arrow':
            return `places a ${shade}arrow${where}${heading}`;
        case 'reverse':
            return `reverses an arrow${where} to point${heading.replace(' pointing', '')}`;
        case 'blocker':
            return `moves a blocker${where}`;
        case 'remove': {
            const r = move.pieceToRemove;
            const what = r?.type === 'arrow'
                ? `the ${r.color === 'b' ? 'black' : 'white'} ${r.fromStation}->${r.toStation} arrow`
                : 'a piece';
            return `removes ${what}${where}`;
        }
        default:
            return `moves${where}`;
    }
}

interface LogEntry {
    text: string;
    move?: MoveAction;
    moveIndex?: number;
}

export interface MoveLogProps {
    orchestrator: GameOrchestrator;
    /** Hovering a line marks that move on the board */
    onHover?: (move: MoveAction | null) => void;
    /** Clicking a line shows the position right after that move */
    onSelect?: (moveIndex: number) => void;
    /** The move whose resulting position is on the board, when viewing history */
    viewedMoveIndex?: number | null;
}
export default function MoveLog({ orchestrator, onHover, onSelect, viewedMoveIndex }: MoveLogProps) {
    const [entries, setEntries] = useState<LogEntry[]>([]);
    const listRef = useRef<HTMLDivElement>(null);
    // Read through a ref so the subscription effect doesn't resubscribe on every render.
    const hoverRef = useRef(onHover);
    hoverRef.current = onHover;

    useEffect(() => {
        setEntries([]);
        const offTurn = orchestrator.on('turn:end', ({ color, moveIndex, move }) => {
            setEntries((prev) => [...prev, { text: `${moveIndex + 1}. ${color} ${describeMove(move)}`, move, moveIndex }]);
        });
        const offOver = orchestrator.on('game:over', (result) => {
            setEntries((prev) => [
                ...prev,
                {
                    text: result.winners.length > 0
                        ? `★ ${result.winners.join(', ')} wins (${result.reason})`
                        : `★ game over: ${result.reason}`,
                },
            ]);
        });
        // reset() re-notifies with an empty moveHistory: clear the log and any hover.
        const offState = orchestrator.subscribe((s) => {
            if (s.moveHistory.length === 0) {
                setEntries([]);
                hoverRef.current?.(null);
            }
        });
        return () => {
            offTurn();
            offOver();
            offState();
        };
    }, [orchestrator]);

    // Keep the newest move in view, but not while browsing history.
    useEffect(() => {
        const el = listRef.current;
        if (el && viewedMoveIndex == null) el.scrollTop = el.scrollHeight;
    }, [entries, viewedMoveIndex]);

    if (entries.length === 0) return null;
    return (
        <div className="move-log" ref={listRef} role="log" aria-label="Move log"
            onMouseLeave={() => onHover?.(null)}>
            {entries.map((e, i) =>
                e.move !== undefined && e.moveIndex !== undefined ? (
                    <div
                        key={i}
                        className={'move-log-entry' + (e.moveIndex === viewedMoveIndex ? ' is-viewed' : '')}
                        role="button"
                        tabIndex={0}
                        title="Click to see the board after this move"
                        onMouseEnter={() => onHover?.(e.move!)}
                        onFocus={() => onHover?.(e.move!)}
                        onBlur={() => onHover?.(null)}
                        onClick={() => onSelect?.(e.moveIndex!)}
                        onKeyDown={(ev) => {
                            if (ev.key === 'Enter' || ev.key === ' ') {
                                ev.preventDefault();
                                onSelect?.(e.moveIndex!);
                            }
                        }}
                    >
                        {e.text}
                    </div>
                ) : (
                    <div key={i}>{e.text}</div>
                ),
            )}
        </div>
    );
}
