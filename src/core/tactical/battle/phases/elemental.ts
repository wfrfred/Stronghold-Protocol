import {
    advanceElementalInWork,
    type ElementalExecutionResources,
} from "../../unit/capability/elemental/execution.js";
import type { BattlePhaseInput, BattlePhaseResult } from "../system.js";
import { combatWorkChanges, combatWorkEvents, createCombatWork } from "../execution/work.js";

export function advanceElements(
    input: BattlePhaseInput,
    resources: ElementalExecutionResources,
): BattlePhaseResult {
    let work = createCombatWork(input.battlefield, input.execution, input.battlefield);

    for (const id of input.battlefield.unitIds) {
        work = advanceElementalInWork(work, id, input.tick, resources);
    }

    return {
        state: undefined,
        changes: combatWorkChanges(work),
        events: combatWorkEvents(work),
        execution: work.execution,
    };
}
