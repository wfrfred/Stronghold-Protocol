import { assertNonnegativeSafeInteger } from "../../../../../common/assert.js";
import type { EffectInstanceValue } from "../instance.js";
import type { Effects } from "../capability.js";
import { widenUnit, type StableUnit, type Unit } from "../../../unit.js";

export function replaceEffectInstances<U extends Unit>(
    input: U | StableUnit<U>,
    instances: readonly EffectInstanceValue[],
): StableUnit<U> & Effects {
    const unit = widenUnit<U>(input);
    const progress = unit.effects ?? {
        nextInstanceId: 0,
        nextAcquiredSequence: 0,
    };

    return { ...unit, effects: { ...progress, instances } };
}

export function replaceEffectInstance<U extends Unit & Effects>(
    input: U | StableUnit<U>,
    instance: EffectInstanceValue,
    updated: EffectInstanceValue,
): StableUnit<U> {
    const unit = widenUnit<U>(input);
    const previous = unit.effects;
    const index = previous.instances.indexOf(instance);

    if (index === -1 || updated === instance) {
        return unit;
    }

    if (updated.id !== instance.id || updated.acquiredSequence !== instance.acquiredSequence) {
        throw new TypeError("effect identity and acquisition sequence cannot be changed");
    }

    const instances = [...previous.instances];
    instances[index] = updated;

    return { ...unit, effects: { ...previous, instances } };
}

export function removeEffectInstance<U extends Unit & Effects>(
    input: U | StableUnit<U>,
    instanceId: number,
): StableUnit<U> {
    const unit = widenUnit<U>(input);
    const previous = unit.effects;
    const instances = previous.instances.filter((instance) => instance.id !== instanceId);

    if (instances.length === previous.instances.length) {
        return unit;
    }

    return { ...unit, effects: { ...previous, instances } };
}

export function registerEffectInstance<U extends Unit>(
    input: U | StableUnit<U>,
    instance: EffectInstanceValue,
): StableUnit<U> & Effects {
    const unit = widenUnit<U>(input);
    const previous = unit.effects ?? {
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
    if (instance.started || instance.participating || instance.finished) {
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
        effects: {
            instances: [...previous.instances, instance],
            nextInstanceId,
            nextAcquiredSequence,
        },
    };
}
