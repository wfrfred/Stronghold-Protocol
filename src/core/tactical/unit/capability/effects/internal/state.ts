import { assertNonnegativeSafeInteger } from "../../../../../common/assert.js";
import { copyEffectInstance } from "./instance.js";
import type { EffectInstanceValue } from "../instance.js";
import type { Effects, EffectsState } from "../capability.js";
import type { Unit } from "../../../unit.js";

interface AllocationProgress {
    readonly nextInstanceId: number;
    readonly nextAcquiredSequence: number;
}

const ownedArrays = new WeakMap<readonly EffectInstanceValue[], AllocationProgress>();

export function ownEffectsState(state: EffectsState): EffectsState {
    const { instances, nextInstanceId, nextAcquiredSequence } = state;

    assertNonnegativeSafeInteger(nextInstanceId, "effect instance allocation progress", TypeError);
    assertNonnegativeSafeInteger(
        nextAcquiredSequence,
        "effect acquired sequence allocation progress",
        TypeError,
    );

    const minimumProgress = ownedArrays.get(instances);

    if (minimumProgress !== undefined) {
        if (
            nextInstanceId < minimumProgress.nextInstanceId ||
            nextAcquiredSequence < minimumProgress.nextAcquiredSequence
        ) {
            throw new TypeError("effect allocation progress must exceed registered identities");
        }

        return Object.freeze({ instances, nextInstanceId, nextAcquiredSequence });
    }

    const ids = new Set<number>();
    const owned: EffectInstanceValue[] = [];
    let minimumId = 0;
    let minimumSequence = 0;

    for (const instance of instances) {
        if (ids.has(instance.id)) {
            throw new TypeError(`duplicate effect instance ${instance.id}`);
        }
        if (instance.id >= nextInstanceId || instance.acquiredSequence >= nextAcquiredSequence) {
            throw new TypeError("effect allocation progress must exceed registered identities");
        }

        ids.add(instance.id);

        owned.push(copyEffectInstance(instance));
        minimumId = Math.max(minimumId, instance.id + 1);
        minimumSequence = Math.max(minimumSequence, instance.acquiredSequence + 1);
    }

    Object.freeze(owned);
    ownedArrays.set(owned, { nextInstanceId: minimumId, nextAcquiredSequence: minimumSequence });

    return Object.freeze({ instances: owned, nextInstanceId, nextAcquiredSequence });
}

export function replaceEffectInstances<U extends Unit>(
    unit: U,
    instances: readonly EffectInstanceValue[],
): U {
    const progress = (unit as Unit & Partial<Effects>).effects ?? {
        nextInstanceId: 0,
        nextAcquiredSequence: 0,
    };

    return { ...unit, effects: ownEffectsState({ ...progress, instances }) };
}

export function registerEffectInstance<U extends Unit>(unit: U, instance: EffectInstanceValue): U {
    const previous = (unit as Unit & Partial<Effects>).effects ?? {
        instances: [],
        nextInstanceId: 0,
        nextAcquiredSequence: 0,
    };

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

    return {
        ...unit,
        effects: ownEffectsState({
            instances: [...previous.instances, instance],
            nextInstanceId: instance.id + 1,
            nextAcquiredSequence: instance.acquiredSequence + 1,
        }),
    };
}
