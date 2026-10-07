import { hasOffense, resolveOffenseAttack } from "./capability.js";
import type { UnitId } from "../../unit.js";
import type { CombatTargetingView } from "../../targeting/query.js";
import type { NumericContributionProvider } from "../../../modifier/providers.js";
import type { NumericProviderFacts } from "../contribution.js";

export function resolveAttackPower(
    unitId: UnitId,
    battlefield: CombatTargetingView,
    providers?: NumericContributionProvider<NumericProviderFacts>,
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
        providers?.evaluator({ unit, battlefield }),
    );
}
