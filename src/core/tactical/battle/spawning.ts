import { initializeRoutedEnemy } from "../unit/enemy.js";
import type { RoutedEnemy } from "../unit/enemy.js";
import type { ScheduledEnemySpawn } from "./spec.js";
import type { BattleExecutionState } from "./state.js";

export interface SpawnProgress {
    readonly cursor: number;
}

export interface DueEnemySpawns {
    readonly progress: SpawnProgress;
    readonly execution: BattleExecutionState;
    readonly enemies: readonly RoutedEnemy[];
}

export function spawnDueEnemies(
    schedule: readonly ScheduledEnemySpawn[],
    progress: SpawnProgress,
    execution: BattleExecutionState,
    tickIndex: number,
): DueEnemySpawns {
    let { cursor } = progress;
    let { rngState, nextUnitId, nextNavigationRequestId } = execution;
    const enemies: RoutedEnemy[] = [];
    while (cursor < schedule.length && schedule[cursor]!.tick <= tickIndex) {
        const spawn = schedule[cursor]!;
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
        nextUnitId++;
        cursor++;
    }
    return {
        enemies,
        progress: { cursor },
        execution: { rngState, nextUnitId, nextNavigationRequestId },
    };
}
