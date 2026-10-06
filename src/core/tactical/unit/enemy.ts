import { createRng } from "../../common/rng.js";
import type { Seed } from "../../common/rng.js";
import type { NavigationRequestId } from "../navigation/request.js";
import { createNavigationState, startNavigationRequest } from "../navigation/state.js";
import type { NavigationOutcome } from "../navigation/state.js";
import type { RouteDefinition } from "../route/definition.js";
import { enterRoute, validateRouteExecution } from "../route/execution.js";
import { initializeRouteSpawn } from "../route/spawn.js";
import { createRouteState } from "../route/state.js";
import type { RouteClockBinding } from "../route/state.js";
import { createRoutedLocomotionState } from "./locomotion/state.js";
import type { Locomotion, LocomotiveUnitDefinition, RoutedLocomotion } from "./locomotion/state.js";
import { stepRoutedLocomotion } from "./locomotion/step.js";
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
    readonly definition: EnemyDefinition;
    readonly route: RouteDefinition;
    readonly clockBinding: RouteClockBinding;
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
    if (!Number.isFinite(definition.locomotion.moveSpeed) || definition.locomotion.moveSpeed < 0) {
        throw new RangeError("enemy moveSpeed must be finite and non-negative");
    }
    return Object.freeze({
        id: definition.id,
        vitality: Object.freeze({ maxHp: definition.vitality.maxHp }),
        locomotion: Object.freeze({ moveSpeed: definition.locomotion.moveSpeed }),
    });
}

export function initializeRoutedEnemy(spawn: RoutedEnemySpawn): RoutedEnemyInitialization {
    if (!Number.isSafeInteger(spawn.id) || spawn.id < 0) {
        throw new RangeError("enemy id must be a nonnegative safe integer");
    }
    validateRouteExecution(spawn.route, spawn.alwaysCheckCurrentPoint);
    const rng = createRng(spawn.rngState);
    const location = initializeRouteSpawn(spawn.route, rng);
    let nextNavigationRequestId = spawn.nextNavigationRequestId;
    const initial = enterRoute(createRouteState(spawn.route, spawn.clockBinding, spawn.alwaysCheckCurrentPoint), {
        rng,
        nextNavigationRequestId() {
            const id = nextNavigationRequestId;
            const next = id + 1;
            if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(next)) {
                throw new RangeError("navigation request identity overflow");
            }
            nextNavigationRequestId = next;
            return id;
        },
    });
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
        rngState: rng.state(),
        nextNavigationRequestId,
    };
}

export function stepRoutedEnemy(enemy: RoutedEnemy, context: RoutedEnemyStepContext): RoutedEnemyStep {
    const step = stepRoutedLocomotion(enemy.locomotion, enemy.position, enemy.definition.locomotion.moveSpeed, context);
    return {
        enemy: {
            ...enemy,
            position: step.position,
            locomotion: step.state,
        },
        rngState: step.rngState,
        nextNavigationRequestId: step.nextNavigationRequestId,
        outcomes: step.outcomes,
    };
}
