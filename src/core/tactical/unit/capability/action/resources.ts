import type * as computation from "../../../modifier/computation.js";
import type { ContributionFacts } from "../contribution.js";
import type { resolveElementDamage, resolveElementHeal } from "../elemental/execution.js";
import type { DamageOperation, HealingOperation } from "../vitality/hook.js";

export interface ActionResources {
    readonly computations: computation.Computations<ContributionFacts>;
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
    readonly settleElementDamage: (
        work: Parameters<typeof resolveElementDamage>[0],
        request: Parameters<typeof resolveElementDamage>[1],
    ) => ReturnType<typeof resolveElementDamage>;
    readonly settleElementHeal: typeof resolveElementHeal;
}
