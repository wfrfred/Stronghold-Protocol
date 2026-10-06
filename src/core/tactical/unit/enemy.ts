import { createRng, type Seed } from "../../common/rng.js";
import type { NavigationRequestId } from "../navigation/request.js";
import type { NavigationOutcome } from "../navigation/state.js";
import type { RouteDefinition } from "../route/definition.js";
import { createRouteExecution } from "../route/execution.js";
import { initializeRouteSpawn } from "../route/spawn.js";
import type { RouteTiming } from "../route/state.js";
import { initializeRouteControl, type LocatedRouteSignal } from "./locomotion/route-control.js";
import {
    createRoutedLocomotionState,
    type Locomotion,
    type LocomotiveUnitDefinition,
    type RoutedLocomotion,
} from "./locomotion/state.js";
import { stepRoutedUnit, type RoutedLocomotionStepContext } from "./locomotion/step.js";
import type { SpatialPresence } from "./presence.js";
import type { Unit, UnitId } from "./unit.js";
import type { Vitality, VitalUnitDefinition } from "./vitality.js";

export interface EnemyDefinition extends VitalUnitDefinition, LocomotiveUnitDefinition {}

export type Enemy = Unit<EnemyDefinition> & Vitality & Locomotion;

export type RoutedEnemy = Enemy & RoutedLocomotion & SpatialPresence;

export interface RoutedEnemySpawn {
    readonly id: UnitId;
    readonly tick: number;
    readonly definition: EnemyDefinition;
    readonly route: RouteDefinition;
    readonly timing: RouteTiming;
    readonly alwaysCheckCurrentPoint: boolean;
    readonly rngState: Seed;
    readonly nextNavigationRequestId: NavigationRequestId;
}

export interface RoutedEnemyInitialization {
    readonly enemy: RoutedEnemy;
    readonly signals: readonly LocatedRouteSignal[];
    readonly rngState: Seed;
    readonly nextNavigationRequestId: NavigationRequestId;
}

export type RoutedEnemyStepContext = RoutedLocomotionStepContext;

export interface RoutedEnemyStep {
    readonly enemy: RoutedEnemy;
    readonly signals: readonly LocatedRouteSignal[];
    readonly rngState: Seed;
    readonly nextNavigationRequestId: NavigationRequestId;
    readonly outcomes: readonly NavigationOutcome[];
}

export function createEnemyDefinition(definition: EnemyDefinition): EnemyDefinition {
    if (typeof definition.id !== "string" || definition.id.length === 0) {
        throw new TypeError("enemy definition id must be nonempty");
    }
    if (!Number.isFinite(definition.vitality.maxHp) || definition.vitality.maxHp <= 0) {
        throw new RangeError("enemy maxHp must be finite and positive");
    }
    if (
        !Number.isFinite(definition.locomotion.moveSpeedPerTick) ||
        definition.locomotion.moveSpeedPerTick < 0
    ) {
        throw new RangeError("enemy moveSpeedPerTick must be finite and non-negative");
    }

    return Object.freeze({
        id: definition.id,
        vitality: Object.freeze({ maxHp: definition.vitality.maxHp }),
        locomotion: Object.freeze({
            moveSpeedPerTick: definition.locomotion.moveSpeedPerTick,
            steeringParameters: Object.freeze({ ...definition.locomotion.steeringParameters }),
        }),
    });
}

export function initializeRoutedEnemy(spawn: RoutedEnemySpawn): RoutedEnemyInitialization {
    if (!Number.isSafeInteger(spawn.id) || spawn.id < 0) {
        throw new RangeError("enemy id must be a nonnegative safe integer");
    }

    const rng = createRng(spawn.rngState);
    const location = initializeRouteSpawn(spawn.route, rng);
    const execution = createRouteExecution(rng, spawn.nextNavigationRequestId, spawn.tick);
    const initial = initializeRouteControl(
        spawn.route,
        spawn.timing,
        spawn.alwaysCheckCurrentPoint,
        location.locatorOffset,
        location.position,
        execution,
    );

    return {
        enemy: {
            id: spawn.id,
            definition: spawn.definition,
            position: initial.position,
            spatialPresence: { present: initial.present },
            vitality: { hp: spawn.definition.vitality.maxHp },
            locomotion: createRoutedLocomotionState(
                initial.control.route,
                initial.control.navigation,
            ),
        },
        signals: initial.signals,
        ...execution.state(),
    };
}

export function stepRoutedEnemy(
    enemy: RoutedEnemy,
    context: RoutedEnemyStepContext,
): RoutedEnemyStep {
    const step = stepRoutedUnit(enemy, context);

    return {
        enemy: step.unit,
        signals: step.signals,
        rngState: step.rngState,
        nextNavigationRequestId: step.nextNavigationRequestId,
        outcomes: step.outcomes,
    };
}
