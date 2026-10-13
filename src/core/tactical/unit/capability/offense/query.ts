import { hasOffense, resolveOffenseAttack } from "./capability.js";
import type { Id } from "../../unit.js";
import type { BattlefieldView } from "../../../battlefield/contract.js";

export function resolveAttackPower(unitId: Id, battlefield: BattlefieldView): number | undefined {
    const unit = battlefield.getUnit(unitId);

    if (unit === undefined) {
        return undefined;
    }

    return hasOffense(unit)
        ? resolveOffenseAttack(unit.definition.offense, unit.offense, { unit, battlefield })
        : 0;
}
