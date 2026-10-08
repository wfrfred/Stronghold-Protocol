import {
    reconcileEffectSources,
    registerEffectSourceUnits,
    type EffectSourceServices,
} from "../../battlefield/effect-source/settlement.js";
import type { UnitId } from "../../unit/unit.js";
import { combatWorkEvents, combatWorkChanges, createCombatWork } from "../execution/work.js";
import type { BattlePhaseInput, BattlePhaseOutput } from "../phase.js";

export function advanceEffectSources(
    input: BattlePhaseInput,
    resources: EffectSourceServices,
): BattlePhaseOutput {
    const work = reconcileEffectSources(
        createCombatWork(input.battlefield, input.execution, input.battlefield),
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
    input: BattlePhaseInput,
    unitIds: readonly UnitId[],
    resources: EffectSourceServices,
): BattlePhaseOutput {
    const work = registerEffectSourceUnits(
        createCombatWork(input.battlefield, input.execution, input.battlefield),
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
