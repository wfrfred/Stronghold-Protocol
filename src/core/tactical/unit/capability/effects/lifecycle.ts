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
    EffectInstallationInput,
    EffectLifecycleContext,
    EffectParentBinding,
    EffectTransitionResources,
} from "./contract.js";
import type { EffectAddress, EffectInstance, EffectInstanceValue } from "./instance.js";
import { withEffectLifecycle } from "./internal/instance.js";
import {
    registerEffectInstance,
    removeEffectInstance,
    replaceEffectInstance,
} from "./internal/state.js";
import type { CompiledEffectLifecycle } from "./lifecycle-resources.js";
import { effectFacts, getEffect } from "./query.js";
import { EffectDispatchScope } from "./dispatch.js";
import type { EffectProgramRef } from "./program.js";
import { updateEffectState } from "./transition.js";
import {
    effectAddressesOwnedByExecution,
    effectAddressesOwnedByUnit,
    effectChildAddresses,
} from "./lifetime-index.js";

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

        return updated === instance ? unit : replaceEffectInstance(unit, instance, updated);
    });
}

function changeParticipation(
    work: CombatWork,
    address: EffectAddress,
    instance: EffectInstanceValue,
    updated: EffectInstanceValue,
    resources: EffectTransitionResources,
): CombatWork {
    return transitionCombatUnit(work, address.unitId, (unit) => {
        if (!hasEffects(unit)) {
            return unit;
        }

        const current = replaceEffectInstance(unit, instance, updated);

        return instance.started && instance.participating !== updated.participating
            ? resources.effectBindings.transition(current, updated, (binding, value) =>
                  binding.setParticipation(value, updated, updated.participating),
              )
            : current;
    });
}

function runLifecycleAction(
    work: CombatWork,
    address: EffectAddress,
    instance: EffectInstanceValue,
    action: CompiledEffectLifecycle["start"],
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
): CombatWork {
    if (action === undefined) {
        return work;
    }

    return scope.withInstance(address, instance, (lastKnown) => {
        let currentWork = work;
        let active = true;

        const readWork = (): CombatWork => {
            if (!active) {
                throw new TypeError("effect lifecycle context is no longer active");
            }

            return currentWork;
        };

        const context: EffectLifecycleContext = {
            address,
            get instance() {
                return getEffect(readWork(), address) ?? lastKnown();
            },
            tick,
            facts: effectFacts(readWork),
            effects: {
                install: (unitId, ref, input) => {
                    const installation = installNewInScope(
                        readWork(),
                        unitId,
                        ref,
                        input,
                        resources,
                        tick,
                        scope,
                    );
                    currentWork = installation.work;

                    return installation.result;
                },
                update: (target, ref, transition) => {
                    currentWork = updateEffectState(
                        readWork(),
                        target.unitId,
                        target.instanceId,
                        ref,
                        transition,
                        resources,
                    );
                },
                setParticipation: (target, participating) => {
                    currentWork = setParticipationInScope(
                        readWork(),
                        target,
                        participating,
                        resources,
                        tick,
                        scope,
                    );
                },
                finish: (target) => {
                    currentWork = finishInScope(readWork(), target, resources, tick, scope);
                },
                attachParent: (child, parent, finishIfParentFinished) => {
                    const binding = attachParentInScope(
                        readWork(),
                        child,
                        parent,
                        resources,
                        tick,
                        finishIfParentFinished ?? true,
                        scope,
                    );
                    currentWork = binding.work;

                    return binding.result;
                },
            },
        };

        try {
            action(context);

            return currentWork;
        } finally {
            active = false;
        }
    });
}

export function setEffectParticipation(
    work: CombatWork,
    address: EffectAddress,
    participating: boolean,
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): CombatWork {
    return setParticipationInScope(
        work,
        address,
        participating,
        resources,
        tick,
        dispatch ?? new EffectDispatchScope(),
    );
}

function setParticipationInScope(
    work: CombatWork,
    address: EffectAddress,
    participating: boolean,
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
): CombatWork {
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
    work = changeParticipation(work, address, instance, updated, resources);
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
    dispatch?: EffectDispatchScope,
): CombatWork {
    return finishInScope(work, address, resources, tick, dispatch ?? new EffectDispatchScope());
}

function finishInScope(
    work: CombatWork,
    address: EffectAddress,
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
): CombatWork {
    const instance = getEffect(work, address);

    if (instance === undefined || instance.finished) {
        return work;
    }

    const finished = withEffectLifecycle(instance, { participating: false, finished: true });
    work = changeParticipation(work, address, instance, finished, resources);

    if (instance.started && instance.participating) {
        work = runLifecycleAction(
            work,
            address,
            finished,
            resources.effectLifecycle.get(finished).disable,
            resources,
            tick,
            scope,
        );
    }

    const children = effectChildAddresses(work, address);

    for (const child of children) {
        work = finishInScope(work, child, resources, tick, scope);
    }

    return work;
}

