import { assertNonnegativeSafeInteger } from "../../../../../common/assert.js";
import { ownDataRecord } from "../../../../../common/immutable-data.js";
import type { EffectProgram, EffectProgramRef } from "../program.js";
import type {
    EffectAddress,
    EffectInstance,
    EffectInstanceMetadata,
    EffectInstanceValue,
    EffectLifecycleFacts,
    EffectLifetimeScope,
    EffectSnapshot,
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

function ownLifetimeScope(scope: EffectLifetimeScope | null): EffectLifetimeScope | null {
    if (scope === null) {
        return null;
    }

    const scopeUnitId = nonnegativeInteger(scope.unitId, "lifetime scope unit identity");

    if (scope.type === "UNIT") {
        return Object.freeze({ type: "UNIT", unitId: scopeUnitId });
    }

    return Object.freeze({
        type: "EXECUTION",
        unitId: scopeUnitId,
        executionId: nonnegativeInteger(scope.executionId, "execution identity"),
    });
}

function ownMetadata(value: EffectInstanceMetadata): EffectInstanceMetadata {
    return {
        id: nonnegativeInteger(value.id, "identity"),
        source: unitId(value.source),
        scope: ownLifetimeScope(value.scope),
        acquiredSequence: nonnegativeInteger(value.acquiredSequence, "acquired sequence"),
        expiresAtTick:
            value.expiresAtTick === null
                ? null
                : nonnegativeInteger(value.expiresAtTick, "expiration tick"),
    };
}

function ownParent(parent: EffectAddress | null): EffectAddress | null {
    return parent === null
        ? null
        : Object.freeze({
              unitId: nonnegativeInteger(parent.unitId, "parent unit identity"),
              instanceId: nonnegativeInteger(parent.instanceId, "parent instance identity"),
          });
}

function assertLifecycleFacts(instance: EffectLifecycleFacts): void {
    if (instance.participating && (!instance.started || instance.finished)) {
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
        participating: false,
        finished: false,
        parent: null,
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
        participating: instance.participating,
        finished: instance.finished,
        parent: ownParent(instance.parent),
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
        participating: instance.participating,
        finished: instance.finished,
        parent: ownParent(instance.parent),
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
