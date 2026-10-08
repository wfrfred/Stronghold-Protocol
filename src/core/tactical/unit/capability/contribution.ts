import type * as contribution from "../../modifier/contribution.js";
import type { CombatTargetingView } from "../targeting/query.js";
import type { StableUnit, Unit } from "../unit.js";

export type ContributionTarget<K extends contribution.Kind = "all"> = <U extends Unit>(
    unit: U | StableUnit<U>,
    transition: contribution.Transition<K>,
) => StableUnit<U>;

export type StoredContributionTarget = <U extends Unit>(
    unit: U | StableUnit<U>,
    transition: contribution.ProjectionTransition,
) => StableUnit<U>;

export interface ContributionFacts {
    readonly unit: Unit;
    readonly battlefield: CombatTargetingView;
}
