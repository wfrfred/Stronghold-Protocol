import { hasVitality, resolveVitalityMaxHp } from "./capability.js";
import type { UnitId } from "../../unit.js";
import type { CombatTargetingView } from "../../targeting/query.js";

export function resolveMaxHp(unitId: UnitId, battlefield: CombatTargetingView): number | undefined {
    const unit = battlefield.getUnit(unitId);

    if (unit === undefined || !hasVitality(unit)) {
        return undefined;
    }

    return resolveVitalityMaxHp(unit.definition.vitality, unit.vitality);
}
