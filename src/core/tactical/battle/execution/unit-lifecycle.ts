import {
    expireEffects,
    finalizeFinishedEffects,
    finishEffect,
    finishEffectsOnUnit,
    finishEffectsOwnedByUnit,
} from "../../unit/capability/effects/lifecycle.js";
import { hasEffects } from "../../unit/capability/effects/capability.js";
import { EffectDispatchScope } from "../../unit/capability/effects/dispatch.js";
import type { UnitId } from "../../unit/unit.js";
import type { BattlefieldRemovalReason } from "../../battlefield/contract.js";
import type { EffectTransitionResources } from "../../unit/capability/effects/contract.js";
import { getEffect } from "../../unit/capability/effects/query.js";
import { combatWorkView, getCombatUnit, removeCombatUnit, type CombatWork } from "./work.js";

export interface UnitLifecycleResources extends EffectTransitionResources {
    readonly finishSkill: (
        work: CombatWork,
        unitId: UnitId,
        tick: number,
        dispatch?: EffectDispatchScope,
    ) => CombatWork;
}

export function retireCombatUnit(
    work: CombatWork,
    unitId: UnitId,
    resources: UnitLifecycleResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): CombatWork {
    return removeUnitWithEffects(work, unitId, "DEATH", resources, tick, dispatch);
}

export function removeUnitWithEffects(
    work: CombatWork,
    unitId: UnitId,
    reason: BattlefieldRemovalReason,
    resources: UnitLifecycleResources,
    tick: number,
    dispatch?: EffectDispatchScope,
): CombatWork {
    dispatch ??= new EffectDispatchScope();
    work = resources.finishSkill(work, unitId, tick, dispatch);
    work = finishEffectsOnUnit(work, unitId, resources, tick, dispatch);
    work = finishEffectsOwnedByUnit(work, unitId, resources, tick, dispatch);
    work = finalizeFinishedEffects(work, unitId, resources, tick, dispatch);

    return removeCombatUnit(work, unitId, reason);
}

export function prepareCombatEffects(
    work: CombatWork,
    tick: number,
    resources: EffectTransitionResources,
): CombatWork {
    work = expireEffects(work, tick, resources);

    for (const id of combatWorkView(work).unitIds) {
        const unit = getCombatUnit(work, id)!;

        if (!hasEffects(unit)) {
            continue;
        }

        const missingOwners = new Set(
            unit.effects.instances.flatMap(({ scope }) =>
                scope !== null && getCombatUnit(work, scope.unitId) === undefined
                    ? [scope.unitId]
                    : [],
            ),
        );

        for (const ownerUnitId of missingOwners) {
            work = finishEffectsOwnedByUnit(work, ownerUnitId, resources, tick);
        }

        for (const instance of unit.effects.instances) {
            if (instance.parent !== null && getEffect(work, instance.parent) === undefined) {
                work = finishEffect(work, { unitId: id, instanceId: instance.id }, resources, tick);
            }
        }
    }

    for (const id of combatWorkView(work).unitIds) {
        work = finalizeFinishedEffects(work, id, resources, tick);
    }

    return work;
}
