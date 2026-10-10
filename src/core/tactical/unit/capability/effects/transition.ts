import { hasEffects } from "./capability.js";
import type { EffectTransitionResources } from "./contract.js";
import { selectParticipatingEffects } from "./competition.js";
import { replaceEffects } from "./internal/state.js";
import { withEffectLifecycle } from "./internal/effect.js";
import { widenUnit, type StableUnit, type Unit } from "../../unit.js";
import type { EffectValue } from "./effect.js";
import type { Binding } from "./binding.js";
import type { EffectBindings } from "./resources.js";

export function transitionEffectBindings<U extends Unit>(
    unit: U | StableUnit<U>,
    instance: EffectValue,
    resources: EffectBindings,
    apply: (binding: Binding, current: StableUnit<U>) => StableUnit<U>,
): StableUnit<U> {
    let current = widenUnit<U>(unit);
    const reconciles = new Set<NonNullable<Binding["reconcile"]>>();

    for (const binding of resources.get(instance)) {
        current = apply(binding, current);

        if (binding.reconcile !== undefined) {
            reconciles.add(binding.reconcile);
        }
    }

    for (const reconcile of reconciles) {
        current = reconcile<U>(unit, current);
    }

    return current;
}

export interface EffectParticipationChange {
    readonly instanceId: number;
    readonly participating: boolean;
}

export function reconcileEffectBindings<U extends Unit>(
    before: U | StableUnit<U>,
    input: U | StableUnit<U>,
    resources: EffectTransitionResources,
    updatedId?: number,
): { readonly unit: StableUnit<U>; readonly changes: readonly EffectParticipationChange[] } {
    const owner = widenUnit<U>(input);

    if (!hasEffects(owner)) {
        return { unit: owner, changes: [] };
    }

    const selected = selectParticipatingEffects(owner.effects.instances, resources.effectLifecycle);
    const previous = new Map(
        hasEffects(before)
            ? before.effects.instances.map((instance) => [instance.id, instance])
            : [],
    );
    const changes: EffectParticipationChange[] = [];
    const instances = owner.effects.instances.map((instance) => {
        const participating = selected.has(instance.id);
        const updated =
            instance.participating === participating
                ? instance
                : withEffectLifecycle(instance, { participating });
        const old = previous.get(instance.id);

        if (old?.participating !== participating && (old?.started ?? updated.started)) {
            changes.push({ instanceId: updated.id, participating });
        }

        return updated;
    });
    let next: StableUnit<U> = instances.some(
        (instance, index) => instance !== owner.effects.instances[index],
    )
        ? replaceEffects<U>(owner, instances)
        : owner;
    const reconciles = new Set<NonNullable<Binding["reconcile"]>>();

    for (const instance of instances) {
        if (!instance.started) {
            continue;
        }

        const old = previous.get(instance.id);
        const changedParticipation =
            old !== undefined && old.participating !== instance.participating;

        if (instance.id !== updatedId && !changedParticipation) {
            continue;
        }

        for (const binding of resources.effectBindings.get(instance)) {
            if (instance.id === updatedId) {
                next = binding.update(next, instance);
            }
            if (changedParticipation) {
                next = binding.setParticipation(next, instance, instance.participating);
            }

            if (binding.reconcile !== undefined) {
                reconciles.add(binding.reconcile);
            }
        }
    }

    for (const reconcile of reconciles) {
        next = reconcile<U>(before, next);
    }

    return { unit: next, changes };
}
