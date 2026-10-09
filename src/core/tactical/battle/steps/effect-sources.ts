import type { ActionExecutionWork } from "../../unit/capability/action/internal/executions.js";
import {
    reconcileEffectSources,
    registerEffectSourceUnits,
    type EffectSourceServices,
} from "../../battlefield/effect-source/settlement.js";
import type { UnitId } from "../../unit/unit.js";
import type { BattlefieldChange, BattlefieldView } from "../../battlefield/contract.js";
import type { Event } from "../contract.js";
import type { BattleExecutionState } from "../execution/state.js";
import { combatWorkEvents, combatWorkChanges, createCombatWork } from "../execution/work.js";

interface EffectSourceInput {
    readonly battlefield: BattlefieldView;
    readonly tick: number;
    readonly execution: BattleExecutionState;
    readonly actionExecutions?: ActionExecutionWork;
}

interface EffectSourceResult {
    readonly changes: readonly BattlefieldChange[];
    readonly events: readonly Event[];
    readonly execution: BattleExecutionState;
}

export function advanceEffectSources(
    input: EffectSourceInput,
    resources: EffectSourceServices,
): EffectSourceResult {
    const work = reconcileEffectSources(
        createCombatWork(
            input.battlefield,
            input.execution,
            input.battlefield,
            input.actionExecutions,
        ),
        resources,
        input.tick,
    );

    return {
        changes: combatWorkChanges(work),
        events: combatWorkEvents(work),
        execution: work.execution,
    };
}

export function registerEffectSources(
    input: EffectSourceInput,
    unitIds: readonly UnitId[],
    resources: EffectSourceServices,
): EffectSourceResult {
    const work = registerEffectSourceUnits(
        createCombatWork(
            input.battlefield,
            input.execution,
            input.battlefield,
            input.actionExecutions,
        ),
        unitIds,
        resources,
        input.tick,
    );

    return {
        changes: combatWorkChanges(work),
        events: combatWorkEvents(work),
        execution: work.execution,
    };
}
