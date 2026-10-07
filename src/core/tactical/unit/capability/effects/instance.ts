import type { EffectProgram, EffectProgramRef } from "./program.js";
import type { StatusContributionId } from "../status.js";
import type { UnitId } from "../../unit.js";

export type EffectInstanceId = number;

export type EffectLifetimeOwner =
    | { readonly type: "UNIT"; readonly unitId: UnitId }
    | {
          readonly type: "EXECUTION";
          readonly unitId: UnitId;
          readonly executionId: number;
      };

export interface EffectInstanceMetadata {
    readonly id: EffectInstanceId;
    readonly sourceUnitId: UnitId | null;
    readonly lifetimeOwner: EffectLifetimeOwner | null;
    readonly acquiredSequence: number;
    readonly expiresAtTick: number | null;
}

export interface EffectInstanceValue extends EffectInstanceMetadata {
    readonly programRef: { readonly id: string };
    readonly state: object;
    readonly statusContributionId: StatusContributionId | null;
}

export interface EffectInstance<S extends object> extends EffectInstanceValue {
    readonly programRef: EffectProgramRef<S>;
    readonly state: S;
}

const ownedValues = new WeakSet();
const ownedInstances = new WeakSet<EffectInstanceValue>();

function ownData(value: unknown, ancestors: Set<object>, copies: Map<object, object>): unknown {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
    ) {
        return value;
    }
    if (typeof value !== "object") {
        throw new TypeError("effect state must contain only finite, data-only values");
    }
    if (ownedValues.has(value)) {
        return value;
    }
    if (copies.has(value)) {
        return copies.get(value)!;
    }
    if (ancestors.has(value)) {
        throw new TypeError("effect state cannot contain cycles");
    }
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError("effect state must contain plain records and arrays");
    }

    ancestors.add(value);
    let owned: object;

    if (Array.isArray(value)) {
        const items: unknown[] = [];

        for (const key of Reflect.ownKeys(value)) {
            if (key === "length") {
                continue;
            }
            if (
                typeof key !== "string" ||
                !Number.isInteger(Number(key)) ||
                Number(key) < 0 ||
                Number(key) >= value.length ||
                String(Number(key)) !== key
            ) {
                throw new TypeError("effect state arrays cannot contain extra properties");
            }
        }

        for (let index = 0; index < value.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));

            if (descriptor === undefined) {
                throw new TypeError("effect state arrays must be dense");
            }
            if (!("value" in descriptor)) {
                throw new TypeError("effect state cannot contain accessors");
            }

            items.push(ownData(descriptor.value, ancestors, copies));
        }

        owned = Object.freeze(items);
    } else {
        const record: Record<string, unknown> = {};

        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== "string") {
                throw new TypeError("effect state cannot contain symbol properties");
            }

            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;

            if (!("value" in descriptor)) {
                throw new TypeError("effect state cannot contain accessors");
            }

            Object.defineProperty(record, key, {
                value: ownData(descriptor.value, ancestors, copies),
                enumerable: true,
            });
        }

        owned = Object.freeze(record);
    }

    ancestors.delete(value);
    ownedValues.add(owned);
    copies.set(value, owned);

    return owned;
}

export function ownEffectState<S extends object>(program: EffectProgram<S>, value: unknown): S {
    const state = program.ownState(value);

    if (Array.isArray(state) || Object.getPrototypeOf(state) !== Object.prototype) {
        throw new TypeError("effect state root must be a plain record");
    }

    return ownData(state, new Set(), new Map()) as S;
}

function nonnegativeInteger(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`effect ${name} must be a nonnegative safe integer`);
    }

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

function ownLifetimeOwner(value: unknown): EffectLifetimeOwner | null {
    if (value === null) {
        return null;
    }

    const owner = record(value);
    const ownerUnitId = nonnegativeInteger(owner.unitId, "lifetime owner");

    if (owner.type === "UNIT") {
        return Object.freeze({ type: "UNIT", unitId: ownerUnitId });
    }
    if (owner.type === "EXECUTION") {
        return Object.freeze({
            type: "EXECUTION",
            unitId: ownerUnitId,
            executionId: nonnegativeInteger(owner.executionId, "execution identity"),
        });
    }

    throw new TypeError("unknown effect lifetime owner");
}

function ownMetadata(value: EffectInstanceMetadata): EffectInstanceMetadata {
    return {
        id: nonnegativeInteger(value.id, "identity"),
        sourceUnitId: unitId(value.sourceUnitId),
        lifetimeOwner: ownLifetimeOwner(value.lifetimeOwner),
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
    statusContributionId: StatusContributionId | null,
): EffectInstance<S> {
    if (statusContributionId !== null && statusContributionId !== `@effect/${metadata.id}`) {
        throw new TypeError("effect status contribution must match its instance identity");
    }

    const instance: EffectInstance<S> = Object.freeze({
        ...ownMetadata(metadata),
        programRef: program.ref,
        state: ownEffectState(program, state),
        statusContributionId,
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

export function associateEffectStatus(
    instance: EffectInstanceValue,
    contributionId: StatusContributionId | null,
): EffectInstanceValue {
    copyEffectInstance(instance);

    if (contributionId !== null && contributionId !== `@effect/${instance.id}`) {
        throw new TypeError("effect status contribution must match its instance identity");
    }
    if (instance.statusContributionId === contributionId) {
        return instance;
    }

    const updated = Object.freeze({ ...instance, statusContributionId: contributionId });

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
        instance.statusContributionId !== null &&
        typeof instance.statusContributionId !== "string"
    ) {
        throw new TypeError("effect status contribution identity must be a string or null");
    }

    return ownEffectInstance(
        program,
        {
            id: nonnegativeInteger(instance.id, "identity"),
            sourceUnitId: unitId(instance.sourceUnitId),
            lifetimeOwner: ownLifetimeOwner(instance.lifetimeOwner),
            acquiredSequence: nonnegativeInteger(instance.acquiredSequence, "acquired sequence"),
            expiresAtTick:
                instance.expiresAtTick === null
                    ? null
                    : nonnegativeInteger(instance.expiresAtTick, "expiration tick"),
        },
        instance.state,
        instance.statusContributionId,
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
