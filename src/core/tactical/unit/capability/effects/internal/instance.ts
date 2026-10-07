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
} from "../instance.js";
import type { UnitId } from "../../../unit.js";

const ownedInstances = new WeakSet<EffectInstanceValue>();

export function ownEffectState<S extends object>(program: EffectProgram<S>, value: unknown): S {
    return ownDataRecord(program.ownState(value), "effect state");
}

function nonnegativeInteger(value: unknown, name: string): number {
    assertNonnegativeSafeInteger(value, `effect ${name}`, TypeError);

    return value;
}

function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("effect instance must be a record");
    }

    return value as Record<string, unknown>;
}

function unitId(value: unknown): UnitId | null {
    return value === null ? null : nonnegativeInteger(value, "unit identity");
}

function ownLifetimeScope(value: unknown): EffectLifetimeScope | null {
    if (value === null) {
        return null;
    }

    const scope = record(value);
    const scopeUnitId = nonnegativeInteger(scope.unitId, "lifetime scope unit identity");

    if (scope.type === "UNIT") {
        return Object.freeze({ type: "UNIT", unitId: scopeUnitId });
    }
    if (scope.type === "EXECUTION") {
        return Object.freeze({
            type: "EXECUTION",
            unitId: scopeUnitId,
            executionId: nonnegativeInteger(scope.executionId, "execution identity"),
        });
    }

    throw new TypeError("unknown effect lifetime scope");
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

export function ownEffectInstance<S extends object>(
    program: EffectProgram<S>,
    metadata: EffectInstanceMetadata,
    state: unknown,
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

export function copyEffectInstance(instance: EffectInstanceValue): EffectInstanceValue {
    if (!ownedInstances.has(instance)) {
        throw new TypeError("effect instance must be created or restored by effect resources");
    }

    return instance;
}

export function withEffectLifecycle<I extends EffectInstanceValue>(
    instance: I,
    facts: Partial<EffectLifecycleFacts>,
): I {
    const updated = Object.freeze({ ...instance, ...facts });

    ownedInstances.add(updated);

    return updated;
}

export function readEffectSnapshot(value: unknown): {
    readonly instance: Record<string, unknown>;
    readonly programId: string;
} {
    const instance = record(value);
    const ref = record(instance.programRef);

    if (typeof ref.id !== "string") {
        throw new TypeError("effect program identity must be a string");
    }

    return { instance, programId: ref.id };
}

export function ownRestoredEffectInstance<S extends object>(
    program: EffectProgram<S>,
    instance: Record<string, unknown>,
): EffectInstance<S> {
    if (
        typeof instance.started !== "boolean" ||
        typeof instance.participating !== "boolean" ||
        typeof instance.finished !== "boolean" ||
        (instance.participating && (!instance.started || instance.finished))
    ) {
        throw new TypeError("invalid effect lifecycle facts");
    }

    let parent: EffectAddress | null = null;

    if (instance.parent !== null) {
        const value = record(instance.parent);
        parent = Object.freeze({
            unitId: nonnegativeInteger(value.unitId, "parent unit identity"),
            instanceId: nonnegativeInteger(value.instanceId, "parent instance identity"),
        });
    }

    return withEffectLifecycle(
        ownEffectInstance(
            program,
            {
                id: nonnegativeInteger(instance.id, "identity"),
                source: unitId(instance.source),
                scope: ownLifetimeScope(instance.scope),
                acquiredSequence: nonnegativeInteger(
                    instance.acquiredSequence,
                    "acquired sequence",
                ),
                expiresAtTick:
                    instance.expiresAtTick === null
                        ? null
                        : nonnegativeInteger(instance.expiresAtTick, "expiration tick"),
            },
            instance.state,
        ),
        {
            started: instance.started,
            participating: instance.participating,
            finished: instance.finished,
            parent,
        },
    );
}

export function ownUpdatedEffectInstance<S extends object>(
    instance: EffectInstanceValue,
    ref: EffectProgramRef<S>,
    state: S,
): EffectInstance<S> {
    const updated: EffectInstance<S> = Object.freeze({ ...instance, programRef: ref, state });

    ownedInstances.add(updated);

    return updated;
}
