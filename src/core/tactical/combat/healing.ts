import { hasStatusFlag } from "../unit/capability/status.js";
import { hasVitality, type VitalUnit } from "../unit/capability/vitality.js";
import type { UnitId } from "../unit/unit.js";
import { resolveMaxHp } from "./vitality.js";
import type { CombatResources } from "./resources.js";
import { appendCombatEvents, getCombatUnit, updateCombatUnit, type CombatWork } from "./work.js";

export interface HealingResult<U extends VitalUnit> {
    readonly unit: U;
    readonly amount: number;
}

export interface HealingRequest {
    readonly sourceUnitId: UnitId | null;
    readonly targetUnitId: UnitId;
    readonly power: number;
    readonly ignoreHealFree: boolean;
}

export interface HealingResolution {
    readonly work: CombatWork;
    readonly amount: number;
}

export function healUnit<U extends VitalUnit>(
    unit: U,
    power: number,
    ignoreHealFree = false,
    maxHp = unit.definition.vitality.maxHp,
): HealingResult<U> {
    if (unit.vitality.hp <= 0 || (!ignoreHealFree && hasStatusFlag(unit, "HEAL_FREE"))) {
        return { unit, amount: 0 };
    }

    const amount = Math.max(0, Math.min(power, maxHp - unit.vitality.hp));

    return {
        unit:
            amount === 0
                ? unit
                : { ...unit, vitality: { ...unit.vitality, hp: unit.vitality.hp + amount } },
        amount,
    };
}

export function resolveHealing(
    work: CombatWork,
    request: HealingRequest,
    resources: CombatResources,
    tick: number,
): HealingResolution {
    const target = getCombatUnit(work, request.targetUnitId);

    if (target === undefined || !hasVitality(target) || target.vitality.hp <= 0) {
        return { work, amount: 0 };
    }

    const healed = healUnit(
        target,
        request.power,
        request.ignoreHealFree,
        resolveMaxHp(target.id, work, resources),
    );
    const nextWork = appendCombatEvents(updateCombatUnit(work, healed.unit), [
        {
            type: "HEAL",
            sourceUnitId: request.sourceUnitId,
            targetUnitId: request.targetUnitId,
            amount: healed.amount,
            hp: healed.unit.vitality.hp,
            tick,
        },
    ]);

    return { work: nextWork, amount: healed.amount };
}
