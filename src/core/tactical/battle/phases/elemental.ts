import {
    advanceElementalInWork,
    type ElementalExecutionResources,
} from "../../unit/capability/elemental/execution.js";
import type { BattlePhaseInput, BattlePhaseOutput } from "../phase.js";
import { combatWorkChanges, combatWorkEvents, createCombatWork } from "../execution/work.js";

export function advanceElements(
    input: BattlePhaseInput,
    resources: ElementalExecutionResources,
): BattlePhaseOutput {
    let work = createCombatWork(input.battlefield, input.execution, input.battlefield);

    for (const id of input.battlefield.unitIds) {
        work = advanceElementalInWork(work, id, input.tick, resources);
    }

    return {
        changes: combatWorkChanges(work),
        events: combatWorkEvents(work),
        execution: work.execution,
    };
}
