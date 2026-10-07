import {
    combatWorkView,
    getCombatUnit,
    transitionCombatUnit,
    type CombatWork,
} from "../../../battle/execution/work.js";
import type { UnitId } from "../../unit.js";
import { hasEffects } from "./capability.js";
import type {
    EffectInstallation,
    EffectLifecycleContext,
    EffectTransitionResources,
} from "./contract.js";
import type { EffectAddress, EffectInstanceValue } from "./instance.js";
import { withEffectLifecycle } from "./internal/instance.js";
import { registerEffectInstance, replaceEffectInstances } from "./internal/state.js";
import type { CompiledEffectLifecycle } from "./lifecycle-resources.js";
import { effectFacts, getEffect } from "./query.js";
import { updateEffectState } from "./transition.js";

interface EffectLifecycleScope {
    readonly finishing: readonly EffectAddress[];
}

function sameAddress(left: EffectAddress | null, right: EffectAddress): boolean {
    return left !== null && left.unitId === right.unitId && left.instanceId === right.instanceId;
}

function addressesMatching(
    work: CombatWork,
    matches: (instance: EffectInstanceValue, address: EffectAddress) => boolean,
): readonly EffectAddress[] {
    return combatWorkView(work).unitIds.flatMap((unitId) => {
        const unit = getCombatUnit(work, unitId)!;

        return hasEffects(unit)
            ? unit.effects.instances.flatMap((instance) => {
                  const address = { unitId, instanceId: instance.id };

                  return matches(instance, address) ? [address] : [];
              })
            : [];
    });
}

function changeInstance(
    work: CombatWork,
    address: EffectAddress,
    transition: (instance: EffectInstanceValue) => EffectInstanceValue,
): CombatWork {
    return transitionCombatUnit(work, address.unitId, (unit) => {
        if (!hasEffects(unit)) {
            return unit;
        }

        const instance = unit.effects.instances.find((value) => value.id === address.instanceId);

        if (instance === undefined) {
            return unit;
        }

        const updated = transition(instance);

        return updated === instance
            ? unit
            : replaceEffectInstances(
                  unit,
                  unit.effects.instances.map((value) => (value === instance ? updated : value)),
              );
    });
}

function runLifecycleAction(
    work: CombatWork,
    address: EffectAddress,
    instance: EffectInstanceValue,
    action: CompiledEffectLifecycle["start"],
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectLifecycleScope = { finishing: [] },
): CombatWork {
    if (action === undefined) {
        return work;
    }

    let currentWork = work;
    const context: EffectLifecycleContext = {
        address,
        get instance() {
            return getEffect(currentWork, address) ?? instance;
        },
        tick,
        facts: effectFacts(() => currentWork),
        effects: {
            update: (target, ref, transition) => {
                currentWork = updateEffectState(
                    currentWork,
                    target.unitId,
                    target.instanceId,
                    ref,
                    transition,
                    resources,
                );
            },
            setParticipation: (target, participating) => {
                currentWork = setParticipationInScope(
                    currentWork,
                    target,
                    participating,
                    resources,
                    tick,
                    scope,
                );
            },
            finish: (target) => {
                currentWork = finishInScope(currentWork, target, resources, tick, scope);
            },
            attachParent: (child, parent, finishIfParentFinished) => {
                currentWork = attachParentInScope(
                    currentWork,
                    child,
                    parent,
                    resources,
                    tick,
                    finishIfParentFinished ?? true,
                    scope,
                );
            },
        },
    };

    action(context);

    return currentWork;
}

export function setEffectParticipation(
    work: CombatWork,
    address: EffectAddress,
    participating: boolean,
    resources: EffectTransitionResources,
    tick: number,
): CombatWork {
    return setParticipationInScope(work, address, participating, resources, tick, {
        finishing: [],
    });
}

function setParticipationInScope(
    work: CombatWork,
    address: EffectAddress,
    participating: boolean,
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectLifecycleScope,
): CombatWork {
    if (participating && scope.finishing.some((value) => sameAddress(value, address))) {
        return work;
    }

    const instance = getEffect(work, address);

    if (
        instance === undefined ||
        !instance.started ||
        instance.finished ||
        instance.participating === participating
    ) {
        return work;
    }

    const updated = withEffectLifecycle(instance, { participating });
    work = transitionCombatUnit(work, address.unitId, (unit) => {
        if (!hasEffects(unit)) {
            return unit;
        }

        let current = replaceEffectInstances(
            unit,
            unit.effects.instances.map((value) => (value === instance ? updated : value)),
        );

        for (const binding of resources.effectBindings.get(updated)) {
            current = binding.setParticipation(current, updated, participating);
        }

        return current;
    });
    const program = resources.effectLifecycle.get(updated);

    return runLifecycleAction(
        work,
        address,
        updated,
        participating ? program.enable : program.disable,
        resources,
        tick,
        scope,
    );
}

