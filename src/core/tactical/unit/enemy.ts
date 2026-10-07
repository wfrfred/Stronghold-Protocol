import { createRng, type Seed } from "../../common/rng.js";
import type { NavigationRequestId } from "../navigation/request.js";
import type { NavigationOutcome } from "../navigation/state.js";
import type { RouteDefinition } from "../route/definition.js";
import { createRouteExecution } from "../route/execution.js";
import { initializeRouteSpawn } from "../route/spawn.js";
import type { RouteTiming } from "../route/state.js";
import {
    createActionCapabilityDefinition,
    type ActingUnitDefinition,
} from "./capability/action.js";
import { createAllegianceState, type AllegiantUnitDefinition } from "./capability/allegiance.js";
import { createBlockableDefinition, type BlockableUnitDefinition } from "./capability/blocking.js";
import { createDefenseDefinition, type DefendedUnitDefinition } from "./capability/defense.js";
import { createOffenseDefinition, type OffenseDefinition } from "./capability/offense.js";
import {
    initializeRouteControl,
    type LocatedRouteSignal,
} from "./capability/locomotion/route-control.js";
import {
    createRoutedLocomotionState,
    type Locomotion,
    type LocomotiveUnitDefinition,
    type RoutedLocomotion,
} from "./capability/locomotion/state.js";
import { stepRoutedUnit, type RoutedLocomotionStepContext } from "./capability/locomotion/step.js";
import type { SpatialPresence } from "./capability/presence.js";
import {
    createHitDefinition,
    createSpatialDefinition,
    type HitUnitDefinition,
    type SpatialUnitDefinition,
} from "./capability/spatial.js";
import { createStatusDefinition, type StatusUnitDefinition } from "./capability/status.js";
import type { Unit, UnitId } from "./unit.js";
import type { Vitality, VitalUnitDefinition } from "./capability/vitality.js";
import { initializeUnit, type InitializedUnit } from "./initialize.js";

export interface EnemyDefinition extends VitalUnitDefinition, LocomotiveUnitDefinition {}

export type Enemy<D extends EnemyDefinition = EnemyDefinition> = Unit<D> & Vitality & Locomotion;

export type RoutedEnemy<D extends EnemyDefinition = EnemyDefinition> = Enemy<D> &
    InitializedUnit<D> &
    RoutedLocomotion &
    SpatialPresence;

export interface CombatEnemyDefinition
    extends
        EnemyDefinition,
        ActingUnitDefinition,
        AllegiantUnitDefinition,
        SpatialUnitDefinition,
        HitUnitDefinition,
        StatusUnitDefinition,
        DefendedUnitDefinition,
        BlockableUnitDefinition {
    readonly offense?: OffenseDefinition;
}

export type CombatRoutedEnemy = RoutedEnemy<CombatEnemyDefinition>;

export interface RoutedEnemySpawn<D extends EnemyDefinition = EnemyDefinition> {
    readonly id: UnitId;
    readonly tick: number;
    readonly definition: D;
    readonly route: RouteDefinition;
    readonly timing: RouteTiming;
    readonly alwaysCheckCurrentPoint: boolean;
    readonly rngState: Seed;
    readonly nextNavigationRequestId: NavigationRequestId;
}

export interface RoutedEnemyInitialization<D extends EnemyDefinition = EnemyDefinition> {
    readonly enemy: RoutedEnemy<D>;
    readonly signals: readonly LocatedRouteSignal[];
    readonly rngState: Seed;
    readonly nextNavigationRequestId: NavigationRequestId;
}

export type RoutedEnemyStepContext = RoutedLocomotionStepContext;

export interface RoutedEnemyStep<D extends EnemyDefinition = EnemyDefinition> {
    readonly enemy: RoutedEnemy<D>;
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

export function createCombatEnemyDefinition(
    definition: CombatEnemyDefinition,
): CombatEnemyDefinition {
    return Object.freeze({
        ...createEnemyDefinition(definition),
        action: createActionCapabilityDefinition(definition.action),
        allegiance: createAllegianceState(definition.allegiance),
        spatial: createSpatialDefinition(definition.spatial),
        hit: createHitDefinition(definition.hit),
        status: createStatusDefinition(definition.status),
        defense: createDefenseDefinition(definition.defense),
        ...(definition.offense === undefined
            ? {}
            : { offense: createOffenseDefinition(definition.offense) }),
        blockable: createBlockableDefinition(definition.blockable),
    });
}

export function initializeRoutedEnemy<D extends EnemyDefinition>(
    spawn: RoutedEnemySpawn<D>,
): RoutedEnemyInitialization<D> {
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

    const states = {
        spatialPresence: { present: initial.present },
        locomotion: createRoutedLocomotionState(initial.control.route, initial.control.navigation),
    };
    const enemy = initializeUnit<EnemyDefinition, typeof states>({
        id: spawn.id,
        definition: spawn.definition,
        position: initial.position,
        tick: spawn.tick,
        states,
    });

    return {
        enemy: enemy as RoutedEnemy<D>,
        signals: initial.signals,
        ...execution.state(),
    };
}

export function stepRoutedEnemy<D extends EnemyDefinition>(
    enemy: RoutedEnemy<D>,
    context: RoutedEnemyStepContext,
): RoutedEnemyStep<D> {
    const step = stepRoutedUnit(enemy, context);

    return {
        enemy: step.unit,
        signals: step.signals,
        rngState: step.rngState,
        nextNavigationRequestId: step.nextNavigationRequestId,
        outcomes: step.outcomes,
    };
}
