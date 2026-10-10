import { initializeRoutedEnemy } from "../creation/enemy.js";
import { type RoutedEnemy } from "../../unit/archetype/enemy.js";
import type { BattleExecutionState } from "../execution/state.js";
import type { UnitRouteSignal } from "./route-control.js";
import type { UnitId } from "../../unit/unit.js";
import type { Command, Event } from "../contract.js";
import {
    advanceBattlefield,
    appendEvents,
    withExecution,
    type BattleState,
} from "../execution/context.js";
import { advanceSpawnSchedule, recordScheduleSpawns } from "../schedule/runtime.js";
import type { SpawnScheduleExecution } from "../schedule/state.js";
import type { ScheduledEnemySpawn } from "../schedule/definition.js";

interface SpawnedEnemies {
    readonly execution: BattleExecutionState;
    readonly enemies: readonly RoutedEnemy[];
    readonly signals: readonly UnitRouteSignal[];
}

function spawnEnemies(
    spawns: readonly ScheduledEnemySpawn[],
    execution: BattleExecutionState,
    tick: number,
): SpawnedEnemies {
    let { rngState, nextUnitId, nextNavigationRequestId } = execution;
    const enemies: RoutedEnemy[] = [];
    const signals: UnitRouteSignal[] = [];

    for (const spawn of spawns) {
        const initialized = initializeRoutedEnemy({
            id: nextUnitId,
            tick,
            definition: spawn.definition,
            route: spawn.route,
            timing: spawn.timing,
            alwaysCheckCurrentPoint: spawn.alwaysCheckCurrentPoint,
            rngState,
            nextNavigationRequestId,
        });

        enemies.push(initialized.enemy);
        signals.push(
            ...initialized.signals.map((signal) => ({ ...signal, unitId: initialized.enemy.id })),
        );
        rngState = initialized.rngState;
        nextNavigationRequestId = initialized.nextNavigationRequestId;

        const nextIdentity = nextUnitId + 1;

        if (!Number.isSafeInteger(nextIdentity)) {
            throw new RangeError("unit identity overflow");
        }

        nextUnitId = nextIdentity;
    }

    return {
        enemies,
        signals,
        execution:
            spawns.length === 0
                ? execution
                : { ...execution, rngState, nextUnitId, nextNavigationRequestId },
    };
}

function enemySpawnEvents(spawned: SpawnedEnemies, tick: number): Event[] {
    const signalsByUnit = new Map<UnitId, UnitRouteSignal[]>();

    for (const signal of spawned.signals) {
        const signals = signalsByUnit.get(signal.unitId) ?? [];
        signals.push(signal);
        signalsByUnit.set(signal.unitId, signals);
    }

    const events: Event[] = [];

    for (const enemy of spawned.enemies) {
        events.push({ type: "ENEMY_SPAWNED", unitId: enemy.id, tick });

        for (const signal of signalsByUnit.get(enemy.id) ?? []) {
            events.push({ type: "ROUTE", ...signal, tick });
        }
    }

    return events;
}

export function advanceSpawning(
    state: BattleState,
    schedule: SpawnScheduleExecution,
    commands: readonly Command[],
    tick: number,
): SpawnScheduleExecution {
    const scheduled = advanceSpawnSchedule(schedule, {
        tick,
        triggers: commands.filter((command) => command.type === "TRIGGER_BRANCH"),
    });
    const spawned = spawnEnemies(scheduled.spawns, state.execution, tick);
    withExecution(state, spawned.execution);
    appendEvents(state, enemySpawnEvents(spawned, tick));
    advanceBattlefield(
        state,
        spawned.enemies.map((unit) => ({ type: "REGISTER_UNIT", unit })),
    );

    return recordScheduleSpawns(
        scheduled.state,
        scheduled.spawns,
        spawned.enemies.map((enemy) => enemy.id),
    );
}