export function finishEffect(
    work: CombatWork,
    address: EffectAddress,
    resources: EffectTransitionResources,
    tick: number,
): CombatWork {
    return finishInScope(work, address, resources, tick, { finishing: [] });
}

function finishInScope(
    work: CombatWork,
    address: EffectAddress,
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectLifecycleScope,
): CombatWork {
    if (scope.finishing.some((value) => sameAddress(value, address))) {
        return work;
    }

    const instance = getEffect(work, address);

    if (instance === undefined || instance.finished) {
        return work;
    }

    const finishing = { finishing: [...scope.finishing, address] };
    work = setParticipationInScope(work, address, false, resources, tick, finishing);
    const current = getEffect(work, address);

    if (current === undefined || current.finished) {
        return work;
    }

    work = changeInstance(work, address, (value) => withEffectLifecycle(value, { finished: true }));
    const children = addressesMatching(work, (value) => sameAddress(value.parent, address));

    for (const child of children) {
        work = finishInScope(work, child, resources, tick, finishing);
    }

    return work;
}

export function finalizeEffect(
    work: CombatWork,
    address: EffectAddress,
    resources: EffectTransitionResources,
    tick: number,
): CombatWork {
    const instance = getEffect(work, address);

    if (!instance?.finished) {
        return work;
    }

    work = transitionCombatUnit(work, address.unitId, (unit) => {
        if (!hasEffects(unit)) {
            return unit;
        }

        return replaceEffectInstances(
            unit,
            unit.effects.instances.filter((value) => value.id !== address.instanceId),
        );
    });

    work = runLifecycleAction(
        work,
        address,
        instance,
        resources.effectLifecycle.get(instance).finalize,
        resources,
        tick,
    );

    return transitionCombatUnit(work, address.unitId, (unit) => {
        let current = unit;

        if (instance.started) {
            for (const binding of resources.effectBindings.get(instance)) {
                current = binding.remove(current, instance);
            }
        }

        return current;
    });
}

export function removeEffect(
    work: CombatWork,
    address: EffectAddress,
    resources: EffectTransitionResources,
    tick: number,
): CombatWork {
    return finalizeEffect(finishEffect(work, address, resources, tick), address, resources, tick);
}

export function finalizeFinishedEffects(
    work: CombatWork,
    ownerUnitId: UnitId,
    resources: EffectTransitionResources,
    tick: number,
): CombatWork {
    const addresses = addressesMatching(
        work,
        (_instance, address) => address.unitId === ownerUnitId,
    );

    for (const address of addresses) {
        work = finalizeEffect(work, address, resources, tick);
    }

    return work;
}

export function installEffect(
    work: CombatWork,
    ownerUnitId: UnitId,
    instance: EffectInstanceValue,
    resources: EffectTransitionResources,
    tick: number,
): EffectInstallation {
    const address = Object.freeze({ unitId: ownerUnitId, instanceId: instance.id });

    if (getCombatUnit(work, ownerUnitId) === undefined) {
        return { work, result: { type: "REJECTED", reason: "TARGET_ABSENT", address } };
    }

    resources.effects.assertInstance(instance);
    resources.effectBindings.get(instance);
    work = finalizeFinishedEffects(work, ownerUnitId, resources, tick);
    work = transitionCombatUnit(work, ownerUnitId, (unit) =>
        registerEffectInstance(unit, instance),
    );
    const lifecycle = resources.effectLifecycle.get(instance);
    work = runLifecycleAction(work, address, instance, lifecycle.start, resources, tick);
    let current = getEffect(work, address);

    if (current === undefined) {
        return { work, result: { type: "REJECTED", reason: "START_FINISHED", address } };
    }

    work = changeInstance(work, address, (value) => withEffectLifecycle(value, { started: true }));
    current = getEffect(work, address)!;
    const started = current;
    work = transitionCombatUnit(work, ownerUnitId, (unit) => {
        let updated = unit;

        for (const binding of resources.effectBindings.get(started)) {
            updated = binding.install(updated, started);
        }

        return updated;
    });

    const accepted =
        !current.finished &&
        (lifecycle.accepts?.({ address, instance: current, facts: effectFacts(() => work) }) ??
            true);

    if (!accepted) {
        const reason = current.finished ? "START_FINISHED" : "ADMISSION_REJECTED";
        work = removeEffect(work, address, resources, tick);

        return { work, result: { type: "REJECTED", reason, address } };
    }

    work = setEffectParticipation(work, address, true, resources, tick);
    current = getEffect(work, address);

    if (current === undefined || current.finished) {
        work = finalizeEffect(work, address, resources, tick);

        return { work, result: { type: "REJECTED", reason: "START_FINISHED", address } };
    }

    return { work, result: { type: "INSTALLED", address } };
}