export function finalizeEffect(
    work: CombatWork,
    address: EffectAddress,
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): CombatWork {
    return finalizeInScope(work, address, resources, tick, dispatch ?? new EffectDispatchScope());
}

function finalizeInScope(
    work: CombatWork,
    address: EffectAddress,
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
): CombatWork {
    const instance = getEffect(work, address);

    if (!instance?.finished) {
        return work;
    }

    scope.retainFinalizedInstance(address, instance);
    work = transitionCombatUnit(work, address.unitId, (unit) => {
        if (!hasEffects(unit)) {
            return unit;
        }

        return removeEffectInstance(unit, address.instanceId);
    });

    work = runLifecycleAction(
        work,
        address,
        instance,
        resources.effectLifecycle.get(instance).finalize,
        resources,
        tick,
        scope,
    );

    return instance.started
        ? transitionCombatUnit(work, address.unitId, (unit) =>
              resources.effectBindings.transition(unit, instance, (binding, current) =>
                  binding.remove(current, instance),
              ),
          )
        : work;
}

export function removeEffect(
    work: CombatWork,
    address: EffectAddress,
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): CombatWork {
    return removeInScope(work, address, resources, tick, dispatch ?? new EffectDispatchScope());
}

function removeInScope(
    work: CombatWork,
    address: EffectAddress,
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
): CombatWork {
    return finalizeInScope(
        finishInScope(work, address, resources, tick, scope),
        address,
        resources,
        tick,
        scope,
    );
}

export function finalizeFinishedEffects(
    work: CombatWork,
    ownerUnitId: UnitId,
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): CombatWork {
    return finalizeFinishedInScope(
        work,
        ownerUnitId,
        resources,
        tick,
        dispatch ?? new EffectDispatchScope(),
    );
}

function finalizeFinishedInScope(
    work: CombatWork,
    ownerUnitId: UnitId,
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
): CombatWork {
    const owner = getCombatUnit(work, ownerUnitId);

    if (
        owner === undefined ||
        !hasEffects(owner) ||
        !owner.effects.instances.some((instance) => instance.finished)
    ) {
        return work;
    }

    const addresses = owner.effects.instances.map((instance) => ({
        unitId: ownerUnitId,
        instanceId: instance.id,
    }));

    for (const address of addresses) {
        work = finalizeInScope(work, address, resources, tick, scope);
    }

    return work;
}

export function installEffect<S extends object>(
    work: CombatWork,
    ownerUnitId: UnitId,
    instance: EffectInstance<S>,
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): EffectInstallation {
    const scope = dispatch ?? new EffectDispatchScope();

    if (getCombatUnit(work, ownerUnitId) !== undefined) {
        work = finalizeFinishedInScope(work, ownerUnitId, resources, tick, scope);
    }

    const prepared =
        getCombatUnit(work, ownerUnitId) === undefined
            ? instance
            : resources.effects.restore(instance.programRef, instance);

    return installInScope(work, ownerUnitId, prepared, resources, tick, scope);
}

export function installNewEffect<S extends object>(
    work: CombatWork,
    ownerUnitId: UnitId,
    ref: EffectProgramRef<S>,
    input: EffectInstallationInput<NoInfer<S>>,
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): EffectInstallation {
    return installNewInScope(
        work,
        ownerUnitId,
        ref,
        input,
        resources,
        tick,
        dispatch ?? new EffectDispatchScope(),
    );
}

function installNewInScope<S extends object>(
    work: CombatWork,
    ownerUnitId: UnitId,
    ref: EffectProgramRef<S>,
    input: EffectInstallationInput<NoInfer<S>>,
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
): EffectInstallation {
    if (getCombatUnit(work, ownerUnitId) !== undefined) {
        work = finalizeFinishedInScope(work, ownerUnitId, resources, tick, scope);
    }

    const unit = getCombatUnit(work, ownerUnitId);
    const progress = unit !== undefined && hasEffects(unit) ? unit.effects : undefined;
    const instance = resources.effects.create(
        ref,
        {
            source: input.source,
            scope: input.scope,
            expiresAtTick: input.expiresAtTick,
            id: progress?.nextInstanceId ?? 0,
            acquiredSequence: progress?.nextAcquiredSequence ?? 0,
        },
        input.initialState,
    );

    return installInScope(work, ownerUnitId, instance, resources, tick, scope);
}

