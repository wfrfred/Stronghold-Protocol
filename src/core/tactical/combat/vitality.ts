import { hasVitality, resolveVitalityMaxHp } from "../unit/capability/vitality.js";
import type { UnitId } from "../unit/unit.js";
import type { CombatResources } from "./resources.js";
import { getCombatUnit, type CombatWork } from "./work.js";

export function resolveMaxHp(
    unitId: UnitId,
    work: CombatWork,
    resources: CombatResources,
): number | undefined {
    const unit = getCombatUnit(work, unitId);

    if (unit === undefined || !hasVitality(unit)) {
        return undefined;
    }

    return resolveVitalityMaxHp(
        unit.definition.vitality,
        unit.vitality,
        resources.vitality.evaluator(unit, work),
    );
}
