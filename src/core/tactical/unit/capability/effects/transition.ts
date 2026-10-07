import { transitionCombatUnit, type CombatWork } from "../../../battle/execution/work.js";
import type { Unit, UnitId } from "../../unit.js";
import type { StatusFlag } from "../status.js";
import { createEffectsState, hasEffects, type Effects } from "./capability.js";
import type { EffectInstanceValue } from "./instance.js";
import { installEffect } from "./lifecycle.js";
import type { EffectProgramRef } from "./program.js";
import type { EffectResources } from "./registry.js";
import type { EffectContributionBindings } from "./resources.js";

export interface EffectTransitionResources {
    readonly effects: Pick<EffectResources, "typedInstance" | "update">;
    readonly effectBindings: EffectContributionBindings;
}

export function installEffectWithBindings<U extends Unit>(
    unit: U,
    instance: EffectInstanceValue,
    bindings: EffectContributionBindings,
    flags: readonly StatusFlag[] = [],
): U & Effects {
    const contributions = bindings.get(instance);
    let installed = installEffect(unit, instance, flags);

    for (const binding of contributions) {
        installed = binding.install(installed, instance);
    }

    return installed;
}

export function cleanupEffectContributions<U extends Unit>(
    unit: U,
    removedInstances: readonly EffectInstanceValue[],
    bindings: EffectContributionBindings,
): U {
    let current = unit;

    for (const instance of removedInstances) {
        for (const binding of bindings.get(instance)) {
            current = binding.remove(current, instance);
        }
    }

    return current;
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
            instance,
            ref,
            typeof state === "function" ? state(typed.state) : state,
        );

        if (updated === instance) {
            return owner;
        }

        let unit: Unit & Effects = {
            ...owner,
            effects: createEffectsState(
                owner.effects.instances.map((value) => (value === instance ? updated : value)),
            ),
        };

        for (const binding of resources.effectBindings.get(updated)) {
            unit = binding.update(unit, updated);
        }

        return unit;
    });
}
