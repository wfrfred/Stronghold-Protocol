import { initializeRoutedEnemy } from "../unit/enemy.js";
import type { RoutedEnemy } from "../unit/enemy.js";
import type { BattleExecutionState } from "./state.js";
import type { EnemyDefinition } from "../unit/enemy.js";
import type { RouteDefinition } from "../route/definition.js";
import type { RouteTiming } from "../route/state.js";

export interface EnemySpawnDefinition {
    readonly definition: EnemyDefinition;
    readonly route: RouteDefinition;
    readonly alwaysCheckCurrentPoint: boolean;
    readonly notCountInTotal: boolean;
}

export interface ScheduledEnemySpawn extends EnemySpawnDefinition {
    readonly tick: number;
    readonly timing: RouteTiming;
}

export interface SpawnedEnemies {
    readonly execution: BattleExecutionState;
    readonly enemies: readonly RoutedEnemy[];
}

export function spawnEnemies(
    spawns: readonly ScheduledEnemySpawn[],
    execution: BattleExecutionState,
): SpawnedEnemies {
    let { rngState, nextUnitId, nextNavigationRequestId } = execution;
    const enemies: RoutedEnemy[] = [];
    for (const spawn of spawns) {
        const initialized = initializeRoutedEnemy({
            id: nextUnitId,
            definition: spawn.definition,
            route: spawn.route,
            timing: spawn.timing,
            alwaysCheckCurrentPoint: spawn.alwaysCheckCurrentPoint,
            rngState,
            nextNavigationRequestId,
        });
        enemies.push(initialized.enemy);
        rngState = initialized.rngState;
        nextNavigationRequestId = initialized.nextNavigationRequestId;
        const next = nextUnitId + 1;
        if (!Number.isSafeInteger(next)) throw new RangeError("unit identity overflow");
        nextUnitId = next;
    }
    return {
        enemies,
        execution: { ...execution, rngState, nextUnitId, nextNavigationRequestId },
    };
}
