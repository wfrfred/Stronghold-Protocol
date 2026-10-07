import {
    hasDefense,
    resolveDefenseParameters,
    type DefenseDefinition,
} from "../unit/capability/defense.js";
import type { UnitId } from "../unit/unit.js";
import type { CombatResources } from "./resources.js";
import { getCombatUnit, type CombatWork } from "./work.js";

export function resolveDefense(
    unitId: UnitId,
    work: CombatWork,
    resources: CombatResources,
): DefenseDefinition | undefined {
    const unit = getCombatUnit(work, unitId);

    if (unit === undefined) {
        return undefined;
    }
    if (!hasDefense(unit)) {
        return { defense: 0, resistance: 0 };
    }

    return resolveDefenseParameters(
        unit.definition.defense,
        unit.defense,
        resources.defense.evaluator(unit, work),
    );
}
