import {
    activateSkill,
    advanceSkill,
    finishSkill,
    type SkillExecutionResources,
} from "../../unit/capability/skill/execution.js";
import type { Command } from "../contract.js";
import { battlefieldView, type State as BattleState } from "../state.js";

export function advanceSkills(
    state: BattleState,
    commands: readonly Command[],
    tick: number,
    resources: SkillExecutionResources,
): BattleState {
    for (const id of battlefieldView(state).unitIds) {
        state = advanceSkill(state, id, tick, resources);
    }

    for (const command of commands) {
        if (command.type !== "ACTIVATE_SKILL" && command.type !== "FINISH_SKILL") {
            continue;
        }

        state =
            command.type === "ACTIVATE_SKILL"
                ? activateSkill(state, { unitId: command.unitId, tick }, resources).state
                : finishSkill(state, command.unitId, tick, resources);
    }

    return state;
}
