import type * as contribution from "../../modifier/contribution.js";
import type { BattlefieldView } from "../../battlefield/contract.js";
import type { StableUnit, Unit } from "../unit.js";

export type Target<M extends contribution.Mode = contribution.Mode> = <U extends Unit>(
    unit: U | StableUnit<U>,
    transition: contribution.Transition<M>,
) => StableUnit<U>;

export type SampledTarget = <U extends Unit>(
    unit: U | StableUnit<U>,
    transition: contribution.SampledTransition,
) => StableUnit<U>;

export interface Context {
    readonly unit: Unit;
    readonly battlefield: BattlefieldView;
}
