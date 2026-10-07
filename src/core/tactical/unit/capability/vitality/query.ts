import { hasVitality, resolveVitalityMaxHp } from "./capability.js";
import type { UnitId } from "../../unit.js";
import type { CombatTargetingView } from "../../targeting/query.js";
import type { NumericContributionProvider } from "../../../modifier/providers.js";
import type { NumericProviderFacts } from "../contribution.js";

export function resolveMaxHp(
    unitId: UnitId,
    battlefield: CombatTargetingView,
    providers?: NumericContributionProvider<NumericProviderFacts>,
): number | undefined {
    const unit = battlefield.getUnit(unitId);

    if (unit === undefined || !hasVitality(unit)) {
        return undefined;
    }

    return resolveVitalityMaxHp(
        unit.definition.vitality,
        unit.vitality,
        providers?.evaluator({ unit, battlefield }),
    );
}
