import { hasOffense, resolveOffenseAttack } from "./capability.js";
import type { Unit, Id } from "../../unit.js";
import type { BattlefieldView } from "../../../battlefield/contract.js";
import type { Context } from "../../query.js";

export function resolveAttack(unit: Unit, context: Context): number {
    if (!hasOffense(unit)) {
        return 0;
    }

    return resolveOffenseAttack(unit.definition.offense, unit.offense, context);
}

export function resolveAttackPower(unitId: Id, battlefield: BattlefieldView): number | undefined {
    const unit = battlefield.getUnit(unitId);

    return unit === undefined ? undefined : resolveAttack(unit, { unit, battlefield });
}
