// packages/client/src/rendering/moveInputHandler.ts
//
// STEP 6 — Turns board interactions into legal MoveActions and hands the finished
// move to the LocalHumanAgent. It NEVER calls applyMove or mutates state; it only
// produces move intents drawn from possibleMoves().
//
// Two things are deliberately injected/isolated because they depend on details this
// module shouldn't own:
//   - getLegalMoves: defaults to possibleMoves() but is injectable for unit tests.
//   - primaryTarget / moveCategory / disambig: extract a "what did you click" target
//     and secondary options FROM a MoveAction. These MUST be reconciled with the real
//     possibleMoves() output shapes. See PHASE2-NOTES.md "MISS #7".
//
// The pixel -> BoardTarget hit-test (which station/slot a click landed on) lives in
// the layout/p5 layer and is NOT here — this module consumes already-resolved targets.

import {
    possibleMoves,
    type FinityGameState,
    type MoveAction,
    type PlayerColor,
    type StationName,
} from '@finity/engine';

export type BoardTarget =
    | { kind: 'station'; station: StationName }
    | { kind: 'slot'; slotId: number };

export type MoveCategory = 'ring' | 'arrow' | 'basePost' | 'blocker' | 'remove' | 'reverse' | 'other';

/** A choice presented when one target maps to several legal moves (e.g. place a black
 *  vs white arrow on the same slot, or place-vs-remove). */
export interface DisambigOption {
    id: string;
    label: string;
    move: MoveAction;
}

export type InputPhase =
    | { phase: 'selecting' }
    | { phase: 'disambiguating'; target: BoardTarget; options: DisambigOption[] };

export interface MoveInputHandlerOptions {
    /** Called with a completed move. Bind to LocalHumanAgent.submitMove. Returns whether
     *  the orchestrator accepted it (i.e. a human turn was actually awaiting). */
    submit: (move: MoveAction) => boolean;
    /** Defaults to the engine's possibleMoves; injectable for tests. */
    getLegalMoves?: (state: FinityGameState, color: PlayerColor) => MoveAction[];
    /** Notified whenever the phase or available targets change, so the UI can redraw. */
    onChange?: () => void;
}

export class MoveInputHandler {
    private state: FinityGameState | null = null;
    private legal: MoveAction[] = [];
    private categoryFilter: MoveCategory | null = null;
    private phase: InputPhase = { phase: 'selecting' };

    private readonly submit: (move: MoveAction) => boolean;
    private readonly getLegalMoves: (state: FinityGameState, color: PlayerColor) => MoveAction[];
    private readonly onChange?: () => void;

    constructor(opts: MoveInputHandlerOptions) {
        this.submit = opts.submit;
        this.getLegalMoves = opts.getLegalMoves ?? possibleMoves;
        this.onChange = opts.onChange;
    }

    /** Call at the start of each local-human turn (and whenever state changes). */
    refresh(state: FinityGameState, color: PlayerColor): void {
        this.state = state;
        this.legal = this.getLegalMoves(state, color);
        this.categoryFilter = null;
        this.phase = { phase: 'selecting' };
        this.onChange?.();
    }

    /** Clear selection input (no active turn). */
    clear(): void {
        this.state = null;
        this.legal = [];
        this.categoryFilter = null;
        this.phase = { phase: 'selecting' };
        this.onChange?.();
    }

    getPhase(): InputPhase {
        return this.phase;
    }

    /** Optional move-type pre-filter (mirrors the old HumanControlPanel dropdown). */
    setCategoryFilter(cat: MoveCategory | null): void {
        this.categoryFilter = cat;
        this.phase = { phase: 'selecting' };
        this.onChange?.();
    }

    private filteredLegal(): MoveAction[] {
        if (!this.categoryFilter) return this.legal;
        return this.legal.filter((m) => moveCategory(m) === this.categoryFilter);
    }

    /** Targets the player may click right now — used to highlight the board. */
    selectableTargets(): BoardTarget[] {
        const seen = new Set<string>();
        const out: BoardTarget[] = [];
        for (const m of this.filteredLegal()) {
            const t = primaryTarget(m);
            if (!t) continue;
            const k = targetKey(t);
            if (!seen.has(k)) {
                seen.add(k);
                out.push(t);
            }
        }
        return out;
    }

