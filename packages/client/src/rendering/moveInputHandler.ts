// Turns board interactions into legal MoveActions and hands the finished
// move to the LocalHumanAgent. It NEVER calls applyMove or mutates state; it only
// produces move intents drawn from possibleMoves().
//
// Two things are deliberately injected/isolated because they depend on details this
// module shouldn't own:
//   - getLegalMoves: defaults to possibleMoves() but is injectable for unit tests.
//   - primaryTarget / moveCategory / disambig: extract a "what did you click" target
//     and secondary options FROM a MoveAction. These MUST be reconciled with the real
//     possibleMoves() output shapes.

import {
    legalMoves,
    slotName,
    type ArrowColor,
    type FinityGameState,
    type GamePiece,
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
    | { phase: 'disambiguating'; target: BoardTarget; options: DisambigOption[] }
    /** A blocker has been picked up - a ghost follows the pointer and a click drops it */
    | { phase: 'carrying'; from: number; destinations: number[]; hover: number | null }
    /** An empty slot with arrow placements was clicked. Ghost arrow points toward whichever of the slot's stations
     * the pointer is nearer
     */
    | {
        phase: 'aiming';
        slotId: number;
        stations: [StationName, StationName];
        arrows: MoveAction[];
        others: DisambigOption[];
        color: ArrowColor;
        toward: StationName | null;
    }

export interface MoveInputHandlerOptions {
    /** Called with a completed move. Bind to LocalHumanAgent.submitMove. Returns whether
     *  the orchestrator accepted it (i.e. a human turn was actually awaiting). */
    submit: (move: MoveAction) => boolean;
    /** Defaults to the engine's legalMoves; injectable for tests. */
    getLegalMoves?: (state: FinityGameState, color: PlayerColor) => MoveAction[];
    /** Notified whenever the phase or available targets change, so the UI can redraw. */
    onChange?: () => void;
}

export class MoveInputHandler {
    private state: FinityGameState | null = null;
    private legal: MoveAction[] = [];
    private categoryFilter: MoveCategory | null = null;
    private arrowColorFilter: ArrowColor | null = null;
    private phase: InputPhase = { phase: 'selecting' };

    private readonly submit: (move: MoveAction) => boolean;
    private readonly getLegalMoves: (state: FinityGameState, color: PlayerColor) => MoveAction[];
    private readonly onChange?: () => void;

    constructor(opts: MoveInputHandlerOptions) {
        this.submit = opts.submit;
        this.getLegalMoves = opts.getLegalMoves ?? legalMoves;
        this.onChange = opts.onChange;
    }

    /** Call at the start of each local-human turn (and whenever state changes). */
    refresh(state: FinityGameState, color: PlayerColor): void {
        this.state = state;
        this.legal = this.getLegalMoves(state, color);
        this.categoryFilter = null;
        this.arrowColorFilter = null;
        this.phase = { phase: 'selecting' };
        this.onChange?.();
    }

    /** Clear selection input (no active turn). */
    clear(): void {
        this.state = null;
        this.legal = [];
        this.categoryFilter = null;
        this.arrowColorFilter = null;
        this.phase = { phase: 'selecting' };
        this.onChange?.();
    }

    getPhase(): InputPhase {
        return this.phase;
    }

    /** Optional move-type pre-filter (mirrors the old HumanControlPanel dropdown). */
    setCategoryFilter(cat: MoveCategory | null, opts?: { arrowColor?: ArrowColor | null }): void {
        this.categoryFilter = cat;
        this.arrowColorFilter = opts?.arrowColor ?? null;
        this.phase = { phase: 'selecting' };
        this.onChange?.();
    }

    getCategoryFilter(): MoveCategory | null {
        return this.categoryFilter;
    }

    getArrowColorFilter(): ArrowColor | null {
        return this.arrowColorFilter;
    }

    private filteredLegal(): MoveAction[] {
        if (!this.categoryFilter) return this.legal;
        return this.legal.filter((m) => {
            if (moveCategory(m) !== this.categoryFilter) return false;
            if (this.categoryFilter === 'arrow' && this.arrowColorFilter) {
                return m.pieceToAdd?.type === 'arrow' &&
                    m.pieceToAdd.color === this.arrowColorFilter;
            }
            return true;
        });
    }

    /** Targets the player may click right now — used to highlight the board. */
    selectableTargets(): BoardTarget[] {
        const phase = this.phase;
        if (phase.phase === 'carrying') {
            return [...phase.destinations, phase.from].map((slotId) => ({ kind: 'slot', slotId }));
        }
        if (phase.phase === 'aiming') {
            return [{ kind: 'slot', slotId: phase.slotId }];
        }

        const seen = new Set<string>();
        const out: BoardTarget[] = [];
        const add = (t: BoardTarget) => {
            const k = targetKey(t);
            if (!seen.has(k)) {
                seen.add(k);
                out.push(t);
            }
        };

        for (const m of this.filteredLegal()) {
            const t = primaryTarget(m);
            if (t) add(t);
        }

        // Your own blockers that can move are clickable too
        for (const slotId of this.pickUpSlots()) add({ kind: 'slot', slotId });
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
        const phase = this.phase;

        if (phase.phase === 'carrying') {
            if (target.kind !== 'slot') return false;
            if (target.slotId === phase.from) {
                this.cancelSelection();
                return true;
            }
            const move = this.blockerMove(phase.from, target.slotId);
            return move ? this.commit(move) : false;
        }

        // while aiming, a click places the aimed arrow; a click on some other
        // target is ignored rather than guessed at
        if (phase.phase === 'aiming') return false;

        // clicking one of your own movable blockers picks it up
        if (target.kind === 'slot' && this.pickUpSlots().includes(target.slotId)) {
            const destinations = this.filteredLegal()
                .filter((m) => isBlockerMove(m) && m.pieceToRemove!.slotId === target.slotId)
                .map((m) => (m.pieceToAdd as { slotId: number }).slotId);
            this.phase = { phase: 'carrying', from: target.slotId, destinations, hover: null };
            this.onChange?.();
            return true;
        }

        const k = targetKey(target);
        const candidates = this.filteredLegal().filter((m) => {
            const t = primaryTarget(m);
            return t != null && targetKey(t) === k;
        });

        if (candidates.length === 0) return false;

        // arrow placements are. aimed with the pointer instead of chosen from direction buttons
        const arrows = candidates.filter(isArrowPlacement);
        if (arrows.length > 0 && target.kind === 'slot' && (arrows.length > 1 || candidates.length > 1)) {
            const first = arrows[0].pieceToAdd as { fromStation: StationName; toStation: StationName };
            const colors = [...new Set(arrows.map((m) => (m.pieceToAdd as { color: ArrowColor }).color))];
            const color = this.arrowColorFilter && colors.includes(this.arrowColorFilter)
                ? this.arrowColorFilter
                : colors[0];
            const others = candidates.filter((m) => !isArrowPlacement(m));
            this.phase = {
                phase: 'aiming',
                slotId: target.slotId,
                stations: [first.fromStation, first.toStation],
                arrows,
                others: others.map((move, i) => ({ id: `opt-${i}`, label: disambigLabel(move), move })),
                color,
                toward: null,
            };
            this.onChange?.();

            return true;
        }

        if (candidates.length === 1) return this.commit(candidates[0]);

        this.phase = {
            phase: 'disambiguating',
            target,
            options: candidates.map((move, i) => ({
                id: `opt-${i}`,
                label: disambigLabel(move),
                move
            })),
        };
        this.onChange?.();
        return true;
    }

    // --------------------- Carrying a blocker -----------------------------------------

    /** slots holding one of the current player's blockers that has somewhere to go */
    private pickUpSlots(): number[] {
        const out = new Set<number>();
        for (const m of this.filteredLegal()) {
            if (isBlockerMove(m)) out.add(m.pieceToRemove!.slotId);
        }

        return [...out];
    }

    private blockerMove(from: number, to: number): MoveAction | undefined {
        return this.filteredLegal().find(
            (m) => isBlockerMove(m) && m.pieceToRemove!.slotId === from
                && (m.pieceToAdd as { slotId: number }).slotId === to,
        );
    }

    /** Pointer moved while carrying: the ghost sits on this target if it is a destination. */
    hoverTarget(target: BoardTarget | null): void {
        const phase = this.phase;
        if (phase.phase !== 'carrying') return;
        const hover = target?.kind === 'slot' && phase.destinations.includes(target.slotId)
            ? target.slotId
            : null;
        if (hover === phase.hover) return;
        this.phase = { ...phase, hover };
        this.onChange?.();
    }

    // ---- aiming an arrow ------------------------------------------------------

    /** Point the arrow toward one of the slot's two stations (the one nearer the pointer). */
    aimToward(station: StationName): void {
        const phase = this.phase;
        if (phase.phase !== 'aiming' || phase.toward === station) return;
        if (!phase.stations.includes(station)) return;
        this.phase = { ...phase, toward: station };
        this.onChange?.();
    }

    /** Colours available for the aimed arrow at this slot. */
    aimColors(): ArrowColor[] {
        const phase = this.phase;
        if (phase.phase !== 'aiming') return [];
        return [...new Set(phase.arrows.map((m) => (m.pieceToAdd as { color: ArrowColor }).color))];
    }

    setAimColor(color: ArrowColor): void {
        const phase = this.phase;
        if (phase.phase !== 'aiming' || phase.color === color) return;
        if (!this.aimColors().includes(color)) return;
        this.phase = { ...phase, color };
        this.onChange?.();
    }

    /** The arrow placement currently aimed, or null if the pointer has not picked a side. */
    aimedMove(): MoveAction | null {
        const phase = this.phase;
        if (phase.phase !== 'aiming') return null;
        const ofColor = phase.arrows.filter((m) => (m.pieceToAdd as { color: ArrowColor }).color === phase.color);
        if (phase.toward) {
            return ofColor.find((m) => (m.pieceToAdd as { toStation: StationName }).toStation === phase.toward) ?? null;
        }
        // Only one direction is legal in this colour: no need to aim.
        return ofColor.length === 1 ? ofColor[0] : null;
    }

    /** Place the aimed arrow. */
    confirmAim(): boolean {
        const move = this.aimedMove();
        return move ? this.commit(move) : false;
    }

    /** Resolve one of the non-arrow options offered while aiming. */
    selectAimOption(optionId: string): boolean {
        const phase = this.phase;
        if (phase.phase !== 'aiming') return false;
        const opt = phase.others.find((o) => o.id === optionId);
        return opt ? this.commit(opt.move) : false;
    }

    // ---- ghost preview --------------------------------------------------------

    /** The piece to draw as a ghost: a carried blocker on its hover slot, or the aimed arrow. */
    preview(): GamePiece | null {
        const phase = this.phase;
        if (phase.phase === 'carrying' && phase.hover !== null) {
            const move = this.blockerMove(phase.from, phase.hover);
            return (move?.pieceToAdd as GamePiece | undefined) ?? null;
        }
        if (phase.phase === 'aiming') {
            return (this.aimedMove()?.pieceToAdd as GamePiece | undefined) ?? null;
        }
        return null;
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
    if (add?.type === 'blocker') {
        // each player has two blockers, and often both can reach the same slot
        const from = move.pieceToRemove?.type === 'blocker' ? move.pieceToRemove.slotId : undefined;
        return from !== undefined ? `Move blocker from ${slotName(from)} here` : 'Move blocker here';
    }

    if (move.type === 'remove' && move.pieceToRemove) return `Remove ${move.pieceToRemove.type}`;
    return moveCategory(move);
}

function targetKey(t: BoardTarget): string {
    return t.kind === 'station' ? `station:${t.station}` : `slot:${t.slotId}`;
}

function isBlockerMove(m: MoveAction): boolean {
    return m.pieceToAdd?.type === 'blocker' && m.pieceToRemove?.type === 'blocker';
}

function isArrowPlacement(m: MoveAction): boolean {
    return m.type === 'place' && m.pieceToAdd?.type === 'arrow';
}
