import type { DamageType } from "./effect.js";
import { hasDefenseDefinition, type DefenseDefinition } from "../unit/capability/defense.js";
import type { Vitality } from "../unit/capability/vitality.js";
import type { Unit } from "../unit/unit.js";
import { hasStatusFlag } from "../unit/capability/status.js";

const NO_DEFENSE: DefenseDefinition = Object.freeze({ defense: 0, resistance: 0 });

export interface DamageResult<U extends Unit & Vitality> {
    readonly unit: U;
    readonly amount: number;
    readonly killed: boolean;
}

export function calculateDamage(
    power: number,
    damageType: DamageType,
    defense: DefenseDefinition,
): number {
    switch (damageType) {
        case "PHYSICAL":
            return Math.max(power * 0.05, power - defense.defense);

        case "ARTS":
            return Math.max(power * 0.05, power * (1 - defense.resistance / 100));

        case "TRUE":
            return power;
    }
}

export function damageUnit<U extends Unit & Vitality>(
    unit: U,
    power: number,
    damageType: DamageType,
): DamageResult<U> {
    const defense = hasDefenseDefinition(unit.definition) ? unit.definition.defense : NO_DEFENSE;
    const damage = hasStatusFlag(unit, "INVINCIBLE")
        ? 0
        : calculateDamage(power, damageType, defense);
    const hp = Math.max(0, unit.vitality.hp - damage);
    const amount = unit.vitality.hp - hp;

    return {
        unit: amount === 0 ? unit : { ...unit, vitality: { ...unit.vitality, hp } },
        amount,
        killed: hp === 0,
    };
}
