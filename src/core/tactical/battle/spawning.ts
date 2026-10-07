import { initializeRoutedEnemy, type RoutedEnemy } from "../unit/enemy.js";
import type { BattleExecutionState } from "./state.js";
import type { UnitRouteSignal } from "./route-control.js";
import type { UnitId } from "../unit/unit.js";
import type { BattleEvent } from "./contract.js";
import type { BattlePhase, BattleSystem } from "./system.js";
import {
    advanceSpawnSchedule,
    createSpawnScheduleState,
    getSpawnedCount,
    getUnspawnedCount,
    isSpawnScheduleCompleted,
    recordScheduleSpawns,
    resolveScheduleUnits,
    type ScheduledEnemySpawn,
    type SpawnScheduleDefinition,
    type SpawnScheduleState,
    type SpawnScheduleTrigger,
} from "./schedule.js";

export interface SpawnedEnemies {
    readonly execution: BattleExecutionState;
    readonly enemies: readonly RoutedEnemy[];
    readonly signals: readonly UnitRouteSignal[];
}

export function spawnEnemies(
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

function enemySpawnEvents(spawned: SpawnedEnemies, tick: number): BattleEvent[] {
    const signalsByUnit = new Map<UnitId, UnitRouteSignal[]>();

    for (const signal of spawned.signals) {
        const signals = signalsByUnit.get(signal.unitId) ?? [];
        signals.push(signal);
        signalsByUnit.set(signal.unitId, signals);
    }

    const events: BattleEvent[] = [];

    for (const enemy of spawned.enemies) {
        events.push({ type: "ENEMY_SPAWNED", unitId: enemy.id, tick });

        for (const signal of signalsByUnit.get(enemy.id) ?? []) {
            events.push({ type: "ROUTE", ...signal, tick });
        }
    }

    return events;
}

export function createSpawnScheduleSystem(
    definition: SpawnScheduleDefinition,
): BattleSystem<SpawnScheduleState> & {
    readonly spawn: BattlePhase<SpawnScheduleState>;
    readonly resolve: BattlePhase<SpawnScheduleState>;
    isCompleted(state: SpawnScheduleState): boolean;
    counts(state: SpawnScheduleState): {
        readonly spawnedCount: number;
        readonly unspawnedCount: number;
    };
} {
    return {
        createState: () => createSpawnScheduleState(definition),

        spawn(input, state) {
            const triggers: SpawnScheduleTrigger[] = input.commands.filter(
                (command) => command.type === "TRIGGER_BRANCH",
            );
            const scheduled = advanceSpawnSchedule(definition, state, {
                tick: input.tick,
                triggers,
            });
            const spawned = spawnEnemies(scheduled.spawns, input.execution, input.tick);

            return {
                state: recordScheduleSpawns(
                    scheduled.state,
                    scheduled.spawns,
                    spawned.enemies.map((enemy) => enemy.id),
                ),
                changes: spawned.enemies.map((unit) => ({ type: "REGISTER_UNIT", unit })),
                events: enemySpawnEvents(spawned, input.tick),
                execution: spawned.execution,
            };
        },

        resolve(input, state) {
            return {
                state: resolveScheduleUnits(
                    state,
                    input.removedUnits.map((removed) => removed.unitId),
                ),
                changes: [],
                events: [],
                execution: input.execution,
            };
        },

        isCompleted: (state) => isSpawnScheduleCompleted(definition, state),
        counts: (state) => ({
            spawnedCount: getSpawnedCount(state),
            unspawnedCount: getUnspawnedCount(definition, state),
        }),
    };
}
