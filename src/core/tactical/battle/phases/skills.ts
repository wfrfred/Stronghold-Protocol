import {
    activateSkill,
    advanceSkill,
    finishSkill,
    type SkillExecutionResources,
} from "../../unit/capability/skill/execution.js";
import type { BattlePhaseInput, BattlePhaseResult } from "../system.js";
import {
    appendCombatEvents,
    combatWorkChanges,
    combatWorkEvents,
    createCombatWork,
} from "../execution/work.js";

export function advanceSkills(
    input: BattlePhaseInput,
    resources: SkillExecutionResources,
): BattlePhaseResult {
    let work = createCombatWork(input.battlefield, input.execution, input.battlefield);

    for (const id of input.battlefield.unitIds) {
        const advanced = advanceSkill(work, id, input.tick, resources);
        work = appendCombatEvents(advanced.work, advanced.signals);
    }

    for (const command of input.commands) {
        if (command.type === "ACTIVATE_SKILL" || command.type === "FINISH_SKILL") {
            const changed =
                command.type === "ACTIVATE_SKILL"
                    ? activateSkill(work, { unitId: command.unitId, tick: input.tick }, resources)
                    : finishSkill(work, command.unitId, input.tick, resources);
            work = appendCombatEvents(changed.work, changed.signals);
        }
    }

    return {
        state: undefined,
        changes: combatWorkChanges(work),
        events: combatWorkEvents(work),
        execution: work.execution,
    };
}
