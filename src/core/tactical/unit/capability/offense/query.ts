import { hasOffense, resolveOffenseAttack } from "./capability.js";
import type { Unit, UnitId } from "../../unit.js";
import type { BattlefieldView } from "../../../battlefield/contract.js";
import type { QueryContext } from "../../query.js";

export function resolveAttack(unit: Unit, context: QueryContext): number {
    if (!hasOffense(unit)) {
        return 0;
    }

    return resolveOffenseAttack(unit.definition.offense, unit.offense, context);
}

export function resolveAttackPower(
    unitId: UnitId,
    battlefield: BattlefieldView,
): number | undefined {
    const unit = battlefield.getUnit(unitId);

    return unit === undefined ? undefined : resolveAttack(unit, { unit, battlefield });
}
