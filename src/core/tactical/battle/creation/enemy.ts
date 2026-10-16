import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import { createRng } from "../../../common/rng.js";
import type { RouteDefinition } from "../../unit/capability/locomotion/route/definition.js";
import { createRouteExecution } from "../../unit/capability/locomotion/route/execution.js";
import { initializeRouteSpawn } from "../../unit/capability/locomotion/route/spawn.js";
import type { RouteTiming } from "../../unit/capability/locomotion/route/state.js";
import {
    initializeRouteControl,
    type LocatedRouteSignal,
} from "../../unit/capability/locomotion/route-control.js";
import { createRoutedLocomotionState } from "../../unit/capability/locomotion/capability.js";
import type { Definition, RoutedEnemy } from "../../unit/archetype/enemy.js";
import type { Id } from "../../unit/unit.js";
import { initialize } from "../../unit/initialize.js";
import type { Result, State as BattleState } from "../state.js";

export interface RoutedEnemySpawn<D extends Definition = Definition> {
    readonly id: Id;
    readonly definition: D;
    readonly route: RouteDefinition;
    readonly timing: RouteTiming;
    readonly alwaysCheckCurrentPoint: boolean;
}

export interface RoutedEnemyInitialization<D extends Definition = Definition> {
    readonly enemy: RoutedEnemy<D>;
    readonly signals: readonly LocatedRouteSignal[];
}

export function initializeRoutedEnemy<D extends Definition>(
    battle: BattleState,
    spawn: RoutedEnemySpawn<D>,
): Result<RoutedEnemyInitialization<D>>;
export function initializeRoutedEnemy(
    battle: BattleState,
    spawn: RoutedEnemySpawn,
): Result<RoutedEnemyInitialization> {
    assertNonnegativeSafeInteger(spawn.id, "enemy id");

    const rng = createRng(battle.execution.rngState);
    const location = initializeRouteSpawn(spawn.route, rng);
    const execution = createRouteExecution(
        rng,
        battle.execution.nextNavigationRequestId,
        battle.tick,
    );
    const initial = initializeRouteControl(
        spawn.route,
        spawn.timing,
        spawn.alwaysCheckCurrentPoint,
        location.locatorOffset,
        location.position,
        execution,
    );

    battle = { ...battle, execution: { ...battle.execution, ...execution.state() } };
    const initialized = initialize(battle, {
        id: spawn.id,
        definition: spawn.definition,
        position: initial.position,
    });
    const enemy = {
        ...initialized.value,
        spatialPresence: { present: initial.present },
        locomotion: createRoutedLocomotionState(initialized.value.locomotion, initial.control),
    };

    return {
        state: initialized.state,
        value: { enemy, signals: initial.signals },
    };
}
