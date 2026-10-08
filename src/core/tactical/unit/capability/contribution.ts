import type {
    NumericContributionKind,
    NumericContributionTransition,
    NumericProjectionTransition,
} from "../../modifier/contribution.js";
import type { CombatTargetingView } from "../targeting/query.js";
import type { StableUnit, Unit } from "../unit.js";

export type NumericContributionTarget<K extends NumericContributionKind = "all"> = <U extends Unit>(
    unit: U | StableUnit<U>,
    transition: NumericContributionTransition<K>,
) => StableUnit<U>;

export type NumericProjectionTarget = <U extends Unit>(
    unit: U | StableUnit<U>,
    transition: NumericProjectionTransition,
) => StableUnit<U>;

export interface NumericProviderFacts {
    readonly unit: Unit;
    readonly battlefield: CombatTargetingView;
}
