import { transitionCombatUnit, type CombatWork } from "../../../battle/execution/work.js";
import type { UnitId } from "../../unit.js";
import { hasEffects } from "./capability.js";
import { replaceEffectInstance } from "./internal/state.js";
import type { EffectProgramRef } from "./program.js";
import type { EffectTransitionResources } from "./contract.js";

export function updateEffectState<S extends object>(
    work: CombatWork,
    ownerUnitId: UnitId,
    instanceId: number,
    ref: EffectProgramRef<S>,
    state: NoInfer<S> | ((current: NoInfer<S>) => NoInfer<S>),
    resources: EffectTransitionResources,
): CombatWork {
    return transitionCombatUnit(work, ownerUnitId, (owner) => {
        if (!hasEffects(owner)) {
            return owner;
        }

        const instance = owner.effects.instances.find((value) => value.id === instanceId);

        if (instance === undefined) {
            return owner;
        }

        const typed = resources.effects.typedInstance(instance, ref);

        if (typed === undefined) {
            throw new TypeError("effect state update must use its matching program");
        }

        const updated = resources.effects.update(
            typed,
            typeof state === "function" ? state(typed.state) : state,
        );

        if (updated === instance) {
            return owner;
        }

        let unit = replaceEffectInstance(owner, instance, updated);

        if (updated.started) {
            for (const binding of resources.effectBindings.get(updated)) {
                unit = binding.update(unit, updated);
            }
        }

        return unit;
    });
}
