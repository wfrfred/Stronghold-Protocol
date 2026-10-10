import {
    activateSkill,
    advanceSkill,
    finishSkill,
    type SkillExecutionResources,
} from "../../unit/capability/skill/execution.js";
import type { Command } from "../contract.js";
import { appendEvents, battlefieldView, type BattleState } from "../execution/context.js";

export function advanceSkills(
    state: BattleState,
    commands: readonly Command[],
    tick: number,
    resources: SkillExecutionResources,
): void {
    for (const id of battlefieldView(state).unitIds) {
        const advanced = advanceSkill(state, id, tick, resources);
        appendEvents(state, advanced.signals);
    }

    for (const command of commands) {
        if (command.type !== "ACTIVATE_SKILL" && command.type !== "FINISH_SKILL") {
            continue;
        }

        const changed =
            command.type === "ACTIVATE_SKILL"
                ? activateSkill(state, { unitId: command.unitId, tick }, resources)
                : finishSkill(state, command.unitId, tick, resources);
        appendEvents(state, changed.signals);
    }
}
