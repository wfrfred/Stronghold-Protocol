import { initialize as initializeRoutedUnit } from "../creation/routed-unit.js";
import type { Unit } from "../../unit/unit.js";
import type { Command } from "../contract.js";
import {
    advanceBattlefield,
    appendEvents,
    type State as BattleState,
    type Result,
} from "../state.js";
import { advanceSpawnSchedule, recordScheduleSpawns } from "../schedule/runtime.js";
import type { ScheduledEnemySpawn } from "../schedule/definition.js";
import { enter } from "../execution/unit.js";

function spawnEnemies(
    state: BattleState,
    spawns: readonly ScheduledEnemySpawn[],
): Result<readonly Unit[]> {
    const enemies: Unit[] = [];

    for (const spawn of spawns) {
        const id = state.execution.nextUnitId;
        const nextUnitId = id + 1;

        if (!Number.isSafeInteger(nextUnitId)) {
            throw new RangeError("unit identity overflow");
        }

        state = { ...state, execution: { ...state.execution, nextUnitId } };
        const initialized = initializeRoutedUnit(state, {
            id,
            definition: spawn.definition,
            route: spawn.route,
            timing: spawn.timing,
            alwaysCheckCurrentPoint: spawn.alwaysCheckCurrentPoint,
        });
        state = initialized.state;
        enemies.push(initialized.value.unit);
    }

    return { state, value: enemies };
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
    const enemies = initialized.value;
    state = {
        ...state,
        schedule: recordScheduleSpawns(
            scheduled.state,
            scheduled.spawns,
            enemies.map((enemy) => enemy.id),
        ),
    };
    state = appendEvents(
        state,
        enemies.map((enemy) => ({ type: "ENEMY_SPAWNED", unitId: enemy.id, tick })),
    );
    state = advanceBattlefield(
        state,
        enemies.map((unit) => ({ type: "REGISTER_UNIT", unit })),
    );
    state = enter(
        state,
        enemies.map((unit) => unit.id),
    );

    return state;
}
