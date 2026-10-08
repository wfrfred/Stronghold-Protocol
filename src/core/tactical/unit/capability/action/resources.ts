import type { NumericContributionProvider } from "../../../modifier/providers.js";
import type { NumericProviderFacts } from "../contribution.js";
import type { DamageOperation, HealingOperation } from "../vitality/hook.js";

export interface ActionResources {
    readonly offense: NumericContributionProvider<NumericProviderFacts>;
    readonly vitality: NumericContributionProvider<NumericProviderFacts>;
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
}
