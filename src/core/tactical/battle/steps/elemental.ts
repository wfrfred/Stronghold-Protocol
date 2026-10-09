import type { ActionExecutionWork } from "../../unit/capability/action/internal/executions.js";
import {
    advanceElementalInWork,
    type ElementalExecutionResources,
} from "../../unit/capability/elemental/execution.js";
import type { BattlefieldChange, BattlefieldView } from "../../battlefield/contract.js";
import type { Event } from "../contract.js";
import type { BattleExecutionState } from "../execution/state.js";
import { combatWorkChanges, combatWorkEvents, createCombatWork } from "../execution/work.js";

interface ElementalInput {
    readonly battlefield: BattlefieldView;
    readonly tick: number;
    readonly execution: BattleExecutionState;
    readonly actionExecutions?: ActionExecutionWork;
}

interface ElementalResult {
    readonly changes: readonly BattlefieldChange[];
    readonly events: readonly Event[];
    readonly execution: BattleExecutionState;
}

export function advanceElements(
    input: ElementalInput,
    resources: ElementalExecutionResources,
): ElementalResult {
    let work = createCombatWork(
        input.battlefield,
        input.execution,
        input.battlefield,
        input.actionExecutions,
    );

    for (const id of input.battlefield.unitIds) {
        work = advanceElementalInWork(work, id, input.tick, resources);
    }

    return {
        changes: combatWorkChanges(work),
        events: combatWorkEvents(work),
        execution: work.execution,
    };
}