function installInScope<S extends object>(
    work: CombatWork,
    ownerUnitId: UnitId,
    instance: EffectInstance<S>,
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
): EffectInstallation {
    const address = Object.freeze({ unitId: ownerUnitId, instanceId: instance.id });

    if (getCombatUnit(work, ownerUnitId) === undefined) {
        return { work, result: { type: "REJECTED", reason: "TARGET_ABSENT", address } };
    }

    resources.effectBindings.get(instance);
    work = transitionCombatUnit(work, ownerUnitId, (unit) =>
        registerEffectInstance(unit, instance),
    );
    const lifecycle = resources.effectLifecycle.get(instance);
    work = runLifecycleAction(work, address, instance, lifecycle.start, resources, tick, scope);
    let current = getEffect(work, address);

    if (current === undefined) {
        return { work, result: { type: "REJECTED", reason: "START_FINISHED", address } };
    }
    if (current.finished) {
        work = finalizeInScope(work, address, resources, tick, scope);

        return { work, result: { type: "REJECTED", reason: "START_FINISHED", address } };
    }

    work = changeInstance(work, address, (value) => withEffectLifecycle(value, { started: true }));
    current = getEffect(work, address)!;
    const started = current;
    work = transitionCombatUnit(work, ownerUnitId, (unit) =>
        resources.effectBindings.transition(unit, started, (binding, current) =>
            binding.install(current, started),
        ),
    );

    const accepted =
        !current.finished &&
        (lifecycle.accepts?.({
            address,
            instance: current,
            facts: effectFacts(() => work),
        }) ??
            true);

    if (!accepted) {
        const reason = current.finished ? "START_FINISHED" : "ADMISSION_REJECTED";
        work = removeInScope(work, address, resources, tick, scope);

        return { work, result: { type: "REJECTED", reason, address } };
    }

    work = setParticipationInScope(work, address, true, resources, tick, scope);
    current = getEffect(work, address);

    if (current === undefined || current.finished) {
        work = finalizeInScope(work, address, resources, tick, scope);

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
    dispatch?: EffectDispatchScope,
): EffectParentBinding {
    return attachParentInScope(
        work,
        childAddress,
        parentAddress,
        resources,
        tick,
        finishIfParentFinished,
        dispatch ?? new EffectDispatchScope(),
    );
}

function attachParentInScope(
    work: CombatWork,
    childAddress: EffectAddress,
    parentAddress: EffectAddress,
    resources: EffectTransitionResources,
    tick: number,
    finishIfParentFinished: boolean,
    scope: EffectDispatchScope,
): EffectParentBinding {
    const child = getEffect(work, childAddress);

    if (child === undefined) {
        return { work, result: { type: "CHILD_ABSENT" } };
    }
    if (child.finished) {
        return { work, result: { type: "CHILD_FINISHED" } };
    }

    const parent = getEffect(work, parentAddress);

    if (parent === undefined || parent.finished) {
        if (finishIfParentFinished) {
            work = finishInScope(work, childAddress, resources, tick, scope);
        }

        return {
            work,
            result: {
                type: "PARENT_UNAVAILABLE",
                reason: parent === undefined ? "ABSENT" : "FINISHED",
            },
        };
    }
    if (sameAddress(child.parent, parentAddress)) {
        return { work, result: { type: "BOUND" } };
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

    work = changeInstance(work, childAddress, (instance) =>
        withEffectLifecycle(instance, { parent: Object.freeze({ ...parentAddress }) }),
    );

    return { work, result: { type: "BOUND" } };
}

export function expireEffects(
    work: CombatWork,
    tick: number,
    resources: EffectTransitionResources,
    dispatch?: EffectDispatchScope,
): CombatWork {
    const scope = dispatch ?? new EffectDispatchScope();
    const expired = addressesMatching(
        work,
        (instance) => instance.expiresAtTick !== null && instance.expiresAtTick <= tick,
    );

    for (const address of expired) {
        work = finishInScope(work, address, resources, tick, scope);
    }

    return work;
}

export function finishEffectsOwnedByUnit(
    work: CombatWork,
    ownerUnitId: UnitId,
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): CombatWork {
    const scope = dispatch ?? new EffectDispatchScope();
    const addresses = effectAddressesOwnedByUnit(work, ownerUnitId);

    for (const address of addresses) {
        work = finishInScope(work, address, resources, tick, scope);
    }

    return work;
}

export function finishEffectsOwnedByExecution(
    work: CombatWork,
    ownerUnitId: UnitId,
    executionId: number,
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): CombatWork {
    const scope = dispatch ?? new EffectDispatchScope();
    const addresses = effectAddressesOwnedByExecution(work, ownerUnitId, executionId);

    for (const address of addresses) {
        work = finishInScope(work, address, resources, tick, scope);
    }

    return work;
}

export function finishEffectsOnUnit(
    work: CombatWork,
    unitId: UnitId,
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): CombatWork {
    const scope = dispatch ?? new EffectDispatchScope();
    const unit = getCombatUnit(work, unitId);

    if (unit === undefined || !hasEffects(unit)) {
        return work;
    }

    const addresses = unit.effects.instances.map((instance) => ({
        unitId,
        instanceId: instance.id,
    }));

    for (const address of addresses) {
        work = finishInScope(work, address, resources, tick, scope);
    }

    return work;
}

export function removeEffectsOwnedByUnit(
    work: CombatWork,
    ownerUnitId: UnitId,
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): CombatWork {
    const scope = dispatch ?? new EffectDispatchScope();
    const addresses = effectAddressesOwnedByUnit(work, ownerUnitId);

    for (const address of addresses) {
        work = finishInScope(work, address, resources, tick, scope);
    }

    for (const address of addresses) {
        work = finalizeInScope(work, address, resources, tick, scope);
    }

    return work;
}