    /**
     * The player clicked a resolved board target. Outcomes:
     *  - no legal move there  -> ignored (returns false)
     *  - exactly one          -> submitted immediately
     *  - several              -> enter disambiguation; UI shows options
     */
    selectTarget(target: BoardTarget): boolean {
        if (!this.state) return false;
        const k = targetKey(target);
        const candidates = this.filteredLegal().filter((m) => {
            const t = primaryTarget(m);
            return t != null && targetKey(t) === k;
        });

        if (candidates.length === 0) return false;
        if (candidates.length === 1) return this.commit(candidates[0]);

        this.phase = {
            phase: 'disambiguating',
            target,
            options: candidates.map((move, i) => ({ id: `opt-${i}`, label: disambigLabel(move), move })),
        };
        this.onChange?.();
        return true;
    }

    /** Resolve a disambiguation choice. */
    selectOption(optionId: string): boolean {
        if (this.phase.phase !== 'disambiguating') return false;
        const opt = this.phase.options.find((o) => o.id === optionId);
        if (!opt) return false;
        return this.commit(opt.move);
    }

    /** Abandon an in-progress multi-step selection, back to target selection. */
    cancelSelection(): void {
        this.phase = { phase: 'selecting' };
        this.onChange?.();
    }

    private commit(move: MoveAction): boolean {
        const accepted = this.submit(move);
        // Whether or not the orchestrator accepted it, this selection is done.
        this.phase = { phase: 'selecting' };
        this.onChange?.();
        return accepted;
    }
}

// ============================================================================
// MoveAction -> target / category / label extractors.
// VERIFIED against the real possible-moves.ts shapes:
//   ring           place,  pieceToAdd ring,  move.station
//   base-post      replace, pieceToAdd basePost{toStation}        (NOTE: 'replace')
//   blocker move   replace, pieceToRemove blocker + pieceToAdd blocker{slotId}
//   arrow place    place,  pieceToAdd arrow{slotId}
//   arrow reverse  replace, pieceToRemove arrow + pieceToAdd arrow{slotId} (same slot)
//   arrow remove   remove, pieceToRemove arrow
//   blocker remove remove, pieceToRemove blocker
// Discriminate on the PIECE type, not move.type, because three distinct moves all use
// move.type === 'replace'. QUIRK A/B still affect WHICH of these appear in the legal
// set (center-ring placement; no-undo arrow removal) — resolve with Tony (PHASE2-NOTES #7).
// ============================================================================

export function primaryTarget(move: MoveAction): BoardTarget | null {
    const add = move.pieceToAdd;
    const remove = move.pieceToRemove;

    if (add) {
        if (add.type === 'ring') return move.station ? { kind: 'station', station: move.station } : null;
        if (add.type === 'basePost') return { kind: 'station', station: add.toStation };
        // arrow place or reverse, or blocker relocate — target the destination slot.
        if (add.type === 'arrow' || add.type === 'blocker') return { kind: 'slot', slotId: add.slotId };
    }
    if (remove) return { kind: 'slot', slotId: remove.slotId };
    if (move.station) return { kind: 'station', station: move.station };
    return null;
}

export function moveCategory(move: MoveAction): MoveCategory {
    const add = move.pieceToAdd;
    const remove = move.pieceToRemove;

    if (add?.type === 'ring') return 'ring';
    if (add?.type === 'basePost') return 'basePost';
    if (add?.type === 'arrow') return remove?.type === 'arrow' ? 'reverse' : 'arrow';
    if (add?.type === 'blocker') return 'blocker';
    if (move.type === 'remove' && remove) return 'remove';
    return 'other';
}

function disambigLabel(move: MoveAction): string {
    const add = move.pieceToAdd;
    if (add?.type === 'arrow') {
        const verb = move.pieceToRemove?.type === 'arrow' ? 'Reverse to' : 'Place';
        return `${verb} ${add.color === 'b' ? 'black' : 'white'} arrow ${add.fromStation}→${add.toStation}`;
    }
    if (add?.type === 'blocker') return 'Move blocker here';
    if (move.type === 'remove' && move.pieceToRemove) return `Remove ${move.pieceToRemove.type}`;
    return moveCategory(move);
}

function targetKey(t: BoardTarget): string {
    return t.kind === 'station' ? `station:${t.station}` : `slot:${t.slotId}`;
}
