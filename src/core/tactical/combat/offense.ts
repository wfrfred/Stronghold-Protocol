import { hasOffense, resolveOffenseAttack } from "../unit/capability/offense.js";
import type { UnitId } from "../unit/unit.js";
import type { CombatResources } from "./resources.js";
import { getCombatUnit, type CombatWork } from "./work.js";

export function resolveAttackPower(
    unitId: UnitId,
    work: CombatWork,
    resources: CombatResources,
): number | undefined {
    const unit = getCombatUnit(work, unitId);

    if (unit === undefined) {
        return undefined;
    }
    if (!hasOffense(unit)) {
        return 0;
    }

    return resolveOffenseAttack(
        unit.definition.offense,
        unit.offense,
        resources.offense.evaluator(unit, work),
    );
}
