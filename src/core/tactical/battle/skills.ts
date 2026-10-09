import {
    activateSkill,
    advanceSkill,
    finishSkill,
    type SkillExecutionResources,
} from "../unit/capability/skill/execution.js";
import type { BattlefieldChange, BattlefieldView } from "../battlefield/contract.js";
import type { Command, Event } from "./contract.js";
import type { BattleExecutionState } from "./execution/state.js";
import {
    appendCombatEvents,
    combatWorkChanges,
    combatWorkEvents,
    createCombatWork,
} from "./execution/work.js";

export interface SkillInput {
    readonly battlefield: BattlefieldView;
    readonly tick: number;
    readonly execution: BattleExecutionState;
    readonly commands: readonly Extract<
        Command,
        { readonly type: "ACTIVATE_SKILL" | "FINISH_SKILL" }
    >[];
}

export interface SkillResult {
    readonly changes: readonly BattlefieldChange[];
    readonly events: readonly Event[];
    readonly execution: BattleExecutionState;
}

export function advanceSkills(input: SkillInput, resources: SkillExecutionResources): SkillResult {
    let work = createCombatWork(input.battlefield, input.execution, input.battlefield);

    for (const id of input.battlefield.unitIds) {
        const advanced = advanceSkill(work, id, input.tick, resources);
        work = appendCombatEvents(advanced.work, advanced.signals);
    }

    for (const command of input.commands) {
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
