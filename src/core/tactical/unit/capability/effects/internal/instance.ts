import { assertNonnegativeSafeInteger } from "../../../../../common/assert.js";
import type { EffectProgram } from "../program.js";
import {
    type EffectInstance,
    type EffectInstanceMetadata,
    type EffectInstanceValue,
    type EffectLifecycleFacts,
    type Scope,
    type LifetimeRef,
    type EffectSnapshot,
    lifetimeKey,
} from "../instance.js";

function nonnegativeInteger(value: number, name: string): void {
    assertNonnegativeSafeInteger(value, `effect ${name}`, TypeError);
}

export function validateLifetime(ref: LifetimeRef): void {
    switch (ref.type) {
        case "UNIT":
            nonnegativeInteger(ref.unitId, "scope unit identity");
            break;

        case "ACTION":
            nonnegativeInteger(ref.executionId, "execution identity");
            break;

        case "SKILL":
            nonnegativeInteger(ref.unitId, "scope unit identity");
            nonnegativeInteger(ref.activationId, "activation identity");
            break;

        case "EFFECT":
            nonnegativeInteger(ref.unitId, "scope unit identity");
            nonnegativeInteger(ref.effectId, "effect identity");
            break;
    }
}

export function normalizeScopes(scopes: readonly Scope[]): readonly Scope[] {
    const keys = new Set<string>();
    const result: Scope[] = [];
    let hasTick = false;

    for (const scope of scopes) {
        if (scope.type === "TICK") {
            if (hasTick) {
                throw new TypeError("effect may have only one TICK scope");
            }

            hasTick = true;
            nonnegativeInteger(scope.tick, "expiration tick");
        } else {
            validateLifetime(scope);
        }

        const key = lifetimeKey(scope);

        if (!keys.has(key)) {
            keys.add(key);
            result.push(scope);
        }
    }

    return result.length === scopes.length ? scopes : result;
}

function validateMetadata(value: EffectInstanceMetadata): readonly Scope[] {
    nonnegativeInteger(value.id, "identity");

    if (value.source !== null) {
        nonnegativeInteger(value.source, "unit identity");
    }

    nonnegativeInteger(value.acquiredSequence, "acquired sequence");

    return normalizeScopes(value.scopes);
}

function assertLifecycleFacts(instance: EffectLifecycleFacts): void {
    if (instance.participating && (!instance.started || !instance.enabled || instance.finished)) {
        throw new TypeError("invalid effect lifecycle facts");
    }
}

export function createEffectInstance<S extends object>(
    program: EffectProgram<S>,
    metadata: EffectInstanceMetadata,
    state: S,
): EffectInstance<S> {
    return {
        ...metadata,
        scopes: validateMetadata(metadata),
        programRef: program.ref,
        state,
        started: false,
        enabled: true,
        participating: false,
        finished: false,
    };
}

export function withEffectLifecycle<I extends EffectInstanceValue>(
    instance: I,
    facts: Partial<EffectLifecycleFacts>,
): I extends unknown ? Omit<I, keyof EffectLifecycleFacts> & EffectLifecycleFacts : never;
export function withEffectLifecycle(
    instance: EffectInstanceValue,
    facts: Partial<EffectLifecycleFacts>,
): EffectInstanceValue {
    return { ...instance, ...facts };
}

export function restoreEffectInstance<S extends object>(
    program: EffectProgram<S>,
    snapshot: EffectSnapshot<S>,
): EffectInstance<S> {
    assertLifecycleFacts(snapshot);

    return {
        ...snapshot,
        scopes: validateMetadata(snapshot),
        programRef: program.ref,
    };
}
