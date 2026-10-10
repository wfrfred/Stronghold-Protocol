import { hasDefense, resolveDefenseParameters, type DefenseDefinition } from "./capability.js";
import type { UnitId } from "../../unit.js";
import type { BattlefieldView } from "../../../battlefield/contract.js";
import type * as computation from "../../../modifier/computation.js";
import type { Context } from "../contribution.js";

export function resolveDefense(
    unitId: UnitId,
    battlefield: BattlefieldView,
    computations?: computation.Computations<Context>,
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
