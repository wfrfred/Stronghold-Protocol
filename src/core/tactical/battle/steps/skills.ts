import type { ActionExecutionWork } from "../../unit/capability/action/internal/executions.js";
import {
    activateSkill,
    advanceSkill,
    finishSkill,
    type SkillExecutionResources,
} from "../../unit/capability/skill/execution.js";
import type { BattlefieldChange, BattlefieldView } from "../../battlefield/contract.js";
import type { Command, Event } from "../contract.js";
import type { BattleExecutionState } from "../execution/state.js";
import {
    appendCombatEvents,
    combatWorkChanges,
    combatWorkEvents,
    createCombatWork,
} from "../execution/work.js";

interface SkillInput {
    readonly battlefield: BattlefieldView;
    readonly actionExecutions?: ActionExecutionWork;
    readonly tick: number;
    readonly execution: BattleExecutionState;
    readonly commands: readonly Command[];
}

interface SkillResult {
    readonly changes: readonly BattlefieldChange[];
    readonly events: readonly Event[];
    readonly execution: BattleExecutionState;
    readonly actionExecutions?: ActionExecutionWork;
}

export function advanceSkills(input: SkillInput, resources: SkillExecutionResources): SkillResult {
    let work = createCombatWork(
        input.battlefield,
        input.execution,
        input.battlefield,
        input.actionExecutions,
    );

    for (const id of input.battlefield.unitIds) {
        const advanced = advanceSkill(work, id, input.tick, resources);
        work = appendCombatEvents(advanced.work, advanced.signals);
    }

    for (const command of input.commands) {
        if (command.type !== "ACTIVATE_SKILL" && command.type !== "FINISH_SKILL") {
            continue;
        }

        const changed =
            command.type === "ACTIVATE_SKILL"
                ? activateSkill(work, { unitId: command.unitId, tick: input.tick }, resources)
                : finishSkill(work, command.unitId, input.tick, resources);
        work = appendCombatEvents(changed.work, changed.signals);
    }

    return {
        changes: combatWorkChanges(work),
        events: combatWorkEvents(work),
        execution: work.execution,
    };
}
