import type { BattlefieldRemovalReason, BattlefieldView } from "../battlefield/contract.js";
import * as battlefield from "../battlefield/state.js";
import type { State as BattlefieldState } from "../battlefield/state.js";
import { view } from "../battlefield/view.js";
import { ref as mechanismRef, type MechanismId, type Mechanism } from "../battlefield/mechanism.js";
import { getLostSupports } from "../battlefield/support/relations.js";
import type { Unit, Id } from "../unit/unit.js";
import { ref } from "../unit/query.js";
import type { Event, UnitRemoval, Result as BattleResult } from "./contract.js";
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
    nextMechanismId: 0,
    nextOverlayId: 0,
    nextProjectileId: 0,
};

export interface State {
    readonly battlefield: BattlefieldState;
    readonly tick: number;
    readonly execution: BattleExecutionState;
    readonly deployment: DeploymentState;
    readonly schedule: SpawnScheduleExecution;
    readonly predefinedPresence: readonly PredefinedPresence[];
    readonly completedRouteCount: number;
    readonly result: BattleResult | null;
    readonly events: readonly Event[];
    readonly removedUnits: readonly UnitRemoval[];
    readonly closedLifetimes: ReadonlySet<string>;
}

export interface Result<A> {
    readonly state: State;
    readonly value: A;
}

export function createBattleState(
    battlefield: BattlefieldState,
    execution: BattleExecutionState = defaultExecution,
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

export function setBattlefield(state: State, next: BattlefieldState): State {
    if (next === state.battlefield) {
        return state;
    }

    const lostSupports = getLostSupports(
        state.battlefield.supportRelations,
        next.supportRelations,
        next.units,
    );

    return appendEvents(
        { ...state, battlefield: next },
        lostSupports.map((relation): Event => ({
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
        : setBattlefield(
              state,
              current === undefined
                  ? battlefield.addMechanism(state.battlefield, mechanism)
                  : battlefield.replaceMechanism(state.battlefield, mechanism),
          );
}

export function removeMechanism(state: State, id: MechanismId): State {
    const mechanism = getMechanism(state, id);

    return mechanism === undefined
        ? state
        : setBattlefield(
              state,
              battlefield.removeMechanism(state.battlefield, mechanismRef(mechanism)),
          );
}

/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- Accept capability-bearing object literals while returning only State. */
export function updateUnit<U extends Unit>(state: State, unit: U): State {
    return updateUnits(state, [unit]);
}

export function updateUnits<U extends Unit>(state: State, units: readonly U[]): State {
    const replacements: U[] = [];

    for (const unit of new Map(units.map((unit) => [unit.id, unit])).values()) {
        const current = getUnit(state, unit.id);

        if (current !== undefined && current !== unit) {
            replacements.push(unit);
        }
    }

    return setBattlefield(state, battlefield.replaceUnits(state.battlefield, replacements));
}

export function registerUnit<U extends Unit>(state: State, unit: U): State {
    return setBattlefield(state, battlefield.addUnit(state.battlefield, unit));
}

export function registerUnits<U extends Unit>(state: State, units: readonly U[]): State {
    return setBattlefield(state, battlefield.addUnits(state.battlefield, units));
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
    const unit = getUnit(state, id);

    if (unit === undefined) {
        return state;
    }

    const next = setBattlefield(state, battlefield.removeUnit(state.battlefield, ref(unit)));

    return { ...next, removedUnits: [...next.removedUnits, { unitId: id, reason, unit }] };
}

export function appendEvents(state: State, events: readonly Event[]): State {
    return events.length === 0 ? state : { ...state, events: [...state.events, ...events] };
}
