import {
    associateEffectStatus,
    copyEffectInstance,
    type EffectInstanceId,
    type EffectInstanceValue,
} from "./instance.js";
import { createEffectsState, hasEffects, type Effects } from "../unit/capability/effects.js";
import {
    addStatusContribution,
    hasStatus,
    removeStatusContribution,
    type StatusFlag,
} from "../unit/capability/status.js";
import type { Unit, UnitId } from "../unit/unit.js";

export function installEffect<U extends Unit>(
    unit: U,
    instance: EffectInstanceValue,
    flags: readonly StatusFlag[] = [],
): U & Effects {
    copyEffectInstance(instance);
    const instances = hasEffects(unit) ? unit.effects.instances : [];

    if (instances.some((existing) => existing.id === instance.id)) {
        throw new TypeError(`duplicate effect instance ${instance.id}`);
    }
    if (instance.statusContributionId !== null) {
        throw new TypeError("effect instance already has an installed status contribution");
    }
    if (flags.length > 0 && !hasStatus(unit)) {
        throw new TypeError("effect status flags require an existing Status capability");
    }

    const contributionId = flags.length > 0 ? `@effect/${instance.id}` : null;
    const installed = associateEffectStatus(instance, contributionId);
    const effects = createEffectsState([...instances, installed]);

    if (contributionId !== null && hasStatus(unit)) {
        const status = addStatusContribution(unit.status, { id: contributionId, flags });

        return { ...unit, status, effects };
    }

    return { ...unit, effects };
}

function removeMatching<U extends Unit>(
    unit: U,
    matches: (instance: EffectInstanceValue) => boolean,
): U {
    if (!hasEffects(unit)) {
        return unit;
    }

    const removed = unit.effects.instances.filter(matches);

    if (removed.length === 0) {
        return unit;
    }

    const removedIds = new Set(removed.map((instance) => instance.id));
    const effects = createEffectsState(
        unit.effects.instances.filter((instance) => !removedIds.has(instance.id)),
    );

    if (hasStatus(unit)) {
        let status = unit.status;

        for (const instance of removed) {
            if (instance.statusContributionId !== null) {
                status = removeStatusContribution(status, instance.statusContributionId);
            }
        }

        return { ...unit, status, effects };
    }
    if (removed.some((instance) => instance.statusContributionId !== null)) {
        throw new TypeError("installed effect status contribution requires Status capability");
    }

    return { ...unit, effects };
}

export function removeEffect<U extends Unit>(unit: U, id: EffectInstanceId): U {
    return removeMatching(unit, (instance) => instance.id === id);
}

export function expireEffects<U extends Unit>(unit: U, tick: number): U {
    return removeMatching(
        unit,
        (instance) => instance.expiresAtTick !== null && instance.expiresAtTick <= tick,
    );
}

export function removeEffectsOwnedByUnit<U extends Unit>(unit: U, ownerUnitId: UnitId): U {
    return removeMatching(unit, (instance) => instance.lifetimeOwner?.unitId === ownerUnitId);
}

export function removeEffectsOwnedByExecution<U extends Unit>(
    unit: U,
    ownerUnitId: UnitId,
    executionId: number,
): U {
    return removeMatching(
        unit,
        (instance) =>
            instance.lifetimeOwner?.type === "EXECUTION" &&
            instance.lifetimeOwner.unitId === ownerUnitId &&
            instance.lifetimeOwner.executionId === executionId,
    );
}
