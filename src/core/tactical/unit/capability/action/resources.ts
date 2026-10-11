import type { ElementDamageOperation, ElementHealOperation } from "../elemental/execution.js";
import type { DamageOperation } from "../vitality/damage/contract.js";
import type { HealingOperation } from "../vitality/healing/contract.js";

export interface ActionResources {
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
    readonly settleElementDamage: ElementDamageOperation;
    readonly settleElementHeal: ElementHealOperation;
}
