import type { BattlefieldChange } from "../battlefield/contract.js";
import { compileAction, stepAction, type CompiledAction } from "../combat/action.js";
import type { CombatTargetingView } from "../combat/targeting.js";
import { hasAction, type ActionDefinition } from "../unit/capability/action.js";
import { isSpatiallyPresent } from "../unit/capability/presence.js";
import { hasVitality } from "../unit/capability/vitality.js";
import type { UnitId } from "../unit/unit.js";
import type { BattleEvent } from "./contract.js";
import type { BattlePhase } from "./system.js";

export function createCombatSystem(): { readonly step: BattlePhase } {
    const compiledActions = new WeakMap<ActionDefinition, CompiledAction>();

    const step: BattlePhase = (input) => {
        const { battlefield, tick } = input;
        const ids = [...battlefield.unitIds].sort((left, right) => left - right);
        const units = new Map(ids.map((id) => [id, battlefield.getUnit(id)!]));
        const changed = new Set<UnitId>();
        const events: BattleEvent[] = [];
        const view: CombatTargetingView = {
            get unitIds() {
                return [...units.keys()];
            },
            getUnit: (id) => units.get(id),
            blockerOf: (id) => battlefield.blockerOf(id),
            blockedBy: (id) => battlefield.blockedBy(id),
        };

        for (const [id, unit] of units) {
            if (hasVitality(unit) && unit.vitality.hp <= 0) {
                units.delete(id);
                changed.add(id);
            }
        }

        for (const id of ids) {
            const unit = units.get(id);

            if (unit === undefined || !hasAction(unit) || !isSpatiallyPresent(unit)) {
                continue;
            }

            const definition = unit.definition.action.normalAction;
            let compiled = compiledActions.get(definition);

            if (compiled === undefined) {
                compiled = compileAction(definition);
                compiledActions.set(definition, compiled);
            }

            const result = stepAction(unit, compiled, { battlefield: view, tick });

            for (const updated of result.units) {
                units.set(updated.id, updated);
                changed.add(updated.id);
            }
            for (const removedId of result.removedUnitIds) {
                units.delete(removedId);
                changed.add(removedId);
            }

            events.push(...result.events);
        }

        const changes: BattlefieldChange[] = [...changed]
            .sort((left, right) => left - right)
            .map((unitId): BattlefieldChange => {
                const unit = units.get(unitId);

                return unit === undefined
                    ? { type: "REMOVE_UNIT", unitId, reason: "DEATH" }
                    : { type: "UPDATE_UNIT", unit };
            });

        return { state: undefined, changes, events, execution: input.execution };
    };

    return { step };
}
