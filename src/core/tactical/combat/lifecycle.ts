import { expireEffects, removeEffectsOwnedByUnit } from "../effect/lifecycle.js";
import { hasEffects } from "../unit/capability/effects.js";
import type { Unit, UnitId } from "../unit/unit.js";
import type { CombatResources } from "./resources.js";
import {
    combatWorkView,
    getCombatUnit,
    removeCombatUnit,
    updateCombatUnit,
    type CombatWork,
} from "./work.js";

function cleanRemovedContributions(before: Unit, after: Unit, resources: CombatResources): Unit {
    if (before === after || !hasEffects(before)) {
        return after;
    }

    const remaining = new Set(hasEffects(after) ? after.effects.instances.map(({ id }) => id) : []);
    const removed = before.effects.instances.filter(({ id }) => !remaining.has(id));

    return resources.cleanupContributions(after, removed);
}

export function retireCombatUnit(
    work: CombatWork,
    unitId: UnitId,
    resources: CombatResources,
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
    resources: CombatResources,
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
