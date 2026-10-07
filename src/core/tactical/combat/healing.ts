import { hasStatusFlag } from "../unit/capability/status.js";
import type { VitalUnit } from "../unit/capability/vitality.js";

export interface HealingResult<U extends VitalUnit> {
    readonly unit: U;
    readonly amount: number;
}

export function healUnit<U extends VitalUnit>(
    unit: U,
    power: number,
    ignoreHealFree = false,
): HealingResult<U> {
    if (unit.vitality.hp <= 0 || (!ignoreHealFree && hasStatusFlag(unit, "HEAL_FREE"))) {
        return { unit, amount: 0 };
    }

    const amount = Math.max(0, Math.min(power, unit.definition.vitality.maxHp - unit.vitality.hp));

    return {
        unit:
            amount === 0
                ? unit
                : { ...unit, vitality: { ...unit.vitality, hp: unit.vitality.hp + amount } },
        amount,
    };
}
