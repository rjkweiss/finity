// Replay viewer (the History tab). Loads a GameRecord — the last finished
// game, the in-progress game, or an imported .json — and reconstructs every position
// by folding the ENGINE's applyMove over the recorded moves from the record's
// initialState. Nothing is trusted from the file beyond inputs: what you see is what
// the engine derives, which is exactly the fidelity guarantee the BGA replay
// validator establishes for scraped records.
//
// index semantics: 0 = initial position, i = position after move i. The move list's
// entry i is therefore "current" when index === i + 1.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FinityGameState, GameRecord } from '@finity/engine';
import { applyMove } from '@finity/engine';
import { computeLayout } from '../rendering/layout';
import FinityCanvas from './FinityCanvas';
import { describeMove } from './MoveLog';
import { parseGameRecord } from '@finity/recorder';
import { downloadGameRecord } from '../recordExport';

const AUTOPLAY_MS = 600; // matches App's TURN_DELAY_MS so replays feel like live games

export interface ReplayViewProps {
    /** Most recently FINISHED game (App updates this on game:over). Auto-loaded
     *  when the view has nothing loaded yet. */
    latestRecord?: GameRecord | null;
    /** Snapshot of the game currently being played (may be mid-game). */
    getLiveRecord?: () => GameRecord | null;
}

interface Loaded {
    record: GameRecord;
    states: FinityGameState[]; // length = moves.length + 1
}

/** Engine-faithful reconstruction. Throws if the record doesn't replay (foreign or
 *  corrupted JSON) — the caller surfaces that as an error banner. */
function reconstruct(record: GameRecord): Loaded {
    const states: FinityGameState[] = [record.initialState];
    let s = record.initialState;
    for (const rm of record.moves) {
        s = applyMove(s, rm.move);
        states.push(s);
    }
    return { record, states };
}

export default function ReplayView({ latestRecord, getLiveRecord }: ReplayViewProps) {
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [index, setIndex] = useState(0);
    const [playing, setPlaying] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);

    const load = (record: GameRecord, atIndex?: number) => {
        try {
            const l = reconstruct(record);
            setLoaded(l);
            setIndex(Math.min(atIndex ?? 0, l.states.length - 1));
            setPlaying(false);
            setError(null);
        } catch (e) {
            setError(`Record failed to replay through the engine: ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    // Auto-load the most recent finished game when the tab opens empty.
    useEffect(() => {
        if (!loaded && latestRecord) load(latestRecord);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [latestRecord]);

    // Autoplay: advance one position per tick, stop at the end.
    useEffect(() => {
        if (!playing || !loaded) return;
        if (index >= loaded.states.length - 1) {
            setPlaying(false);
            return;
        }
        const t = setTimeout(() => setIndex((i) => Math.min(i + 1, loaded.states.length - 1)), AUTOPLAY_MS);
        return () => clearTimeout(t);
    }, [playing, index, loaded]);

    // Keep the current move visible in the list.
    useEffect(() => {
        const el = listRef.current?.querySelector('.replay-move.current');
        el?.scrollIntoView({ block: 'nearest' });
    }, [index]);

    const onImportFile = (e: { target: { files: FileList | null; value: string } }) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-importing the same file
        if (!file) return;
        file.text()
            .then((text) => load(parseGameRecord(text)))
            .catch((err: unknown) =>
                setError(`Could not import record: ${err instanceof Error ? err.message : String(err)}`),
            );
    };

    const onLoadLive = () => {
        const r = getLiveRecord?.();
        if (r) load(r, r.moves.length); // jump to the latest position
        else setError('No game in progress to load.');
    };

    const record = loaded?.record ?? null;
    const states = loaded?.states ?? [];

    // Same geometry contract as PlayView: the canvas consumes a layout computed
    // reactively from the loaded record's board size (a 3p record replays on a 3p
    // board even if the Play tab is set to 2p).
    const layout = useMemo(
        () => (record ? computeLayout(record.config.boardSize) : null),
        [record],
    );
    const last = states.length - 1;
    const atEnd = index >= last;

    const resultLine = useMemo(() => {
        if (!record) return null;
        if (!record.result) return 'In progress (no result recorded)';
        const { winners, reason } = record.result;
        return winners.length > 0 ? `★ ${winners.join(', ')} wins (${reason})` : `★ Game over: ${reason}`;
    }, [record]);

    return (
        <div className="replay-view">
            <div className="replay-toolbar">
                <label className="replay-import-btn">
                    Import JSON
                    <input type="file" accept=".json,application/json" onChange={onImportFile} style={{ display: 'none' }} />
                </label>
                {getLiveRecord && (
                    <button onClick={onLoadLive}>Load current game</button>
                )}
                {record && (
                    <button onClick={() => downloadGameRecord(record)}>Export JSON</button>
                )}
            </div>

            {error && <div className="replay-error">{error}</div>}

            {!record && !error && (
                <div className="placeholder-view">
                    <h2>Game History</h2>
                    <p>Finish a game on the Play tab, or import a saved record.</p>
                </div>
            )}

            {record && (
                <div className="replay-body">
                    <div className="replay-board">
                        <FinityCanvas gameState={states[index]} layout={layout!} />
                        <div className="replay-controls">
                            <button onClick={() => { setPlaying(false); setIndex(0); }} disabled={index === 0}>⏮</button>
                            <button onClick={() => { setPlaying(false); setIndex((i) => Math.max(0, i - 1)); }} disabled={index === 0}>◀</button>
                            <button onClick={() => setPlaying((p) => !p)} disabled={atEnd}>
                                {playing ? '⏸' : '▶'}
                            </button>
                            <button onClick={() => { setPlaying(false); setIndex((i) => Math.min(last, i + 1)); }} disabled={atEnd}>▶︎|</button>
                            <button onClick={() => { setPlaying(false); setIndex(last); }} disabled={atEnd}>⏭</button>
                            <input
                                type="range"
                                min={0}
                                max={last}
                                value={index}
                                onChange={(e: { target: { value: string } }) => {
                                    setPlaying(false);
                                    setIndex(Number(e.target.value));
                                }}
                            />
                            <span className="replay-position">
                                {index} / {last}
                            </span>
                        </div>
                    </div>

                    <div className="replay-sidebar">
                        <div className="replay-meta">
                            <div><strong>Game</strong> {record.gameId.slice(0, 8)}</div>
                            <div><strong>Players</strong> {Object.entries(record.agents).map(([c, a]) => `${c}: ${a.label}`).join(' · ')}</div>
                            <div><strong>Pattern</strong> {record.pathPattern.join('')}</div>
                            {resultLine && <div className="replay-result">{resultLine}</div>}
                        </div>
                        <div className="replay-movelist" ref={listRef}>
                            {record.moves.map((rm, i) => (
                                <div
                                    key={i}
                                    className={`replay-move${index === i + 1 ? ' current' : ''}`}
                                    onClick={() => { setPlaying(false); setIndex(i + 1); }}
                                >
                                    {i + 1}. {rm.color} {describeMove(rm.move)}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
