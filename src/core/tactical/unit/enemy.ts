import { createRng } from "../../common/rng.js";
import type { Seed } from "../../common/rng.js";
import type { NavigationRequestId } from "../navigation/request.js";
import { createNavigationState, startNavigationRequest } from "../navigation/state.js";
import type { NavigationOutcome } from "../navigation/state.js";
import type { RouteDefinition } from "../route/definition.js";
import { createRouteExecution, enterRoute, validateRouteExecution } from "../route/execution.js";
import { initializeRouteSpawn } from "../route/spawn.js";
import { createRouteState } from "../route/state.js";
import type { RouteTiming } from "../route/state.js";
import { createRoutedLocomotionState } from "./locomotion/state.js";
import type { Locomotion, LocomotiveUnitDefinition, RoutedLocomotion } from "./locomotion/state.js";
import { stepRoutedUnit } from "./locomotion/step.js";
import type { RoutedLocomotionStepContext } from "./locomotion/step.js";
import type { Vitality, VitalUnitDefinition } from "./vitality.js";
import type { Unit, UnitId } from "./unit.js";

export interface EnemyDefinition
    extends VitalUnitDefinition,
    LocomotiveUnitDefinition {
}

export type Enemy =
    Unit<EnemyDefinition>
    & Vitality
    & Locomotion;

export type RoutedEnemy = Enemy & RoutedLocomotion;

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
    readonly rngState: Seed;
    readonly nextNavigationRequestId: NavigationRequestId;
}

export type RoutedEnemyStepContext = RoutedLocomotionStepContext;

export interface RoutedEnemyStep {
    readonly enemy: RoutedEnemy;
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
    if (!Number.isFinite(definition.locomotion.moveSpeedPerTick) || definition.locomotion.moveSpeedPerTick < 0) {
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
    validateRouteExecution(spawn.route, spawn.alwaysCheckCurrentPoint);
    const rng = createRng(spawn.rngState);
    const location = initializeRouteSpawn(spawn.route, rng);
    const execution = createRouteExecution(rng, spawn.nextNavigationRequestId, spawn.tick);
    const initial = enterRoute(createRouteState(spawn.route, spawn.timing, spawn.alwaysCheckCurrentPoint), execution);
    const navigation = createNavigationState(spawn.route.pathMotionMode, location.locatorOffset);
    return {
        enemy: {
            id: spawn.id,
            definition: spawn.definition,
            position: location.position,
            vitality: { hp: spawn.definition.vitality.maxHp },
            locomotion: createRoutedLocomotionState(
                initial.state,
                initial.request === undefined ? navigation : startNavigationRequest(navigation, initial.request),
            ),
        },
        ...execution.state(),
    };
}

export function stepRoutedEnemy(enemy: RoutedEnemy, context: RoutedEnemyStepContext): RoutedEnemyStep {
    const step = stepRoutedUnit(enemy, context);
    return {
        enemy: step.unit,
        rngState: step.rngState,
        nextNavigationRequestId: step.nextNavigationRequestId,
        outcomes: step.outcomes,
    };
}
