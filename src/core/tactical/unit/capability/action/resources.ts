import type * as computation from "../../../modifier/computation.js";
import type { ContributionFacts } from "../contribution.js";
import type { DamageOperation, HealingOperation } from "../vitality/hook.js";

export interface ActionResources {
    readonly computations: computation.Computations<ContributionFacts>;
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
}
