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
import { Actions } from "../unit/action/actions.js";
import type { Event, Result as BattleResult } from "./contract.js";
import type { BattleExecutionState } from "./execution/state.js";
import type { PredefinedPresence } from "./steps/predefined.js";
import { createSpawnScheduleDefinition } from "./schedule/definition.js";
import { createSpawnScheduleExecution, type SpawnScheduleExecution } from "./schedule/state.js";
import {
    initialize as initializeDeployment,
    type State as DeploymentState,
} from "./deployment/deployment.js";

const defaultExecution: BattleExecutionState = {
    rngState: 0,
    nextCardId: 0,
    nextUnitId: 0,
    nextNavigationRequestId: 0,
    nextMechanismId: 0,
    nextNavigationModifierId: 0,
    nextProjectileId: 0,
};

export interface State {
    readonly battlefield: BattlefieldState;
    readonly tick: number;
    readonly execution: BattleExecutionState;
    readonly actions: Actions;
    readonly deployment: DeploymentState;
    readonly schedule: SpawnScheduleExecution;
    readonly predefinedPresence: readonly PredefinedPresence[];
    readonly completedRouteCount: number;
    readonly result: BattleResult | null;
    readonly events: readonly Event[];
    readonly removedUnits: BattlefieldChangeResult["removedUnits"];
    readonly closedLifetimes: ReadonlySet<string>;
}

export interface Result<A> {
    readonly state: State;
    readonly value: A;
}

export function createBattleState(
    battlefield: BattlefieldState,
    execution: BattleExecutionState = defaultExecution,
    actions: Actions = Actions.empty(),
    tick = 0,
    deployment: DeploymentState = initializeDeployment(),
    schedule: SpawnScheduleExecution = createSpawnScheduleExecution(
        createSpawnScheduleDefinition({ type: "TIMELINE", spawns: [] }),
    ),
): State {
    return {
        battlefield,
        tick,
        execution,
        actions,
        deployment,
        schedule,
        predefinedPresence: [],
        completedRouteCount: 0,
        result: null,
        events: [],
        removedUnits: [],
        closedLifetimes: new Set(),
    };
}

export function advanceBattlefield(state: State, changes: readonly BattlefieldChange[]): State {
    if (changes.length === 0) {
        return state;
    }

    const advanced = transition(state.battlefield, changes);
    const facts = advanced.facts;

    const next = {
        ...state,
        battlefield: advanced.state,
        removedUnits: [...state.removedUnits, ...facts.removedUnits],
    };

    return appendEvents(
        next,
        facts.lostSupports.map((relation): Event => ({
            type: "SUPPORT_LOST",
            ...relation,
            tick: state.tick,
        })),
    );
}

export function battlefieldView(state: State): BattlefieldView {
    return view(state.battlefield);
}

export function getUnit(state: State, id: Id): Unit | undefined {
    return state.battlefield.units.get(id);
}

export function getMechanism(state: State, id: MechanismId): Mechanism | undefined {
    return state.battlefield.mechanisms.get(id);
}

export function updateMechanism(state: State, mechanism: Mechanism): State {
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

/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- Accept capability-bearing object literals while returning only State. */
export function updateUnit<U extends Unit>(state: State, unit: U): State {
    return updateUnits(state, [unit]);
}

export function updateUnits<U extends Unit>(state: State, units: readonly U[]): State {
    const changes: BattlefieldChange[] = [];

    for (const unit of new Map(units.map((unit) => [unit.id, unit])).values()) {
        const current = getUnit(state, unit.id);

        if (current !== undefined && current !== unit) {
            changes.push({ type: "UPDATE_UNIT", unit });
        }
    }

    return advanceBattlefield(state, changes);
}

export function registerUnit<U extends Unit>(state: State, unit: U): State {
    return advanceBattlefield(state, [{ type: "REGISTER_UNIT", unit }]);
}
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */

export function transitionUnit(
    state: State,
    id: Id,
    transitionUnitState: (current: Unit) => Unit,
): State {
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
    state: State,
    id: Id,
    reason: BattlefieldRemovalReason = "DEATH",
): State {
    return getUnit(state, id) === undefined
        ? state
        : advanceBattlefield(state, [{ type: "REMOVE_UNIT", unitId: id, reason }]);
}

export function appendEvents(state: State, events: readonly Event[]): State {
    return events.length === 0 ? state : { ...state, events: [...state.events, ...events] };
}
