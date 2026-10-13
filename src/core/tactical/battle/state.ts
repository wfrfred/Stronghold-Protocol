import type {
    BattlefieldChange,
    BattlefieldChangeResult,
    BattlefieldRemovalReason,
    BattlefieldView,
} from "../battlefield/contract.js";
import { transition, type State as BattlefieldState } from "../battlefield/state.js";
import { view } from "../battlefield/view.js";
import type { MechanismId, Mechanism } from "../battlefield/mechanism.js";
import type { Unit, Id } from "../unit/unit.js";
import {
    createActionExecutionState,
    type ActionExecutionState,
} from "../unit/capability/action/process.js";
import type { Event } from "./contract.js";
import type { BattleExecutionState } from "./execution/state.js";

const defaultExecution: BattleExecutionState = {
    rngState: 0,
    nextUnitId: 0,
    nextNavigationRequestId: 0,
    nextMechanismId: 0,
    nextNavigationModifierId: 0,
    nextProjectileId: 0,
};

export interface BattleState {
    readonly battlefield: BattlefieldState;
    readonly tick: number;
    readonly execution: BattleExecutionState;
    readonly actionExecutions: ActionExecutionState;
    readonly events: readonly Event[];
    readonly registeredUnitIds: readonly Id[];
    readonly removedUnits: BattlefieldChangeResult["removedUnits"];
    readonly closedLifetimes: ReadonlySet<string>;
}

export interface Result<A> {
    readonly state: BattleState;
    readonly value: A;
}

export function createBattleState(
    battlefield: BattlefieldState,
    execution: BattleExecutionState = defaultExecution,
    actionExecutions: ActionExecutionState = createActionExecutionState(),
    tick = 0,
): BattleState {
    return {
        battlefield,
        tick,
        execution,
        actionExecutions,
        events: [],
        registeredUnitIds: [],
        removedUnits: [],
        closedLifetimes: new Set(),
    };
}

export function advanceBattlefield(
    state: BattleState,
    changes: readonly BattlefieldChange[],
): BattleState {
    if (changes.length === 0) {
        return state;
    }

    const advanced = transition(state.battlefield, changes);
    const facts = advanced.facts;

    return {
        ...state,
        battlefield: advanced.state,
        registeredUnitIds: [...state.registeredUnitIds, ...facts.registeredUnitIds],
        removedUnits: [...state.removedUnits, ...facts.removedUnits],
        events: [
            ...state.events,
            ...facts.lostSupports.map((relation): Event => ({
                type: "SUPPORT_LOST",
                ...relation,
                tick: state.tick,
            })),
        ],
    };
}

export function battlefieldView(state: BattleState): BattlefieldView {
    return view(state.battlefield);
}

export function getUnit(state: BattleState, id: Id): Unit | undefined {
    return state.battlefield.units.get(id);
}

export function getMechanism(state: BattleState, id: MechanismId): Mechanism | undefined {
    return state.battlefield.mechanisms.get(id);
}

export function updateMechanism(state: BattleState, mechanism: Mechanism): BattleState {
    const current = getMechanism(state, mechanism.id);

    return current === mechanism
        ? state
        : advanceBattlefield(state, [
              {
                  type: current === undefined ? "REGISTER_MECHANISM" : "UPDATE_MECHANISM",
                  mechanism,
              },
          ]);
}

export function updateUnit(state: BattleState, unit: Unit): BattleState {
    return updateUnits(state, [unit]);
}

export function updateUnits(state: BattleState, units: readonly Unit[]): BattleState {
    const changes: BattlefieldChange[] = [];

    for (const unit of new Map(units.map((unit) => [unit.id, unit])).values()) {
        const current = getUnit(state, unit.id);

        if (current !== undefined && current !== unit) {
            changes.push({ type: "UPDATE_UNIT", unit });
        }
    }

    return advanceBattlefield(state, changes);
}

export function registerUnit(state: BattleState, unit: Unit): BattleState {
    return advanceBattlefield(state, [{ type: "REGISTER_UNIT", unit }]);
}

export function transitionUnit(
    state: BattleState,
    id: Id,
    transitionUnitState: (current: Unit) => Unit,
): BattleState {
    const current = getUnit(state, id);

    if (current === undefined) {
        return state;
    }

    const next = transitionUnitState(current);

    if (next.id !== id) {
        throw new TypeError("unit transition cannot change identity");
    }

    return updateUnit(state, next);
}

export function removeUnit(
    state: BattleState,
    id: Id,
    reason: BattlefieldRemovalReason = "DEATH",
): BattleState {
    return getUnit(state, id) === undefined
        ? state
        : advanceBattlefield(state, [{ type: "REMOVE_UNIT", unitId: id, reason }]);
}

export function appendEvents(state: BattleState, events: readonly Event[]): BattleState {
    return events.length === 0 ? state : { ...state, events: [...state.events, ...events] };
}
