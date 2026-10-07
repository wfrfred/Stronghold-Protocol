import type { NumericContributionTransition } from "../../modifier/contribution.js";
import type { CombatTargetingView } from "../targeting/query.js";
import type { Unit } from "../unit.js";

export type NumericContributionTarget = <U extends Unit>(
    unit: U,
    transition: NumericContributionTransition,
) => U;

export interface NumericProviderFacts {
    readonly unit: Unit;
    readonly battlefield: CombatTargetingView;
}
