import { hasDefense, resolveDefenseParameters, type DefenseDefinition } from "./capability.js";
import type { UnitId } from "../../unit.js";
import type { BattlefieldView } from "../../../battlefield/contract.js";
import type * as computation from "../../../contribution/computation.js";
import type { QueryContext } from "../../../contribution/definition.js";

export function resolveDefense(
    unitId: UnitId,
    battlefield: BattlefieldView,
    computations?: computation.Computations<QueryContext>,
): DefenseDefinition | undefined {
    const unit = battlefield.getUnit(unitId);

    if (unit === undefined) {
        return undefined;
    }
    if (!hasDefense(unit)) {
        return { defense: 0, resistance: 0 };
    }

    return resolveDefenseParameters(
        unit.definition.defense,
        unit.defense,
        computations?.bind({ unit, battlefield }),
    );
}
