import {
    expireEffects,
    removeEffectsOwnedByUnit,
} from "../../unit/capability/effects/lifecycle.js";
import { hasEffects } from "../../unit/capability/effects/capability.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import type { EffectContributionBindings } from "../../unit/capability/effects/resources.js";
import { cleanupEffectContributions } from "../../unit/capability/effects/transition.js";
import {
    combatWorkView,
    getCombatUnit,
    removeCombatUnit,
    updateCombatUnit,
    type CombatWork,
} from "./work.js";

export interface UnitLifecycleResources {
    readonly effectBindings: EffectContributionBindings;
}

function cleanRemovedContributions(
    before: Unit,
    after: Unit,
    resources: UnitLifecycleResources,
): Unit {
    if (before === after || !hasEffects(before)) {
        return after;
    }

    const remaining = new Set(hasEffects(after) ? after.effects.instances.map(({ id }) => id) : []);
    const removed = before.effects.instances.filter(({ id }) => !remaining.has(id));

    return cleanupEffectContributions(after, removed, resources.effectBindings);
}

export function retireCombatUnit(
    work: CombatWork,
    unitId: UnitId,
    resources: UnitLifecycleResources,
): CombatWork {
    work = removeCombatUnit(work, unitId, "DEATH");

    for (const id of combatWorkView(work).unitIds) {
        const unit = getCombatUnit(work, id)!;

        work = updateCombatUnit(
            work,
            cleanRemovedContributions(unit, removeEffectsOwnedByUnit(unit, unitId), resources),
        );
    }

    return work;
}

export function prepareCombatEffects(
    work: CombatWork,
    tick: number,
    resources: UnitLifecycleResources,
): CombatWork {
    for (const id of combatWorkView(work).unitIds) {
        const previous = getCombatUnit(work, id)!;
        let unit = expireEffects(previous, tick);

        if (hasEffects(unit)) {
            const missingOwners = new Set(
                unit.effects.instances.flatMap(({ lifetimeOwner }) =>
                    lifetimeOwner !== null &&
                    getCombatUnit(work, lifetimeOwner.unitId) === undefined
                        ? [lifetimeOwner.unitId]
                        : [],
                ),
            );

            for (const ownerUnitId of missingOwners) {
                unit = removeEffectsOwnedByUnit(unit, ownerUnitId);
            }
        }

        work = updateCombatUnit(work, cleanRemovedContributions(previous, unit, resources));
    }

    return work;
}
