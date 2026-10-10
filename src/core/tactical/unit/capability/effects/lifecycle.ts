import {
    battlefieldView,
    getUnit,
    transitionUnit,
    updateUnit,
    updateUnits,
    type BattleState,
} from "../../../battle/execution/context.js";
import type { Unit, UnitId } from "../../unit.js";
import { hasEffects } from "./capability.js";
import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import type {
    EffectInstallation,
    EffectInstallationInput,
    EffectLifecycleContext,
    EffectLifetimeBinding,
    EffectEnd,
    EffectEndReason,
    EffectTransitionResources,
} from "./contract.js";
import {
    effectTick,
    lifetimeKey,
    sameLifetime,
    type EffectRef,
    type LifetimeRef,
    type EffectInstance,
    type EffectInstanceValue,
    type Scope,
} from "./instance.js";
import { ownLifetime, ownScopes, withEffectLifecycle } from "./internal/instance.js";
import {
    registerEffectInstance,
    replaceEffectInstance,
    replaceEffectInstances,
} from "./internal/state.js";
import type { CompiledEffectLifecycle } from "./lifecycle-resources.js";
import { effectView, getEffect } from "./query.js";
import { EffectDispatchScope } from "./dispatch.js";
import { createEffectOperations } from "./operations.js";
import type { EffectProgramRef } from "./program.js";
import { reconcileEffectBindings, transitionEffectBindings } from "./transition.js";
import { effectDependents, effectTickCandidates } from "./lifetime-index.js";

function changeInstance(
    work: BattleState,
    address: EffectRef,
    transition: (instance: EffectInstanceValue) => EffectInstanceValue,
): BattleState {
    return transitionUnit(work, address.unitId, (unit) => {
        if (!hasEffects(unit)) {
            return unit;
        }

        const instance = unit.effects.instances.find((value) => value.id === address.effectId);

        if (instance === undefined) {
            return unit;
        }

        const updated = transition(instance);

        return updated === instance ? unit : replaceEffectInstance(unit, instance, updated);
    });
}

function reconcileInScope(
    work: BattleState,
    ownerUnitId: UnitId,
    before: Unit,
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
    updatedId?: number,
): BattleState {
    const owner = getUnit(work, ownerUnitId);

    if (owner === undefined || !hasEffects(owner)) {
        return work;
    }

    const { unit, changes } = reconcileEffectBindings(before, owner, resources, updatedId);
    work = updateUnit(work, unit);

    return runParticipationActions(
        work,
        changes.map(({ instanceId, participating }) => ({
            address: { type: "EFFECT", unitId: ownerUnitId, effectId: instanceId },
            participating,
        })),
        resources,
        tick,
        scope,
    );
}

function runParticipationActions(
    work: BattleState,
    changes: readonly { address: EffectRef; participating: boolean }[],
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
    beforeEnables?: (work: BattleState) => BattleState,
): BattleState {
    return scope.withParticipationChanges(changes, (isPending) => {
        for (const participating of [false, true]) {
            if (participating) {
                work = beforeEnables?.(work) ?? work;
            }
            for (const [index, change] of changes.entries()) {
                if (!isPending(index) || change.participating !== participating) {
                    continue;
                }

                const { address } = change;
                const current = getEffect(work, address);

                if (
                    current?.participating !== participating ||
                    (participating && current.finished)
                ) {
                    continue;
                }

                const lifecycle = resources.effectLifecycle.get(current);
                scope.consumeParticipationChange(address, participating);
                work = runLifecycleAction(
                    work,
                    address,
                    current,
                    participating ? lifecycle.enable : lifecycle.disable,
                    resources,
                    tick,
                    scope,
                );
            }
        }

        return work;
    });
}

