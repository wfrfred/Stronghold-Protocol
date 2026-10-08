import { transitionCombatUnit, type CombatWork } from "../../../battle/execution/work.js";
import { stabilizeUnit, type StableUnit, type Unit, type UnitId } from "../../unit.js";
import { hasEffects } from "./capability.js";
import { replaceEffectInstance } from "./internal/state.js";
import type { EffectProgramRef } from "./program.js";
import type { EffectTransitionResources } from "./contract.js";
import type { EffectInstanceValue } from "./instance.js";
import type { EffectBinding } from "./binding.js";
import type { EffectBindings } from "./resources.js";
import { preserveHpRatio } from "../vitality/max-hp.js";

export function transitionEffectBindings<U extends Unit>(
    unit: U | StableUnit<U>,
    instance: EffectInstanceValue,
    resources: EffectBindings,
    apply: (binding: EffectBinding, current: StableUnit<U>) => StableUnit<U>,
): StableUnit<U> {
    let current = stabilizeUnit<U>(unit);

    for (const binding of resources.get(instance)) {
        current = apply(binding, current);
    }

    return preserveHpRatio<U>(unit, current);
}

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

        const unit = replaceEffectInstance(owner, instance, updated);

        return updated.started
            ? transitionEffectBindings(
                  unit,
                  updated,
                  resources.effectBindings,
                  (binding, current) => binding.update(current, updated),
              )
            : unit;
    });
}
