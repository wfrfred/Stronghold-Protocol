import { assertNonnegativeSafeInteger } from "../../../../../common/assert.js";
import { copyEffectInstance } from "./instance.js";
import type { EffectInstanceValue } from "../instance.js";
import type { Effects, EffectsState } from "../capability.js";
import { stabilizeUnit, type StableUnit, type Unit } from "../../../unit.js";

const ownedArrays = new WeakSet<readonly EffectInstanceValue[]>();
const ownedStates = new WeakSet<EffectsState>();

function effectsState(state: EffectsState): EffectsState {
    const owned = Object.freeze(state);
    ownedStates.add(owned);

    return owned;
}

function ownInstanceArray(instances: EffectInstanceValue[]): readonly EffectInstanceValue[] {
    Object.freeze(instances);
    ownedArrays.add(instances);

    return instances;
}

export function ownEffectsState(state: EffectsState): EffectsState {
    const { instances, nextInstanceId, nextAcquiredSequence } = state;

    if (ownedStates.has(state)) {
        return state;
    }

    assertNonnegativeSafeInteger(nextInstanceId, "effect instance allocation progress", TypeError);
    assertNonnegativeSafeInteger(
        nextAcquiredSequence,
        "effect acquired sequence allocation progress",
        TypeError,
    );

    const ids = new Set<number>();
    const owned: EffectInstanceValue[] = [];

    for (const instance of instances) {
        if (ids.has(instance.id)) {
            throw new TypeError(`duplicate effect instance ${instance.id}`);
        }
        if (instance.id >= nextInstanceId || instance.acquiredSequence >= nextAcquiredSequence) {
            throw new TypeError("effect allocation progress must exceed registered identities");
        }

        ids.add(instance.id);

        owned.push(copyEffectInstance(instance));
    }

    return effectsState({
        instances: ownedArrays.has(instances) ? instances : ownInstanceArray(owned),
        nextInstanceId,
        nextAcquiredSequence,
    });
}

export function replaceEffectInstances<U extends Unit>(
    input: U | StableUnit<U>,
    instances: readonly EffectInstanceValue[],
): StableUnit<U> & Effects {
    const unit = stabilizeUnit<U>(input);
    const progress = unit.effects ?? {
        nextInstanceId: 0,
        nextAcquiredSequence: 0,
    };

    return { ...unit, effects: ownEffectsState({ ...progress, instances }) };
}

export function replaceEffectInstance<U extends Unit & Effects>(
    input: U | StableUnit<U>,
    instance: EffectInstanceValue,
    updated: EffectInstanceValue,
): StableUnit<U> {
    const unit = stabilizeUnit<U>(input);
    const previous = ownEffectsState(unit.effects);
    const index = previous.instances.indexOf(instance);

    if (index === -1 || updated === instance) {
        return unit;
    }

    if (updated.id !== instance.id || updated.acquiredSequence !== instance.acquiredSequence) {
        throw new TypeError("effect identity and acquisition sequence cannot be changed");
    }

    const instances = [...previous.instances];
    instances[index] = copyEffectInstance(updated);

    return {
        ...unit,
        effects: effectsState({
            ...previous,
            instances: ownInstanceArray(instances),
        }),
    };
}

export function removeEffectInstance<U extends Unit & Effects>(
    input: U | StableUnit<U>,
    instanceId: number,
): StableUnit<U> {
    const unit = stabilizeUnit<U>(input);
    const previous = ownEffectsState(unit.effects);
    const instances: EffectInstanceValue[] = [];

    for (const instance of previous.instances) {
        if (instance.id !== instanceId) {
            instances.push(instance);
        }
    }

    if (instances.length === previous.instances.length) {
        return unit;
    }

    return {
        ...unit,
        effects: effectsState({
            ...previous,
            instances: ownInstanceArray(instances),
        }),
    };
}

export function registerEffectInstance<U extends Unit>(
    input: U | StableUnit<U>,
    instance: EffectInstanceValue,
): StableUnit<U> & Effects {
    const unit = stabilizeUnit<U>(input);
    const previous = ownEffectsState(
        unit.effects ?? {
            instances: [],
            nextInstanceId: 0,
            nextAcquiredSequence: 0,
        },
    );

    if (
        instance.id < previous.nextInstanceId ||
        instance.acquiredSequence < previous.nextAcquiredSequence
    ) {
        throw new TypeError("effect identity and acquisition sequence cannot be reused");
    }
    if (
        instance.started ||
        instance.participating ||
        instance.finished ||
        instance.parent !== null
    ) {
        throw new TypeError("only a fresh effect instance can be installed");
    }

    const nextInstanceId = instance.id + 1;
    const nextAcquiredSequence = instance.acquiredSequence + 1;
    assertNonnegativeSafeInteger(nextInstanceId, "effect instance allocation progress", TypeError);
    assertNonnegativeSafeInteger(
        nextAcquiredSequence,
        "effect acquired sequence allocation progress",
        TypeError,
    );

    return {
        ...unit,
        effects: effectsState({
            instances: ownInstanceArray([...previous.instances, copyEffectInstance(instance)]),
            nextInstanceId,
            nextAcquiredSequence,
        }),
    };
}
