import { expireEffects, removeEffectsOwnedByUnit } from "../effect/lifecycle.js";
import { hasEffects } from "../unit/capability/effects.js";
import type { UnitId } from "../unit/unit.js";
import {
    combatWorkView,
    getCombatUnit,
    removeCombatUnit,
    updateCombatUnit,
    type CombatWork,
} from "./work.js";

export function retireCombatUnit(work: CombatWork, unitId: UnitId): CombatWork {
    work = removeCombatUnit(work, unitId, "DEATH");

    for (const id of combatWorkView(work).unitIds) {
        const unit = getCombatUnit(work, id)!;

        work = updateCombatUnit(work, removeEffectsOwnedByUnit(unit, unitId));
    }

    return work;
}

export function prepareCombatEffects(work: CombatWork, tick: number): CombatWork {
    for (const id of combatWorkView(work).unitIds) {
        let unit = expireEffects(getCombatUnit(work, id)!, tick);

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

        work = updateCombatUnit(work, unit);
    }

    return work;
}
