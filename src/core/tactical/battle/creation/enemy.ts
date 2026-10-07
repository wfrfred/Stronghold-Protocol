import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import { createRng, type Seed } from "../../../common/rng.js";
import type { NavigationRequestId } from "../../battlefield/navigation/request.js";
import type { RouteDefinition } from "../../unit/capability/locomotion/route/definition.js";
import { createRouteExecution } from "../../unit/capability/locomotion/route/execution.js";
import { initializeRouteSpawn } from "../../unit/capability/locomotion/route/spawn.js";
import type { RouteTiming } from "../../unit/capability/locomotion/route/state.js";
import {
    initializeRouteControl,
    type LocatedRouteSignal,
} from "../../unit/capability/locomotion/route-control.js";
import { createRoutedLocomotionState } from "../../unit/capability/locomotion/capability.js";
import type { EnemyDefinition, RoutedEnemy } from "../../unit/archetype/enemy.js";
import type { UnitId } from "../../unit/unit.js";
import { initializeUnit } from "../../unit/initialize.js";

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

export function initializeRoutedEnemy<D extends EnemyDefinition>(
    spawn: RoutedEnemySpawn<D>,
): RoutedEnemyInitialization<D> {
    assertNonnegativeSafeInteger(spawn.id, "enemy id");

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
