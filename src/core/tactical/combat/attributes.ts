import { resolveNumericValue } from "../modifier/numeric.js";
import { hasDefenseDefinition, type DefenseDefinition } from "../unit/capability/defense.js";
import { hasOffenseDefinition } from "../unit/capability/offense.js";
import type { VitalUnit } from "../unit/capability/vitality.js";
import type { Unit } from "../unit/unit.js";
import type { CombatResources } from "./resources.js";
import type { CombatWork } from "./work.js";

export function resolveAttackPower(
    unit: Unit,
    work: CombatWork,
    resources: CombatResources,
): number {
    const base = hasOffenseDefinition(unit.definition) ? unit.definition.offense.attack : 0;

    return Math.max(0, resolveNumericValue(base, resources.contributions("attack", unit, work)));
}

export function resolveDefense(
    unit: Unit,
    work: CombatWork,
    resources: CombatResources,
): DefenseDefinition {
    const base = hasDefenseDefinition(unit.definition)
        ? unit.definition.defense
        : { defense: 0, resistance: 0 };

    return {
        defense: Math.max(
            0,
            resolveNumericValue(base.defense, resources.contributions("defense", unit, work)),
        ),
        resistance: Math.max(
            0,
            resolveNumericValue(base.resistance, resources.contributions("resistance", unit, work)),
        ),
    };
}

export function resolveMaxHp(
    unit: VitalUnit,
    work: CombatWork,
    resources: CombatResources,
): number {
    return Math.max(
        1,
        resolveNumericValue(
            unit.definition.vitality.maxHp,
            resources.contributions("maxHp", unit, work),
        ),
    );
}
