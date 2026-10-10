import type * as computation from "../../../contribution/computation.js";
import type { QueryContext } from "../../../contribution/definition.js";
import type { ElementDamageOperation, ElementHealOperation } from "../elemental/execution.js";
import type { DamageOperation } from "../vitality/damage/contract.js";
import type { HealingOperation } from "../vitality/healing/contract.js";

export interface ActionResources {
    readonly computations: computation.Computations<QueryContext>;
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
    readonly settleElementDamage: ElementDamageOperation;
    readonly settleElementHeal: ElementHealOperation;
}