function runLifecycleAction(
    work: BattleState,
    address: EffectRef,
    instance: EffectInstanceValue,
    action: CompiledEffectLifecycle["start"],
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
): BattleState {
    if (action === undefined) {
        return work;
    }

    return scope.withInstance(address, instance, (lastKnown) => {
        let currentWork = work;
        let active = true;

        const readWork = (): BattleState => {
            if (!active) {
                throw new TypeError("effect lifecycle context is no longer active");
            }

            return currentWork;
        };

        const context: EffectLifecycleContext = {
            ref: address,
            get instance() {
                return getEffect(readWork(), address) ?? lastKnown();
            },
            tick,
            facts: effectView(readWork),
            effects: createEffectOperations(readWork, resources, tick, scope),
            damage: (input) => {
                const work = readWork();

                if (resources.settleDamage === undefined) {
                    throw new TypeError("effect damage service is unavailable");
                }

                const result = resources.settleDamage(work, { ...input, tick }, scope);
                currentWork = result.work;

                return result.report;
            },
            heal: (input) => {
                const work = readWork();

                if (resources.settleHealing === undefined) {
                    throw new TypeError("effect healing service is unavailable");
                }

                const result = resources.settleHealing(work, { ...input, tick }, scope);
                currentWork = result.work;

                return result.report;
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

export function updateEffectState<S extends object>(
    work: BattleState,
    ownerUnitId: UnitId,
    instanceId: number,
    ref: EffectProgramRef<S>,
    state: NoInfer<S> | ((current: NoInfer<S>) => NoInfer<S>),
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): BattleState {
    const address: EffectRef = { type: "EFFECT", unitId: ownerUnitId, effectId: instanceId };
    const instance = getEffect(work, address);

    if (instance === undefined || instance.finished) {
        return work;
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
        return work;
    }

    const before = getUnit(work, ownerUnitId)!;
    work = changeInstance(work, address, () => updated);

    return reconcileInScope(
        work,
        ownerUnitId,
        before,
        resources,
        tick,
        dispatch ?? new EffectDispatchScope(),
        instanceId,
    );
}

export function setEffectTick(work: BattleState, ref: EffectRef, tick: number | null): BattleState {
    if (tick !== null) {
        assertNonnegativeSafeInteger(tick, "effect expiration tick");
    }

    return changeInstance(work, ref, (instance) => {
        if (instance.finished || effectTick(instance) === tick) {
            return instance;
        }

        const scopes: Scope[] = instance.scopes.filter((scope) => scope.type !== "TICK");

        if (tick !== null) {
            scopes.push({ type: "TICK", tick });
        }

        return Object.freeze({ ...instance, scopes: ownScopes(scopes) });
    });
}

export function setEffectEnabled(
    work: BattleState,
    address: EffectRef,
    enabled: boolean,
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): BattleState {
    return setEnabledInScope(
        work,
        address,
        enabled,
        resources,
        tick,
        dispatch ?? new EffectDispatchScope(),
    );
}

function setEnabledInScope(
    work: BattleState,
    address: EffectRef,
    enabled: boolean,
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
): BattleState {
    const instance = getEffect(work, address);

    if (instance === undefined || instance.finished || instance.enabled === enabled) {
        return work;
    }

    const before = getUnit(work, address.unitId)!;
    work = changeInstance(work, address, (value) => withEffectLifecycle(value, { enabled }));

    return reconcileInScope(work, address.unitId, before, resources, tick, scope);
}

function compareRefs(left: EffectRef, right: EffectRef): number {
    return left.unitId - right.unitId || left.effectId - right.effectId;
}

interface Ending {
    readonly ref: EffectRef;
    readonly end: EffectEnd;
}

function finishBatch(
    work: BattleState,
    roots: readonly Ending[],
    resources: EffectTransitionResources,
    tick: number,
    dispatch: EffectDispatchScope,
): BattleState {
    const ending = new Map<string, Ending>();
    const pending = [...roots].sort((a, b) => compareRefs(a.ref, b.ref));

    for (const entry of pending) {
        const instance = getEffect(work, entry.ref);
        const key = lifetimeKey(entry.ref);

        if (instance === undefined || instance.finished || ending.has(key)) {
            continue;
        }

        ending.set(key, entry);

        for (const child of effectDependents(work, entry.ref)) {
            pending.push({ ref: child, end: entry.end });
        }
    }

    if (ending.size === 0) {
        return work;
    }

    // A dependent may have several parents; DFS discovery order is not sufficient.
    const indegrees = new Map<string, number>();
    const children = new Map<string, string[]>();

    for (const [key, { ref }] of ending) {
        let count = 0;

        for (const scope of getEffect(work, ref)!.scopes) {
            if (scope.type !== "EFFECT" || !ending.has(lifetimeKey(scope))) {
                continue;
            }

            count++;
            const parentKey = lifetimeKey(scope);
            const bucket = children.get(parentKey) ?? [];
            bucket.push(key);
            children.set(parentKey, bucket);
        }

        indegrees.set(key, count);
    }

    // A local min-heap preserves stable identity order without sorting every dequeue.
    const ready: string[] = [];
    const before = (left: string, right: string): boolean =>
        compareRefs(ending.get(left)!.ref, ending.get(right)!.ref) < 0;

    const enqueue = (key: string): void => {
        let index = ready.length;
        ready.push(key);

        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);

            if (!before(key, ready[parent]!)) {
                break;
            }

            ready[index] = ready[parent]!;
            index = parent;
        }

        ready[index] = key;
    };
    const dequeue = (): string => {
        const first = ready[0]!;
        const last = ready.pop()!;

        if (ready.length > 0) {
            let index = 0;

            while (index * 2 + 1 < ready.length) {
                let child = index * 2 + 1;

                if (child + 1 < ready.length && before(ready[child + 1]!, ready[child]!)) {
                    child++;
                }
                if (!before(ready[child]!, last)) {
                    break;
                }

                ready[index] = ready[child]!;
                index = child;
            }

            ready[index] = last;
        }

        return first;
    };

    for (const key of ending.keys()) {
        if (indegrees.get(key) === 0) {
            enqueue(key);
        }
    }

    const ordered: Ending[] = [];

    while (ready.length > 0) {
        const key = dequeue();
        ordered.push(ending.get(key)!);

        for (const child of children.get(key) ?? []) {
            const remaining = indegrees.get(child)! - 1;
            indegrees.set(child, remaining);

            if (remaining === 0) {
                enqueue(child);
            }
        }
    }

    if (ordered.length !== ending.size) {
        throw new TypeError("effect scopes cannot form a cycle");
    }

    const byHost = new Map<UnitId, Set<number>>();

    for (const { ref } of ordered) {
        const ids = byHost.get(ref.unitId) ?? new Set<number>();
        ids.add(ref.effectId);
        byHost.set(ref.unitId, ids);
    }

    dispatch.beginEnds(ordered.map(({ ref }) => ref));
    const owners = [...byHost.keys()].sort((a, b) => a - b).map((id) => getUnit(work, id)!);
    work = updateUnits(
        work,
        owners.map((owner) => {
            if (!hasEffects(owner)) {
                return owner;
            }

            const ids = byHost.get(owner.id)!;

            return replaceEffectInstances(
                owner,
                owner.effects.instances.map((instance) =>
                    ids.has(instance.id)
                        ? withEffectLifecycle(instance, { finished: true, participating: false })
                        : instance,
                ),
            );
        }),
    );
    const changes: { address: EffectRef; participating: boolean }[] = [];
    work = updateUnits(
        work,
        owners.map((before) => {
            const result = reconcileEffectBindings(before, getUnit(work, before.id)!, resources);
            changes.push(
                ...result.changes.map(({ instanceId, participating }) => ({
                    address: { type: "EFFECT" as const, unitId: before.id, effectId: instanceId },
                    participating,
                })),
            );

            return result.unit;
        }),
    );
    const order = new Map(ordered.map(({ ref }, index) => [lifetimeKey(ref), index]));
    changes.sort(
        (a, b) =>
            (order.get(lifetimeKey(a.address)) ?? order.size) -
                (order.get(lifetimeKey(b.address)) ?? order.size) ||
            compareRefs(a.address, b.address),
    );
    work = runParticipationActions(work, changes, resources, tick, dispatch, (currentWork) => {
        work = currentWork;

        for (const { ref, end } of ordered) {
            const current = getEffect(work, ref)!;
            const finish = resources.effectLifecycle.get(current).finish;

            if (finish !== undefined) {
                work = runLifecycleAction(
                    work,
                    ref,
                    current,
                    (context) => {
                        finish({
                            ...context,
                            end,
                            get instance() {
                                return context.instance;
                            },
                        });
                    },
                    resources,
                    tick,
                    dispatch,
                );
            }

            dispatch.completeEnd(ref);
        }

        return work;
    });

    return dispatch.drainDeferred(work);
}

export function finishEffects(
    work: BattleState,
    refs: readonly EffectRef[],
    resources: EffectTransitionResources,
    tick: number,
    reason: EffectEndReason = "EXPLICIT",
    dispatch = new EffectDispatchScope(),
): BattleState {
    return finishBatch(
        work,
        refs.map((ref) => ({ ref, end: { root: ref, reason } })),
        resources,
        tick,
        dispatch,
    );
}

export function finishEffect(
    work: BattleState,
    ref: EffectRef,
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): BattleState {
    return finishEffects(work, [ref], resources, tick, "EXPLICIT", dispatch);
}

export function closeEffectLifetimes(
    work: BattleState,
    lifetimes: readonly LifetimeRef[],
    resources: EffectTransitionResources,
    tick: number,
    reason: EffectEndReason = "SCOPE_CLOSED",
    dispatch = new EffectDispatchScope(),
): BattleState {
    const owned = lifetimes.map(ownLifetime);
    dispatch.markClosing(owned);
    const roots: Ending[] = [];

    for (const root of owned) {
        for (const ref of effectDependents(work, root)) {
            roots.push({ ref, end: { root, reason } });
        }
        if (root.type === "UNIT") {
            const host = getUnit(work, root.unitId);

            if (host !== undefined && hasEffects(host)) {
                for (const instance of host.effects.instances) {
                    roots.push({
                        ref: { type: "EFFECT", unitId: host.id, effectId: instance.id },
                        end: { root, reason },
                    });
                }
            }
        }
    }

    return finishBatch(work, roots, resources, tick, dispatch);
}

function cleanupEffects(
    work: BattleState,
    unitId: UnitId,
    refs: readonly EffectRef[],
    resources: EffectTransitionResources,
    dispatch: EffectDispatchScope,
): BattleState {
    const host = getUnit(work, unitId);

    if (host === undefined || !hasEffects(host)) {
        return work;
    }

    const selected = new Set(refs.map((ref) => ref.effectId));
    const instances = host.effects.instances.filter(
        (instance) =>
            instance.finished &&
            selected.has(instance.id) &&
            !dispatch.hasPendingEnd({ type: "EFFECT", unitId, effectId: instance.id }),
    );

    if (instances.length === 0) {
        return work;
    }

    const removed = new Set(instances.map((instance) => instance.id));
    let unit = replaceEffectInstances(
        host,
        host.effects.instances.filter((instance) => !removed.has(instance.id)),
    );

    for (const instance of instances) {
        dispatch.retainFinalizedInstance(
            { type: "EFFECT", unitId, effectId: instance.id },
            instance,
        );

        if (instance.started) {
            unit = transitionEffectBindings(
                unit,
                instance,
                resources.effectBindings,
                (binding, current) => binding.remove(current, instance),
            );
        }
    }

    return updateUnit(work, unit);
}

export function finalizeEffect(
    work: BattleState,
    ref: EffectRef,
    resources: EffectTransitionResources,
    _tick: number,
    dispatch = new EffectDispatchScope(),
): BattleState {
    return cleanupEffects(work, ref.unitId, [ref], resources, dispatch);
}

export function finalizeFinishedEffects(
    work: BattleState,
    unitId: UnitId,
    resources: EffectTransitionResources,
    _tick: number,
    dispatch = new EffectDispatchScope(),
): BattleState {
    const unit = getUnit(work, unitId);

    if (unit === undefined || !hasEffects(unit)) {
        return work;
    }

    const refs: EffectRef[] = unit.effects.instances
        .filter((instance) => instance.finished)
        .map((instance) => ({ type: "EFFECT", unitId, effectId: instance.id }));

    return cleanupEffects(work, unitId, refs, resources, dispatch);
}

export function removeEffect(
    work: BattleState,
    ref: EffectRef,
    resources: EffectTransitionResources,
    tick: number,
    dispatch = new EffectDispatchScope(),
): BattleState {
    return finalizeEffect(
        finishEffects(work, [ref], resources, tick, "EXPLICIT", dispatch),
        ref,
        resources,
        tick,
        dispatch,
    );
}

function lifetimeAvailable(
    work: BattleState,
    lifetime: LifetimeRef,
    dispatch: EffectDispatchScope,
): boolean {
    if (dispatch.isClosing(lifetime)) {
        return false;
    }
    switch (lifetime.type) {
        case "UNIT":
            return getUnit(work, lifetime.unitId) !== undefined;

        case "ACTION":
            return work.actionExecutions?.get(lifetime.executionId) !== undefined;

        case "SKILL":
            return getUnit(work, lifetime.unitId)?.skill?.active?.id === lifetime.activationId;

        case "EFFECT": {
            const effect = getEffect(work, lifetime);

            return effect !== undefined && !effect.finished;
        }
    }
}

function wouldCycle(work: BattleState, ref: EffectRef, lifetime: LifetimeRef): boolean {
    if (lifetime.type !== "EFFECT") {
        return false;
    }

    const pending: EffectRef[] = [lifetime];
    const seen = new Set<string>();

    while (pending.length > 0) {
        const current = pending.pop()!;

        if (sameLifetime(current, ref)) {
            return true;
        }

        const key = lifetimeKey(current);

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);

        for (const scope of getEffect(work, current)?.scopes ?? []) {
            if (scope.type === "EFFECT") {
                pending.push(scope);
            }
        }
    }

    return false;
}

export function bindEffectLifetime(
    work: BattleState,
    ref: EffectRef,
    lifetime: LifetimeRef,
    dispatch = new EffectDispatchScope(),
): EffectLifetimeBinding {
    lifetime = ownLifetime(lifetime);
    const instance = getEffect(work, ref);

    if (instance === undefined) {
        return { work, result: { type: "EFFECT_ABSENT" } };
    }
    if (instance.finished) {
        return { work, result: { type: "EFFECT_FINISHED" } };
    }
    if (!lifetimeAvailable(work, lifetime, dispatch)) {
        return { work, result: { type: "LIFETIME_UNAVAILABLE" } };
    }
    if (wouldCycle(work, ref, lifetime)) {
        throw new TypeError("effect scopes cannot form a cycle");
    }
    if (!instance.scopes.some((scope) => sameLifetime(scope, lifetime))) {
        work = changeInstance(work, ref, (instance) =>
            Object.freeze({ ...instance, scopes: ownScopes([...instance.scopes, lifetime]) }),
        );
    }

    return { work, result: { type: "BOUND" } };
}

export function installEffect<S extends object>(
    work: BattleState,
    unitId: UnitId,
    instance: EffectInstance<S>,
    resources: EffectTransitionResources,
    tick: number,
    dispatch = new EffectDispatchScope(),
): EffectInstallation {
    if (getUnit(work, unitId) === undefined) {
        return { work, result: { type: "REJECTED", reason: "TARGET_ABSENT" } };
    }

    const prepared = resources.effects.restore(instance.programRef, instance);

    return installPrepared(work, unitId, prepared, resources, tick, dispatch);
}

export function installNewEffect<S extends object>(
    work: BattleState,
    unitId: UnitId,
    program: EffectProgramRef<S>,
    input: EffectInstallationInput<NoInfer<S>>,
    resources: EffectTransitionResources,
    tick: number,
    dispatch = new EffectDispatchScope(),
): EffectInstallation {
    const scopes = ownScopes(input.scopes);
    const host = getUnit(work, unitId);

    if (host === undefined) {
        return { work, result: { type: "REJECTED", reason: "TARGET_ABSENT" } };
    }
    if (dispatch.isClosing({ type: "UNIT", unitId })) {
        return { work, result: { type: "REJECTED", reason: "TARGET_CLOSING" } };
    }
    if (
        scopes.some((scope) => scope.type !== "TICK" && !lifetimeAvailable(work, scope, dispatch))
    ) {
        return { work, result: { type: "REJECTED", reason: "LIFETIME_UNAVAILABLE" } };
    }

    const instance = resources.effects.create(
        program,
        {
            source: input.source,
            scopes,
            id: host.effects?.nextInstanceId ?? 0,
            acquiredSequence: host.effects?.nextAcquiredSequence ?? 0,
        },
        input.initialState,
    );

    return installPrepared(work, unitId, instance, resources, tick, dispatch);
}

function installPrepared<S extends object>(
    work: BattleState,
    unitId: UnitId,
    instance: EffectInstance<S>,
    resources: EffectTransitionResources,
    tick: number,
    dispatch: EffectDispatchScope,
): EffectInstallation {
    const ref: EffectRef = Object.freeze({ type: "EFFECT", unitId, effectId: instance.id });

    if (getUnit(work, unitId) === undefined) {
        return { work, result: { type: "REJECTED", reason: "TARGET_ABSENT" } };
    }
    if (dispatch.isClosing({ type: "UNIT", unitId })) {
        return { work, result: { type: "REJECTED", reason: "TARGET_CLOSING" } };
    }
    for (const scope of instance.scopes) {
        if (scope.type === "TICK") {
            continue;
        }
        if (wouldCycle(work, ref, scope)) {
            throw new TypeError("effect scopes cannot form a cycle");
        }
        if (!lifetimeAvailable(work, scope, dispatch)) {
            return { work, result: { type: "REJECTED", reason: "LIFETIME_UNAVAILABLE" } };
        }
    }

    const lifecycle = resources.effectLifecycle.get(instance);

    if (!(lifecycle.accepts?.({ unitId, instance, facts: effectView(() => work) }) ?? true)) {
        return { work, result: { type: "REJECTED", reason: "ADMISSION_REJECTED" } };
    }

    resources.effectBindings.get(instance);
    work = finalizeFinishedEffects(work, unitId, resources, tick, dispatch);

    // Cleanup callbacks may have retired the host or closed a dependency.
    if (getUnit(work, unitId) === undefined || dispatch.isClosing({ type: "UNIT", unitId })) {
        return { work, result: { type: "REJECTED", reason: "TARGET_CLOSING" } };
    }
    if (
        instance.scopes.some(
            (scope) => scope.type !== "TICK" && !lifetimeAvailable(work, scope, dispatch),
        )
    ) {
        return { work, result: { type: "REJECTED", reason: "LIFETIME_UNAVAILABLE" } };
    }

    work = transitionUnit(work, unitId, (unit) => registerEffectInstance(unit, instance));
    work = runLifecycleAction(work, ref, instance, lifecycle.start, resources, tick, dispatch);
    let current = getEffect(work, ref);

    if (current === undefined || current.finished) {
        return { work, result: { type: "ENDED", ref } };
    }

    work = changeInstance(work, ref, (value) => withEffectLifecycle(value, { started: true }));
    current = getEffect(work, ref)!;
    const started = current;
    work = transitionUnit(work, unitId, (unit) =>
        transitionEffectBindings(unit, started, resources.effectBindings, (binding, current) =>
            binding.install(current, started),
        ),
    );
    work = reconcileInScope(work, unitId, getUnit(work, unitId)!, resources, tick, dispatch);
    current = getEffect(work, ref);

    return {
        work,
        result: { type: current === undefined || current.finished ? "ENDED" : "INSTALLED", ref },
    };
}

export function expireEffects(
    work: BattleState,
    tick: number,
    resources: EffectTransitionResources,
    dispatch = new EffectDispatchScope(),
): BattleState {
    const candidates = effectTickCandidates(work).filter((ref) => {
        const instance = getEffect(work, ref);
        const deadline = instance === undefined ? null : effectTick(instance);

        return (
            instance !== undefined && !instance.finished && deadline !== null && deadline <= tick
        );
    });

    for (const ref of candidates) {
        const current = getEffect(work, ref);
        const deadline = current === undefined ? null : effectTick(current);

        if (current === undefined || current.finished || deadline === null || deadline > tick) {
            continue;
        }

        const expire = resources.effectLifecycle.get(current).expire;
        work =
            expire === undefined
                ? finishEffects(work, [ref], resources, tick, "EXPIRED", dispatch)
                : runLifecycleAction(work, ref, current, expire, resources, tick, dispatch);
        const remaining = getEffect(work, ref);
        const next = remaining === undefined ? null : effectTick(remaining);

        if (remaining !== undefined && !remaining.finished && next !== null && next <= tick) {
            throw new TypeError("effect expiration action must resolve its expired deadline");
        }
    }

    return work;
}

/** Validate references once after a complete world has been initialized or restored. */
export function validateEffectLifetimes(work: BattleState): void {
    const dispatch = new EffectDispatchScope();

    for (const unitId of battlefieldView(work).unitIds) {
        const host = getUnit(work, unitId)!;

        if (!hasEffects(host)) {
            continue;
        }
        for (const instance of host.effects.instances) {
            if (instance.finished) {
                continue;
            }

            const ref: EffectRef = { type: "EFFECT", unitId, effectId: instance.id };

            for (const scope of instance.scopes) {
                if (scope.type === "TICK") {
                    continue;
                }
                if (wouldCycle(work, ref, scope)) {
                    throw new TypeError("effect scopes cannot form a cycle");
                }
                if (!lifetimeAvailable(work, scope, dispatch)) {
                    throw new TypeError(`unavailable effect scope ${lifetimeKey(scope)}`);
                }
            }
        }
    }
}
