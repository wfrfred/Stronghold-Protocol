import { assertNonnegativeSafeInteger } from "../../../../../common/assert.js";
import type { EffectDefinition } from "../definition.js";
import {
    type Effect,
    type EffectMetadata,
    type EffectValue,
    type EffectLifecycleFacts,
    type Scope,
    type LifetimeRef,
    type EffectSnapshot,
    lifetimeKey,
} from "../effect.js";

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

function validateMetadata(value: EffectMetadata): readonly Scope[] {
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

export function createEffect<S extends object>(
    definition: EffectDefinition<S>,
    metadata: EffectMetadata,
    state: S,
): Effect<S> {
    return {
        ...metadata,
        scopes: validateMetadata(metadata),
        definition,
        state,
        started: false,
        enabled: true,
        participating: false,
        finished: false,
    };
}

export function withEffectLifecycle<I extends EffectValue>(
    instance: I,
    facts: Partial<EffectLifecycleFacts>,
): I extends unknown ? Omit<I, keyof EffectLifecycleFacts> & EffectLifecycleFacts : never;
export function withEffectLifecycle(
    instance: EffectValue,
    facts: Partial<EffectLifecycleFacts>,
): EffectValue {
    return { ...instance, ...facts };
}

export function restoreEffect<S extends object>(
    definition: EffectDefinition<S>,
    snapshot: EffectSnapshot<S>,
): Effect<S> {
    assertLifecycleFacts(snapshot);

    return {
        ...snapshot,
        scopes: validateMetadata(snapshot),
        definition,
    };
}
