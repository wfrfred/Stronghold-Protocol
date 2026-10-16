import { initializeRoutedEnemy } from "../creation/enemy.js";
import { type RoutedEnemy } from "../../unit/archetype/enemy.js";
import type { UnitRouteSignal } from "./route-control.js";
import type { Id } from "../../unit/unit.js";
import type { Command, Event } from "../contract.js";
import {
    advanceBattlefield,
    appendEvents,
    type State as BattleState,
    type Result,
} from "../state.js";
import { advanceSpawnSchedule, recordScheduleSpawns } from "../schedule/runtime.js";
import type { ScheduledEnemySpawn } from "../schedule/definition.js";
import { enterUnits } from "../execution/unit-lifecycle.js";

interface SpawnedEnemies {
    readonly enemies: readonly RoutedEnemy[];
    readonly signals: readonly UnitRouteSignal[];
}

function spawnEnemies(
    state: BattleState,
    spawns: readonly ScheduledEnemySpawn[],
): Result<SpawnedEnemies> {
    const enemies: RoutedEnemy[] = [];
    const signals: UnitRouteSignal[] = [];

    for (const spawn of spawns) {
        const id = state.execution.nextUnitId;
        const nextUnitId = id + 1;

        if (!Number.isSafeInteger(nextUnitId)) {
            throw new RangeError("unit identity overflow");
        }

        state = { ...state, execution: { ...state.execution, nextUnitId } };
        const initialized = initializeRoutedEnemy(state, {
            id,
            definition: spawn.definition,
            route: spawn.route,
            timing: spawn.timing,
            alwaysCheckCurrentPoint: spawn.alwaysCheckCurrentPoint,
        });
        state = initialized.state;
        const { enemy, signals: spawnedSignals } = initialized.value;

        enemies.push(enemy);
        signals.push(...spawnedSignals.map((signal) => ({ ...signal, unitId: enemy.id })));
    }

    return {
        state,
        value: { enemies, signals },
    };
}

function enemySpawnEvents(spawned: SpawnedEnemies, tick: number): Event[] {
    const signalsByUnit = new Map<Id, UnitRouteSignal[]>();

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
    commands: readonly Command[],
    tick: number,
): BattleState {
    const scheduled = advanceSpawnSchedule(state.schedule, {
        tick,
        triggers: commands.filter((command) => command.type === "TRIGGER_BRANCH"),
    });
    const initialized = spawnEnemies(state, scheduled.spawns);
    state = initialized.state;
    const spawned = initialized.value;
    state = {
        ...state,
        schedule: recordScheduleSpawns(
            scheduled.state,
            scheduled.spawns,
            spawned.enemies.map((enemy) => enemy.id),
        ),
    };
    state = appendEvents(state, enemySpawnEvents(spawned, tick));
    state = advanceBattlefield(
        state,
        spawned.enemies.map((unit) => ({ type: "REGISTER_UNIT", unit })),
    );
    state = enterUnits(
        state,
        spawned.enemies.map((unit) => unit.id),
    );

    return state;
}
