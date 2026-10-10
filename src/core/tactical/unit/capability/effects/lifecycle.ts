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
    EffectInstallationResult,
    EffectInstallationInput,
    EffectLifecycleContext,
    EffectBindingResult,
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
import { validateLifetime, withEffectLifecycle } from "./internal/instance.js";
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
    state: BattleState,
    address: EffectRef,
    transition: (instance: EffectInstanceValue) => EffectInstanceValue,
): void {
    transitionUnit(state, address.unitId, (unit) => {
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
    state: BattleState,
    ownerUnitId: UnitId,
    before: Unit,
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
    updatedId?: number,
): void {
    const owner = getUnit(state, ownerUnitId);

    if (owner === undefined || !hasEffects(owner)) {
        return;
    }

    const { unit, changes } = reconcileEffectBindings(before, owner, resources, updatedId);
    updateUnit(state, unit);

    runParticipationActions(
        state,
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
    state: BattleState,
    changes: readonly { address: EffectRef; participating: boolean }[],
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
    beforeEnables?: () => void,
): void {
    scope.withParticipationChanges(changes, (isPending) => {
        for (const participating of [false, true]) {
            if (participating) {
                beforeEnables?.();
            }
            for (const [index, change] of changes.entries()) {
                if (!isPending(index) || change.participating !== participating) {
                    continue;
                }

                const { address } = change;
                const current = getEffect(state, address);

                if (
                    current?.participating !== participating ||
                    (participating && current.finished)
                ) {
                    continue;
                }

                const lifecycle = resources.effectLifecycle.get(current);
                scope.consumeParticipationChange(address, participating);
                runLifecycleAction(
                    state,
                    address,
                    current,
                    participating ? lifecycle.enable : lifecycle.disable,
                    resources,
                    tick,
                    scope,
                );
            }
        }
    });
}

function runLifecycleAction(
    state: BattleState,
    address: EffectRef,
    instance: EffectInstanceValue,
    action: CompiledEffectLifecycle["start"],
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
): void {
    if (action === undefined) {
        return;
    }

    scope.withInstance(address, instance, (lastKnown) => {
        let active = true;

        const readState = (): BattleState => {
            if (!active) {
                throw new TypeError("effect lifecycle context is no longer active");
            }

            return state;
        };

        const context: EffectLifecycleContext = {
            ref: address,
            get instance() {
                return getEffect(readState(), address) ?? lastKnown();
            },
            tick,
            facts: effectView(readState),
            get battlefield() {
                return battlefieldView(readState());
            },
            effects: createEffectOperations(readState, resources, tick, scope),
            damage: (input) => {
                const state = readState();

                if (resources.settleDamage === undefined) {
                    throw new TypeError("effect damage service is unavailable");
                }

                return resources.settleDamage(state, { ...input, tick }, scope);
            },
            heal: (input) => {
                const state = readState();

                if (resources.settleHealing === undefined) {
                    throw new TypeError("effect healing service is unavailable");
                }

                return resources.settleHealing(state, { ...input, tick }, scope);
            },
        };

        try {
            action(context);
        } finally {
            active = false;
        }
    });
}

export function updateEffectState<S extends object>(
    state: BattleState,
    ownerUnitId: UnitId,
    instanceId: number,
    ref: EffectProgramRef<S>,
    value: NoInfer<S> | ((current: NoInfer<S>) => NoInfer<S>),
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): void {
    const address: EffectRef = { type: "EFFECT", unitId: ownerUnitId, effectId: instanceId };
    const instance = getEffect(state, address);

    if (instance === undefined || instance.finished) {
        return;
    }

    const typed = resources.effects.typedInstance(instance, ref);

    if (typed === undefined) {
        throw new TypeError("effect state update must use its matching program");
    }

    const updated = resources.effects.update(
        typed,
        typeof value === "function" ? value(typed.state) : value,
    );

    if (updated === instance) {
        return;
    }

    const before = getUnit(state, ownerUnitId)!;
    changeInstance(state, address, () => updated);

    reconcileInScope(
        state,
        ownerUnitId,
        before,
        resources,
        tick,
        dispatch ?? new EffectDispatchScope(),
        instanceId,
    );
}

export function setEffectTick(state: BattleState, ref: EffectRef, tick: number | null): void {
    if (tick !== null) {
        assertNonnegativeSafeInteger(tick, "effect expiration tick");
    }

    changeInstance(state, ref, (instance) => {
        if (instance.finished || effectTick(instance) === tick) {
            return instance;
        }

        const scopes: Scope[] = instance.scopes.filter((scope) => scope.type !== "TICK");

        if (tick !== null) {
            scopes.push({ type: "TICK", tick });
        }

        return { ...instance, scopes };
    });
}

export function setEffectEnabled(
    state: BattleState,
    address: EffectRef,
    enabled: boolean,
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): void {
    setEnabledInScope(
        state,
        address,
        enabled,
        resources,
        tick,
        dispatch ?? new EffectDispatchScope(),
    );
}

function setEnabledInScope(
    state: BattleState,
    address: EffectRef,
    enabled: boolean,
    resources: EffectTransitionResources,
    tick: number,
    scope: EffectDispatchScope,
): void {
    const instance = getEffect(state, address);

    if (instance === undefined || instance.finished || instance.enabled === enabled) {
        return;
    }

    const before = getUnit(state, address.unitId)!;
    changeInstance(state, address, (value) => withEffectLifecycle(value, { enabled }));

    reconcileInScope(state, address.unitId, before, resources, tick, scope);
}

function compareRefs(left: EffectRef, right: EffectRef): number {
    return left.unitId - right.unitId || left.effectId - right.effectId;
}

interface Ending {
    readonly ref: EffectRef;
    readonly end: EffectEnd;
}

function finishBatch(
    state: BattleState,
    roots: readonly Ending[],
    resources: EffectTransitionResources,
    tick: number,
    dispatch: EffectDispatchScope,
): void {
    const ending = new Map<string, Ending>();
    const pending = [...roots].sort((a, b) => compareRefs(a.ref, b.ref));

    for (const entry of pending) {
        const instance = getEffect(state, entry.ref);
        const key = lifetimeKey(entry.ref);

        if (instance === undefined || instance.finished || ending.has(key)) {
            continue;
        }

        ending.set(key, entry);

        for (const child of effectDependents(state, entry.ref)) {
            pending.push({ ref: child, end: entry.end });
        }
    }

    if (ending.size === 0) {
        return;
    }

    // A dependent may have several parents; DFS discovery order is not sufficient.
    const indegrees = new Map<string, number>();
    const children = new Map<string, string[]>();

    for (const [key, { ref }] of ending) {
        let count = 0;

        for (const scope of getEffect(state, ref)!.scopes) {
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
    const owners = [...byHost.keys()].sort((a, b) => a - b).map((id) => getUnit(state, id)!);
    updateUnits(
        state,
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
    updateUnits(
        state,
        owners.map((before) => {
            const result = reconcileEffectBindings(before, getUnit(state, before.id)!, resources);
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
    runParticipationActions(state, changes, resources, tick, dispatch, () => {
        for (const { ref, end } of ordered) {
            const current = getEffect(state, ref)!;
            const finish = resources.effectLifecycle.get(current).finish;

            if (finish !== undefined) {
                runLifecycleAction(
                    state,
                    ref,
                    current,
                    (context) => {
                        finish({
                            ...context,
                            end,
                            get instance() {
                                return context.instance;
                            },
                            get battlefield() {
                                return context.battlefield;
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
    });

    dispatch.drainDeferred();
}

export function finishEffects(
    state: BattleState,
    refs: readonly EffectRef[],
    resources: EffectTransitionResources,
    tick: number,
    reason: EffectEndReason = "EXPLICIT",
    dispatch = new EffectDispatchScope(),
): void {
    finishBatch(
        state,
        refs.map((ref) => ({ ref, end: { root: ref, reason } })),
        resources,
        tick,
        dispatch,
    );
}

export function finishEffect(
    state: BattleState,
    ref: EffectRef,
    resources: EffectTransitionResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): void {
    finishEffects(state, [ref], resources, tick, "EXPLICIT", dispatch);
}

export function closeEffectLifetimes(
    state: BattleState,
    lifetimes: readonly LifetimeRef[],
    resources: EffectTransitionResources,
    tick: number,
    reason: EffectEndReason = "SCOPE_CLOSED",
    dispatch = new EffectDispatchScope(),
): void {
    lifetimes.forEach(validateLifetime);
    dispatch.markClosing(lifetimes);
    const roots: Ending[] = [];

    for (const root of lifetimes) {
        for (const ref of effectDependents(state, root)) {
            roots.push({ ref, end: { root, reason } });
        }
        if (root.type === "UNIT") {
            const host = getUnit(state, root.unitId);

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

    finishBatch(state, roots, resources, tick, dispatch);
}

function cleanupEffects(
    state: BattleState,
    unitId: UnitId,
    refs: readonly EffectRef[],
    resources: EffectTransitionResources,
    dispatch: EffectDispatchScope,
): void {
    const host = getUnit(state, unitId);

    if (host === undefined || !hasEffects(host)) {
        return;
    }

    const selected = new Set(refs.map((ref) => ref.effectId));
    const instances = host.effects.instances.filter(
        (instance) =>
            instance.finished &&
            selected.has(instance.id) &&
            !dispatch.hasPendingEnd({ type: "EFFECT", unitId, effectId: instance.id }),
    );

    if (instances.length === 0) {
        return;
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

    updateUnit(state, unit);
}

export function finalizeEffect(
    state: BattleState,
    ref: EffectRef,
    resources: EffectTransitionResources,
    _tick: number,
    dispatch = new EffectDispatchScope(),
): void {
    cleanupEffects(state, ref.unitId, [ref], resources, dispatch);
}

export function finalizeFinishedEffects(
    state: BattleState,
    unitId: UnitId,
    resources: EffectTransitionResources,
    _tick: number,
    dispatch = new EffectDispatchScope(),
): void {
    const unit = getUnit(state, unitId);

    if (unit === undefined || !hasEffects(unit)) {
        return;
    }

    const refs: EffectRef[] = unit.effects.instances
        .filter((instance) => instance.finished)
        .map((instance) => ({ type: "EFFECT", unitId, effectId: instance.id }));

    cleanupEffects(state, unitId, refs, resources, dispatch);
}

export function removeEffect(
    state: BattleState,
    ref: EffectRef,
    resources: EffectTransitionResources,
    tick: number,
    dispatch = new EffectDispatchScope(),
): void {
    finishEffects(state, [ref], resources, tick, "EXPLICIT", dispatch);
    finalizeEffect(state, ref, resources, tick, dispatch);
}

function lifetimeAvailable(
    state: BattleState,
    lifetime: LifetimeRef,
    dispatch: EffectDispatchScope,
): boolean {
    if (dispatch.isClosing(lifetime)) {
        return false;
    }
    switch (lifetime.type) {
        case "UNIT":
            return getUnit(state, lifetime.unitId) !== undefined;

        case "ACTION":
            return state.actionExecutions?.get(lifetime.executionId) !== undefined;

        case "SKILL":
            return getUnit(state, lifetime.unitId)?.skill?.active?.id === lifetime.activationId;

        case "EFFECT": {
            const effect = getEffect(state, lifetime);

            return effect !== undefined && !effect.finished;
        }
    }
}

function wouldCycle(state: BattleState, ref: EffectRef, lifetime: LifetimeRef): boolean {
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

        for (const scope of getEffect(state, current)?.scopes ?? []) {
            if (scope.type === "EFFECT") {
                pending.push(scope);
            }
        }
    }

    return false;
}

export function bindEffectLifetime(
    state: BattleState,
    ref: EffectRef,
    lifetime: LifetimeRef,
    dispatch = new EffectDispatchScope(),
): EffectBindingResult {
    validateLifetime(lifetime);
    const instance = getEffect(state, ref);

    if (instance === undefined) {
        return { type: "EFFECT_ABSENT" };
    }
    if (instance.finished) {
        return { type: "EFFECT_FINISHED" };
    }
    if (!lifetimeAvailable(state, lifetime, dispatch)) {
        return { type: "LIFETIME_UNAVAILABLE" };
    }
    if (wouldCycle(state, ref, lifetime)) {
        throw new TypeError("effect scopes cannot form a cycle");
    }
    if (!instance.scopes.some((scope) => sameLifetime(scope, lifetime))) {
        changeInstance(state, ref, (instance) => ({
            ...instance,
            scopes: [...instance.scopes, lifetime],
        }));
    }

    return { type: "BOUND" };
}

export function installEffect<S extends object>(
    state: BattleState,
    unitId: UnitId,
    instance: EffectInstance<S>,
    resources: EffectTransitionResources,
    tick: number,
    dispatch = new EffectDispatchScope(),
): EffectInstallationResult {
    if (getUnit(state, unitId) === undefined) {
        return { type: "REJECTED", reason: "TARGET_ABSENT" };
    }

    resources.effects.get(instance.programRef);

    return installPrepared(state, unitId, instance, resources, tick, dispatch);
}

export function installNewEffect<S extends object>(
    state: BattleState,
    unitId: UnitId,
    program: EffectProgramRef<S>,
    input: EffectInstallationInput<NoInfer<S>>,
    resources: EffectTransitionResources,
    tick: number,
    dispatch = new EffectDispatchScope(),
): EffectInstallationResult {
    const scopes = input.scopes;
    const host = getUnit(state, unitId);

    if (host === undefined) {
        return { type: "REJECTED", reason: "TARGET_ABSENT" };
    }
    if (dispatch.isClosing({ type: "UNIT", unitId })) {
        return { type: "REJECTED", reason: "TARGET_CLOSING" };
    }
    if (
        scopes.some((scope) => scope.type !== "TICK" && !lifetimeAvailable(state, scope, dispatch))
    ) {
        return { type: "REJECTED", reason: "LIFETIME_UNAVAILABLE" };
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

    return installPrepared(state, unitId, instance, resources, tick, dispatch);
}

function installPrepared<S extends object>(
    state: BattleState,
    unitId: UnitId,
    instance: EffectInstance<S>,
    resources: EffectTransitionResources,
    tick: number,
    dispatch: EffectDispatchScope,
): EffectInstallationResult {
    const ref: EffectRef = { type: "EFFECT", unitId, effectId: instance.id };

    if (getUnit(state, unitId) === undefined) {
        return { type: "REJECTED", reason: "TARGET_ABSENT" };
    }
    if (dispatch.isClosing({ type: "UNIT", unitId })) {
        return { type: "REJECTED", reason: "TARGET_CLOSING" };
    }
    for (const scope of instance.scopes) {
        if (scope.type === "TICK") {
            continue;
        }
        if (wouldCycle(state, ref, scope)) {
            throw new TypeError("effect scopes cannot form a cycle");
        }
        if (!lifetimeAvailable(state, scope, dispatch)) {
            return { type: "REJECTED", reason: "LIFETIME_UNAVAILABLE" };
        }
    }

    const lifecycle = resources.effectLifecycle.get(instance);

    if (!(lifecycle.accepts?.({ unitId, instance, facts: effectView(() => state) }) ?? true)) {
        return { type: "REJECTED", reason: "ADMISSION_REJECTED" };
    }

    resources.effectBindings.get(instance);
    finalizeFinishedEffects(state, unitId, resources, tick, dispatch);

    // Cleanup callbacks may have retired the host or closed a dependency.
    if (getUnit(state, unitId) === undefined || dispatch.isClosing({ type: "UNIT", unitId })) {
        return { type: "REJECTED", reason: "TARGET_CLOSING" };
    }
    if (
        instance.scopes.some(
            (scope) => scope.type !== "TICK" && !lifetimeAvailable(state, scope, dispatch),
        )
    ) {
        return { type: "REJECTED", reason: "LIFETIME_UNAVAILABLE" };
    }

    transitionUnit(state, unitId, (unit) => registerEffectInstance(unit, instance));
    runLifecycleAction(state, ref, instance, lifecycle.start, resources, tick, dispatch);
    let current = getEffect(state, ref);

    if (current === undefined || current.finished) {
        return { type: "ENDED", ref };
    }

    changeInstance(state, ref, (value) => withEffectLifecycle(value, { started: true }));
    current = getEffect(state, ref)!;
    const started = current;
    transitionUnit(state, unitId, (unit) =>
        transitionEffectBindings(unit, started, resources.effectBindings, (binding, current) =>
            binding.install(current, started),
        ),
    );
    reconcileInScope(state, unitId, getUnit(state, unitId)!, resources, tick, dispatch);
    current = getEffect(state, ref);

    return { type: current === undefined || current.finished ? "ENDED" : "INSTALLED", ref };
}

/** Advance periodic content once at the tick's time boundary. */
export function advanceEffects(
    state: BattleState,
    tick: number,
    resources: EffectTransitionResources,
    dispatch = new EffectDispatchScope(),
): void {
    const view = battlefieldView(state);
    const candidates: EffectRef[] = [];

    for (const unitId of view.unitIds) {
        const unit = view.getUnit(unitId)!;

        if (hasEffects(unit)) {
            for (const instance of unit.effects.instances) {
                if (resources.effectLifecycle.get(instance).advance !== undefined) {
                    candidates.push({ type: "EFFECT", unitId, effectId: instance.id });
                }
            }
        }
    }

    for (const ref of candidates) {
        const instance = getEffect(state, ref);

        if (
            instance === undefined ||
            !instance.started ||
            !instance.participating ||
            instance.finished
        ) {
            continue;
        }

        runLifecycleAction(
            state,
            ref,
            instance,
            resources.effectLifecycle.get(instance).advance,
            resources,
            tick,
            dispatch,
        );
    }
}

export function expireEffects(
    state: BattleState,
    tick: number,
    resources: EffectTransitionResources,
    dispatch = new EffectDispatchScope(),
): void {
    const candidates = effectTickCandidates(state).filter((ref) => {
        const instance = getEffect(state, ref);
        const deadline = instance === undefined ? null : effectTick(instance);

        return (
            instance !== undefined && !instance.finished && deadline !== null && deadline <= tick
        );
    });

    for (const ref of candidates) {
        const current = getEffect(state, ref);
        const deadline = current === undefined ? null : effectTick(current);

        if (current === undefined || current.finished || deadline === null || deadline > tick) {
            continue;
        }

        const expire = resources.effectLifecycle.get(current).expire;

        if (expire === undefined) {
            finishEffects(state, [ref], resources, tick, "EXPIRED", dispatch);
        } else {
            runLifecycleAction(state, ref, current, expire, resources, tick, dispatch);
        }

        const remaining = getEffect(state, ref);
        const next = remaining === undefined ? null : effectTick(remaining);

        if (remaining !== undefined && !remaining.finished && next !== null && next <= tick) {
            throw new TypeError("effect expiration action must resolve its expired deadline");
        }
    }
}

/** Validate references once after a complete world has been initialized or restored. */
export function validateEffectLifetimes(state: BattleState): void {
    const dispatch = new EffectDispatchScope();

    for (const unitId of battlefieldView(state).unitIds) {
        const host = getUnit(state, unitId)!;

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
                if (wouldCycle(state, ref, scope)) {
                    throw new TypeError("effect scopes cannot form a cycle");
                }
                if (!lifetimeAvailable(state, scope, dispatch)) {
                    throw new TypeError(`unavailable effect scope ${lifetimeKey(scope)}`);
                }
            }
        }
    }
}
