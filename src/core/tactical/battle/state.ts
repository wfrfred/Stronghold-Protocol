import type { BattlefieldRemovalReason, BattlefieldView } from "../battlefield/contract.js";
import * as battlefield from "../battlefield/state.js";
import type { State as BattlefieldState } from "../battlefield/state.js";
import { view } from "../battlefield/view.js";
import { assertNonnegativeSafeInteger } from "../../common/assert.js";
import type { MechanismId, Mechanism } from "./mechanism.js";
import * as support from "../battlefield/support.js";
import type { Unit, Id } from "../unit/unit.js";
import { ref } from "../unit/query.js";
import * as dependency from "../unit/effect/dependency.js";
import * as blocking from "./blocking/operations.js";
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
    readonly mechanisms: ReadonlyMap<MechanismId, Mechanism>;
    readonly tick: number;
    readonly execution: BattleExecutionState;
    readonly deployment: DeploymentState;
    readonly effect: {
        readonly dependency: dependency.State;
    };
    readonly schedule: SpawnScheduleExecution;
    readonly predefinedPresence: readonly PredefinedPresence[];
    readonly completedRouteCount: number;
    readonly result: BattleResult | null;
    readonly events: readonly Event[];
    readonly removedUnits: readonly UnitRemoval[];
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
        mechanisms: new Map<MechanismId, Mechanism>(),
        tick,
        execution,
        deployment,
        effect: { dependency: dependency.project(battlefield.units.values()) },
        schedule,
        predefinedPresence: [],
        completedRouteCount: 0,
        result: null,
        events: [],
        removedUnits: [],
    };
}

export function setBattlefield(state: State, next: BattlefieldState): State {
    const updated = publishBattlefield(state, next);

    return notifyLostSupports(updated.state, updated.value);
}

function publishBattlefield(
    state: State,
    next: BattlefieldState,
    transitions?: readonly dependency.UnitTransition[],
): Result<readonly support.Relation[]> {
    if (next === state.battlefield) {
        return { state, value: [] };
    }

    const lostSupports = support.lost(state.battlefield, next);
    const nextDependency =
        state.battlefield.units === next.units
            ? state.effect.dependency
            : dependency.derive(
                  state.effect.dependency,
                  transitions ?? effectTransitions(state.battlefield, next),
              );

    return {
        state: appendEvents(
            {
                ...state,
                battlefield: next,
                effect:
                    nextDependency === state.effect.dependency
                        ? state.effect
                        : { ...state.effect, dependency: nextDependency },
            },
            lostSupports.map((relation): Event => ({
                type: "SUPPORT_LOST",
                supportedUnitId: relation.occupant.id,
                supportUnitId: relation.support.id,
                tick: state.tick,
            })),
        ),
        value: lostSupports,
    };
}

function effectTransitions(
    previous: BattlefieldState,
    next: BattlefieldState,
): readonly dependency.UnitTransition[] {
    const transitions: dependency.UnitTransition[] = [];

    for (const unit of previous.units.values()) {
        const current = next.units.get(unit.id);

        if (unit.effects !== current?.effects) {
            transitions.push({ previousUnit: unit, nextUnit: current });
        }
    }
    for (const unit of next.units.values()) {
        if (!previous.units.has(unit.id)) {
            transitions.push({ previousUnit: undefined, nextUnit: unit });
        }
    }

    return transitions;
}

function notifyLostSupports(state: State, lostSupports: readonly support.Relation[]): State {
    for (const relation of lostSupports) {
        state =
            relation.support.definition.tileBinding.onSupportLost?.(state, relation.support, {
                tile: relation.tile,
                occupant: ref(relation.occupant),
            }) ?? state;
    }

    return state;
}

export function battlefieldView(state: State): BattlefieldView {
    return view(state.battlefield);
}

export function getUnit(state: State, id: Id): Unit | undefined {
    return state.battlefield.units.get(id);
}

export function getMechanism(state: State, id: MechanismId): Mechanism | undefined {
    return state.mechanisms.get(id);
}

export function updateMechanism(state: State, mechanism: Mechanism): State {
    const current = getMechanism(state, mechanism.id);

    if (current === mechanism) {
        return state;
    }

    assertNonnegativeSafeInteger(mechanism.id, "mechanism id");

    if (current !== undefined && current.definition !== mechanism.definition) {
        throw new RangeError("mechanism definition cannot change during update");
    }

    const mechanisms = new Map(state.mechanisms);
    mechanisms.set(mechanism.id, mechanism);

    return { ...state, mechanisms };
}

export function removeMechanism(state: State, id: MechanismId): State {
    if (!state.mechanisms.has(id)) {
        return state;
    }

    const mechanisms = new Map(state.mechanisms);
    mechanisms.delete(id);

    return { ...state, mechanisms };
}

/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- Accept capability-bearing object literals while returning only State. */
export function updateUnit<U extends Unit>(state: State, unit: U): State {
    const previous = getUnit(state, unit.id);

    if (previous === undefined || previous === unit) {
        return state;
    }

    const updated = publishBattlefield(state, battlefield.replaceUnit(state.battlefield, unit), [
        { previousUnit: previous, nextUnit: unit },
    ]);
    const synchronized = blocking.synchronize(updated.state, previous, unit);
    state = synchronized.state;

    if (synchronized.value !== undefined) {
        state = blocking.notify(state, synchronized.value);
    }

    return blocking.maintain(notifyLostSupports(state, updated.value));
}

export function registerUnit<U extends Unit>(state: State, unit: U): State {
    const updated = publishBattlefield(state, battlefield.addUnit(state.battlefield, unit), [
        { previousUnit: undefined, nextUnit: unit },
    ]);

    return blocking.maintain(notifyLostSupports(updated.state, updated.value));
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
    let unit = getUnit(state, id);

    if (unit === undefined) {
        return state;
    }

    if (unit.lifecycle !== "LEAVING") {
        state = updateUnit(state, { ...unit, lifecycle: "LEAVING" });
        unit = getUnit(state, id);

        if (unit === undefined) {
            return state;
        }
    }

    const updated = publishBattlefield(
        state,
        battlefield.removeUnit(state.battlefield, ref(unit)),
        [{ previousUnit: unit, nextUnit: undefined }],
    );
    const next = notifyLostSupports(updated.state, updated.value);

    return blocking.maintain({
        ...next,
        removedUnits: [...next.removedUnits, { unitId: id, reason, unit }],
    });
}

export function appendEvents(state: State, events: readonly Event[]): State {
    return events.length === 0 ? state : { ...state, events: [...state.events, ...events] };
}
