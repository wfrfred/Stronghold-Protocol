import {
    reconcileEffectSources,
    registerEffectSourceUnits,
    type EffectSourceServices,
} from "../../battlefield/effect-source/settlement.js";
import type { UnitId } from "../../unit/unit.js";
import { combatWorkChanges, createCombatWork } from "../execution/work.js";
import type { BattlePhase, BattlePhaseInput, BattlePhaseResult } from "../system.js";

export function createEffectSourceSystem(resources: EffectSourceServices): {
    readonly step: BattlePhase;
    register(input: BattlePhaseInput, unitIds: readonly UnitId[]): BattlePhaseResult;
} {
    const step: BattlePhase = (input) => {
        const work = reconcileEffectSources(
            createCombatWork(input.battlefield, input.execution, input.battlefield),
            resources,
            input.tick,
        );

        return {
            state: undefined,
            changes: combatWorkChanges(work),
            events: work.events,
            execution: work.execution,
        };
    };

    return {
        step,
        register: (input, unitIds) => {
            const work = registerEffectSourceUnits(
                createCombatWork(input.battlefield, input.execution, input.battlefield),
                unitIds,
                resources,
                input.tick,
            );

            return {
                state: undefined,
                changes: combatWorkChanges(work),
                events: work.events,
                execution: work.execution,
            };
        },
    };
}
