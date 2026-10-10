import type {
    Battlefield,
    BattlefieldChange,
    BattlefieldChangeResult,
    BattlefieldRemovalReason,
    BattlefieldView,
} from "../../battlefield/contract.js";
import type { MechanismId, MechanismRuntime } from "../../battlefield/mechanism.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import type { ActionExecutionWork } from "../../unit/capability/action/internal/executions.js";
import type { Event } from "../contract.js";
import type { BattleExecutionState } from "./state.js";

const defaultExecution: BattleExecutionState = Object.freeze({
    rngState: 0,
    nextUnitId: 0,
    nextNavigationRequestId: 0,
    nextMechanismId: 0,
    nextNavigationModifierId: 0,
    nextProjectileId: 0,
});

/** The working state of a synchronous battle settlement. */
export interface BattleState {
    readonly battlefield: Battlefield;
    readonly tick: number;
    execution: BattleExecutionState;
    actionExecutions?: ActionExecutionWork;
    readonly events: Event[];
    readonly registeredUnitIds: UnitId[];
    readonly removedUnits: BattlefieldChangeResult["removedUnits"][number][];
}

export function createBattleState(
    battlefield: Battlefield,
    execution: BattleExecutionState = defaultExecution,
    actionExecutions?: ActionExecutionWork,
    tick = 0,
): BattleState {
    return {
        battlefield,
        tick,
        execution,
        events: [],
        registeredUnitIds: [],
        removedUnits: [],
        ...(actionExecutions === undefined ? {} : { actionExecutions }),
    };
}

export function advanceBattlefield(
    state: BattleState,
    changes: readonly BattlefieldChange[],
): void {
    if (changes.length === 0) {
        return;
    }

    const facts = state.battlefield.advance(changes);
    state.registeredUnitIds.push(...facts.registeredUnitIds);
    state.removedUnits.push(...facts.removedUnits);
    state.events.push(
        ...facts.lostSupports.map((relation): Event => ({
            type: "SUPPORT_LOST",
            ...relation,
            tick: state.tick,
        })),
    );
}

export function battlefieldView(state: BattleState): BattlefieldView {
    return state.battlefield.snapshot("draft");
}

export function getUnit(state: BattleState, id: UnitId): Unit | undefined {
    return battlefieldView(state).getUnit(id);
}

export function getMechanism(state: BattleState, id: MechanismId): MechanismRuntime | undefined {
    return battlefieldView(state).getMechanism(id);
}

export function updateMechanism(state: BattleState, mechanism: MechanismRuntime): void {
    const current = getMechanism(state, mechanism.id);

    if (current !== mechanism) {
        advanceBattlefield(state, [
            { type: current === undefined ? "REGISTER_MECHANISM" : "UPDATE_MECHANISM", mechanism },
        ]);
    }
}

export function updateUnit(state: BattleState, unit: Unit): void {
    updateUnits(state, [unit]);
}

export function updateUnits(state: BattleState, units: readonly Unit[]): void {
    const changes: BattlefieldChange[] = [];

    for (const unit of new Map(units.map((unit) => [unit.id, unit])).values()) {
        const current = getUnit(state, unit.id);

        if (current !== unit) {
            changes.push({ type: current === undefined ? "REGISTER_UNIT" : "UPDATE_UNIT", unit });
        }
    }

    advanceBattlefield(state, changes);
}

export function registerUnit(state: BattleState, unit: Unit): void {
    advanceBattlefield(state, [{ type: "REGISTER_UNIT", unit }]);
}

export function transitionUnit(
    state: BattleState,
    id: UnitId,
    transition: (current: Unit) => Unit,
): void {
    const current = getUnit(state, id);

    if (current === undefined) {
        return;
    }

    const next = transition(current);

    if (next.id !== id) {
        throw new TypeError("unit transition cannot change identity");
    }

    updateUnit(state, next);
}

/** Physically removes a unit after the domain has settled its lifecycle. */
export function removeUnit(
    state: BattleState,
    id: UnitId,
    reason: BattlefieldRemovalReason = "DEATH",
): void {
    if (getUnit(state, id) !== undefined) {
        advanceBattlefield(state, [{ type: "REMOVE_UNIT", unitId: id, reason }]);
    }
}

export function appendEvents(state: BattleState, events: readonly Event[]): void {
    state.events.push(...events);
}
