import { hasDefense, resolveDefenseParameters, type DefenseDefinition } from "./capability.js";
import type { Id } from "../../unit.js";
import type { BattlefieldView } from "../../../battlefield/contract.js";

export function resolveDefense(
    unitId: Id,
    battlefield: BattlefieldView,
): DefenseDefinition | undefined {
    const unit = battlefield.getUnit(unitId);

    if (unit === undefined) {
        return undefined;
    }
    if (!hasDefense(unit)) {
        return { defense: 0, resistance: 0 };
    }

    return resolveDefenseParameters(unit.definition.defense, unit.defense, { unit, battlefield });
}