export function attachEffectParent(
    work: CombatWork,
    childAddress: EffectAddress,
    parentAddress: EffectAddress,
    resources: EffectTransitionResources,
    tick: number,
    finishIfParentFinished = true,
): CombatWork {
    return attachParentInScope(
        work,
        childAddress,
        parentAddress,
        resources,
        tick,
        finishIfParentFinished,
        { finishing: [] },
    );
}

function attachParentInScope(
    work: CombatWork,
    childAddress: EffectAddress,
    parentAddress: EffectAddress,
    resources: EffectTransitionResources,
    tick: number,
    finishIfParentFinished: boolean,
    scope: EffectLifecycleScope,
): CombatWork {
    const parent = getEffect(work, parentAddress);
    const child = getEffect(work, childAddress);

    if (parent === undefined || child === undefined || child.finished) {
        return work;
    }
    if (parent.finished) {
        return finishIfParentFinished
            ? finishInScope(work, childAddress, resources, tick, scope)
            : work;
    }
    if (sameAddress(child.parent, parentAddress)) {
        return work;
    }
    if (child.parent !== null) {
        throw new TypeError("effect parent identity cannot be replaced");
    }

    let ancestor: EffectAddress | null = parentAddress;

    while (ancestor !== null) {
        if (sameAddress(ancestor, childAddress)) {
            throw new TypeError("effect parent relationships cannot form a cycle");
        }

        ancestor = getEffect(work, ancestor)?.parent ?? null;
    }

    return changeInstance(work, childAddress, (instance) =>
        withEffectLifecycle(instance, { parent: Object.freeze({ ...parentAddress }) }),
    );
}

export function expireEffects(
    work: CombatWork,
    tick: number,
    resources: EffectTransitionResources,
): CombatWork {
    const expired = addressesMatching(
        work,
        (instance) => instance.expiresAtTick !== null && instance.expiresAtTick <= tick,
    );

    for (const address of expired) {
        work = finishEffect(work, address, resources, tick);
    }

    return work;
}

export function finishEffectsOwnedByUnit(
    work: CombatWork,
    ownerUnitId: UnitId,
    resources: EffectTransitionResources,
    tick: number,
): CombatWork {
    const addresses = addressesMatching(
        work,
        (instance) => instance.lifetimeOwner?.unitId === ownerUnitId,
    );

    for (const address of addresses) {
        work = finishEffect(work, address, resources, tick);
    }

    return work;
}

export function finishEffectsOwnedByExecution(
    work: CombatWork,
    ownerUnitId: UnitId,
    executionId: number,
    resources: EffectTransitionResources,
    tick: number,
): CombatWork {
    const addresses = addressesMatching(
        work,
        (instance) =>
            instance.lifetimeOwner?.type === "EXECUTION" &&
            instance.lifetimeOwner.unitId === ownerUnitId &&
            instance.lifetimeOwner.executionId === executionId,
    );

    for (const address of addresses) {
        work = finishEffect(work, address, resources, tick);
    }

    return work;
}

export function finishEffectsOnUnit(
    work: CombatWork,
    unitId: UnitId,
    resources: EffectTransitionResources,
    tick: number,
): CombatWork {
    const addresses = addressesMatching(work, (_, address) => address.unitId === unitId);

    for (const address of addresses) {
        work = finishEffect(work, address, resources, tick);
    }

    return work;
}

export function removeEffectsOwnedByUnit(
    work: CombatWork,
    ownerUnitId: UnitId,
    resources: EffectTransitionResources,
    tick: number,
): CombatWork {
    const addresses = addressesMatching(
        work,
        (instance) => instance.lifetimeOwner?.unitId === ownerUnitId,
    );
    work = finishEffectsOwnedByUnit(work, ownerUnitId, resources, tick);

    for (const address of addresses) {
        work = finalizeEffect(work, address, resources, tick);
    }

    return work;
}
