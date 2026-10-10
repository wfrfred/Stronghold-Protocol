import { hasOffense, resolveOffenseAttack } from "./capability.js";
import type { UnitId } from "../../unit.js";
import type { BattlefieldView } from "../../../battlefield/contract.js";
import type * as computation from "../../../contribution/computation.js";
import type { QueryContext } from "../../../contribution/definition.js";

export function resolveAttackPower(
    unitId: UnitId,
    battlefield: BattlefieldView,
    computations?: computation.Computations<QueryContext>,
): number | undefined {
    const unit = battlefield.getUnit(unitId);

    if (unit === undefined) {
        return undefined;
    }
    if (!hasOffense(unit)) {
        return 0;
    }

    return resolveOffenseAttack(
        unit.definition.offense,
        unit.offense,
        computations?.bind({ unit, battlefield }),
    );
}
