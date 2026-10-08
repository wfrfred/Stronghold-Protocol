import type {
    NumericContributionKind,
    NumericContributionTransition,
    NumericProjectionTransition,
} from "../../modifier/contribution.js";
import type { CombatTargetingView } from "../targeting/query.js";
import type { Unit } from "../unit.js";

export type NumericContributionTarget<K extends NumericContributionKind = "all"> = <U extends Unit>(
    unit: U,
    transition: NumericContributionTransition<K>,
) => U;

export type NumericProjectionTarget = <U extends Unit>(
    unit: U,
    transition: NumericProjectionTransition,
) => U;

export interface NumericProviderFacts {
    readonly unit: Unit;
    readonly battlefield: CombatTargetingView;
}
