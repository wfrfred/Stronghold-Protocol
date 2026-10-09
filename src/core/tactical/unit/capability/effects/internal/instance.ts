import { assertNonnegativeSafeInteger } from "../../../../../common/assert.js";
import { ownDataRecord } from "../../../../../common/immutable-data.js";
import type { EffectProgram, EffectProgramRef } from "../program.js";
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
import type { UnitId } from "../../../unit.js";

const ownedInstances = new WeakSet<EffectInstanceValue>();

export function ownEffectState<S extends object>(program: EffectProgram<S>, value: S): S {
    return ownDataRecord(program.ownState(value), "effect state");
}

function nonnegativeInteger(value: number, name: string): number {
    assertNonnegativeSafeInteger(value, `effect ${name}`, TypeError);

    return value;
}

function unitId(value: UnitId | null): UnitId | null {
    return value === null ? null : nonnegativeInteger(value, "unit identity");
}

export function ownLifetime(ref: LifetimeRef): LifetimeRef {
    switch (ref.type) {
        case "UNIT":
            return Object.freeze({
                type: "UNIT",
                unitId: nonnegativeInteger(ref.unitId, "scope unit identity"),
            });

        case "ACTION":
            return Object.freeze({
                type: "ACTION",
                executionId: nonnegativeInteger(ref.executionId, "execution identity"),
            });

        case "SKILL":
            return Object.freeze({
                type: "SKILL",
                unitId: nonnegativeInteger(ref.unitId, "scope unit identity"),
                activationId: nonnegativeInteger(ref.activationId, "activation identity"),
            });

        case "EFFECT":
            return Object.freeze({
                type: "EFFECT",
                unitId: nonnegativeInteger(ref.unitId, "scope unit identity"),
                effectId: nonnegativeInteger(ref.effectId, "effect identity"),
            });

        default:
            throw new TypeError("invalid effect lifetime type");
    }
}

export function ownScopes(scopes: readonly Scope[]): readonly Scope[] {
    if (!Array.isArray(scopes)) {
        throw new TypeError("effect scopes must be an array");
    }

    const keys = new Set<string>();
    const result: Scope[] = [];
    let hasTick = false;
    const inputs: readonly Scope[] = scopes;

    for (const scope of inputs) {
        if (scope.type === "TICK") {
            if (hasTick) {
                throw new TypeError("effect may have only one TICK scope");
            }

            hasTick = true;
        }

        const owned =
            scope.type === "TICK"
                ? Object.freeze({
                      type: "TICK" as const,
                      tick: nonnegativeInteger(scope.tick, "expiration tick"),
                  })
                : ownLifetime(scope);
        const key = lifetimeKey(owned);

        if (!keys.has(key)) {
            keys.add(key);
            result.push(owned);
        }
    }

    return Object.freeze(result);
}

function ownMetadata(value: EffectInstanceMetadata): EffectInstanceMetadata {
    return {
        id: nonnegativeInteger(value.id, "identity"),
        source: unitId(value.source),
        scopes: ownScopes(value.scopes),
        acquiredSequence: nonnegativeInteger(value.acquiredSequence, "acquired sequence"),
    };
}

function assertLifecycleFacts(instance: EffectLifecycleFacts): void {
    if (instance.participating && (!instance.started || !instance.enabled || instance.finished)) {
        throw new TypeError("invalid effect lifecycle facts");
    }
}

export function ownEffectInstance<S extends object>(
    program: EffectProgram<S>,
    metadata: EffectInstanceMetadata,
    state: S,
): EffectInstance<S> {
    const instance: EffectInstance<S> = Object.freeze({
        ...ownMetadata(metadata),
        programRef: program.ref,
        state: ownEffectState(program, state),
        started: false,
        enabled: true,
        participating: false,
        finished: false,
    });

    ownedInstances.add(instance);

    return instance;
}

export function copyEffectInstance<S extends object>(
    instance: EffectInstance<S>,
): EffectInstance<S>;
export function copyEffectInstance(instance: EffectInstanceValue): EffectInstanceValue;
export function copyEffectInstance(instance: EffectInstanceValue): EffectInstanceValue {
    if (ownedInstances.has(instance)) {
        return instance;
    }

    assertLifecycleFacts(instance);

    const owned = Object.freeze({
        ...ownMetadata(instance),
        programRef: instance.programRef,
        started: instance.started,
        enabled: instance.enabled,
        participating: instance.participating,
        finished: instance.finished,
        state: ownDataRecord(instance.state, "effect state"),
    });
    ownedInstances.add(owned);

    return owned;
}

export function withEffectLifecycle<I extends EffectInstanceValue>(
    instance: I,
    facts: Partial<EffectLifecycleFacts>,
): I extends unknown ? Omit<I, keyof EffectLifecycleFacts> & EffectLifecycleFacts : never;
export function withEffectLifecycle(
    instance: EffectInstanceValue,
    facts: Partial<EffectLifecycleFacts>,
): EffectInstanceValue {
    const updated = Object.freeze({ ...instance, ...facts });
    ownedInstances.add(updated);

    return updated;
}

export function ownRestoredEffectInstance<S extends object>(
    program: EffectProgram<S>,
    instance: EffectSnapshot<S>,
): EffectInstance<S> {
    assertLifecycleFacts(instance);

    return withEffectLifecycle(ownEffectInstance(program, instance, instance.state), {
        started: instance.started,
        enabled: instance.enabled,
        participating: instance.participating,
        finished: instance.finished,
    });
}

export function ownUpdatedEffectInstance<S extends object>(
    instance: EffectInstanceValue,
    ref: EffectProgramRef<S>,
    state: S,
): EffectInstance<S> {
    const updated = Object.freeze({ ...instance, programRef: ref, state });
    ownedInstances.add(updated);

    return updated;
}
