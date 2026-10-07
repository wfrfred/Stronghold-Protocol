import { hasDefense, resolveDefenseParameters, type DefenseDefinition } from "./capability.js";
import type { UnitId } from "../../unit.js";
import type { CombatTargetingView } from "../../targeting/query.js";
import type { NumericContributionProvider } from "../../../modifier/providers.js";
import type { NumericProviderFacts } from "../contribution.js";

export function resolveDefense(
    unitId: UnitId,
    battlefield: CombatTargetingView,
    providers?: NumericContributionProvider<NumericProviderFacts>,
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
        providers?.evaluator({ unit, battlefield }),
    );
}
