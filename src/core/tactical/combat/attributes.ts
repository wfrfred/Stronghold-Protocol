import type { DefenseDefinition } from "../unit/capability/defense.js";
import type { VitalUnit } from "../unit/capability/vitality.js";
import type { Unit } from "../unit/unit.js";
import type { CombatResources } from "./resources.js";
import type { CombatWork } from "./work.js";
import { resolveAttackPower as currentAttackPower } from "./offense.js";
import { resolveDefense as currentDefense } from "./defense.js";
import { resolveMaxHp as currentMaxHp } from "./vitality.js";

export function resolveAttackPower(
    unit: Unit,
    work: CombatWork,
    resources: CombatResources,
): number {
    return currentAttackPower(unit.id, work, resources) ?? 0;
}

export function resolveDefense(
    unit: Unit,
    work: CombatWork,
    resources: CombatResources,
): DefenseDefinition {
    return currentDefense(unit.id, work, resources) ?? { defense: 0, resistance: 0 };
}

export function resolveMaxHp(
    unit: VitalUnit,
    work: CombatWork,
    resources: CombatResources,
): number {
    return currentMaxHp(unit.id, work, resources) ?? 0;
}
