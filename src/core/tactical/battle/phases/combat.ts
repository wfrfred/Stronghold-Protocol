import { compileAction } from "../../unit/capability/action/compile.js";
import { executeAction } from "../../unit/capability/action/execution.js";
import { type CompiledAction } from "../../unit/capability/action/program.js";
import { prepareCombatEffects, retireCombatUnit } from "../execution/unit-lifecycle.js";
import { CombatResources } from "../resources.js";
import { combatWorkChanges, createCombatWork, getCombatUnit } from "../execution/work.js";
import { hasAction, type ActionDefinition } from "../../unit/capability/action/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence.js";
import { hasVitality } from "../../unit/capability/vitality/capability.js";
import type { BattlePhase } from "../system.js";

export function createCombatSystem(
    resources = new CombatResources(),
    compile: typeof compileAction = compileAction,
): {
    readonly prepare: BattlePhase;
    readonly step: BattlePhase;
} {
    const compiledActions = new WeakMap<ActionDefinition, CompiledAction>();

    const prepare: BattlePhase = (input) => {
        const work = prepareCombatEffects(
            createCombatWork(input.battlefield, input.execution),
            input.tick,
            resources,
        );

        return {
            state: undefined,
            changes: combatWorkChanges(work),
            events: work.events,
            execution: work.execution,
        };
    };

    const step: BattlePhase = (input) => {
        const { battlefield, tick } = input;
        const ids = [...battlefield.unitIds].sort((left, right) => left - right);
        let work = prepareCombatEffects(
            createCombatWork(battlefield, input.execution),
            tick,
            resources,
        );

        for (const id of ids) {
            const unit = getCombatUnit(work, id);

            if (unit !== undefined && hasVitality(unit) && unit.vitality.hp <= 0) {
                work = retireCombatUnit(work, id, resources, tick);
            }
        }

        for (const id of ids) {
            const unit = getCombatUnit(work, id);

            if (unit === undefined || !hasAction(unit) || !isSpatiallyPresent(unit)) {
                continue;
            }

            const definition = unit.definition.action.normalAction;
            let compiled = compiledActions.get(definition);

            if (compiled === undefined) {
                compiled = compile(definition, resources);
                compiledActions.set(definition, compiled);
            }

            work = executeAction(work, id, compiled, tick);
        }

        return {
            state: undefined,
            changes: combatWorkChanges(work),
            events: work.events,
            execution: work.execution,
        };
    };

    return { prepare, step };
}
