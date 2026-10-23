import { initialize as initializeRoutedUnit } from "../creation/routed-unit.js";
import type { Command } from "../contract.js";
import { registerUnit, appendEvents, type State as BattleState } from "../state.js";
import { advanceSpawnSchedule, recordScheduleSpawns } from "../schedule/runtime.js";
import { enter } from "../execution/unit.js";

export function advanceSpawning(
    state: BattleState,
    commands: readonly Command[],
    tick: number,
): BattleState {
    const scheduled = advanceSpawnSchedule(state.schedule, {
        tick,
        triggers: commands.filter((command) => command.type === "TRIGGER_BRANCH"),
    });
    state = { ...state, schedule: scheduled.state };

    for (const spawn of scheduled.spawns) {
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
        const unit = initialized.value;
        state = {
            ...state,
            schedule: recordScheduleSpawns(state.schedule, [spawn], [unit.id]),
        };
        state = appendEvents(state, [{ type: "ENEMY_SPAWNED", unitId: unit.id, tick }]);
        state = registerUnit(state, unit);
        state = enter(state, unit.id);
    }

    return state;
}
