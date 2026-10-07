import {
    NumericContributionResources,
    type NumericContributionProvider,
} from "../../../modifier/providers.js";
import type { NumericProviderFacts } from "../contribution.js";
import { EffectResources } from "../effects/registry.js";
import { EffectLifecycleResources } from "../effects/lifecycle-resources.js";
import { EffectBindingResources } from "../effects/resources.js";
import { DamageResources, type DamageResourceServices } from "../vitality/damage/resources.js";
import { HealingResources, type HealingResourceServices } from "../vitality/healing/resources.js";
import { resolveHealing } from "../vitality/healing/settlement.js";
import { resolveDamage } from "../vitality/damage/settlement.js";
import type { DamageOperation, HealingOperation } from "../vitality/hook.js";

export interface ActionResources extends DamageResourceServices, HealingResourceServices {
    readonly offense: NumericContributionProvider<NumericProviderFacts>;
}

export interface ActionResourceSet extends ActionResources {
    readonly effects: EffectResources;
    readonly offense: NumericContributionResources<NumericProviderFacts>;
    readonly defense: NumericContributionResources<NumericProviderFacts>;
    readonly vitality: NumericContributionResources<NumericProviderFacts>;
    readonly effectBindings: EffectBindingResources;
    readonly effectLifecycle: EffectLifecycleResources;
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
}

export function createActionResources(): ActionResourceSet {
    const effects = new EffectResources();

    const resources: ActionResourceSet = {
        effects,
        offense: new NumericContributionResources<NumericProviderFacts>(),
        defense: new NumericContributionResources<NumericProviderFacts>(),
        vitality: new NumericContributionResources<NumericProviderFacts>(),
        effectBindings: new EffectBindingResources(),
        effectLifecycle: new EffectLifecycleResources(effects),
        damage: new DamageResources(effects),
        healing: new HealingResources(effects),
        settleDamage: (work, request, dispatch) =>
            resolveDamage(work, request, resources, dispatch),
        settleHealing: (work, request, tick, dispatch) =>
            resolveHealing(work, request, resources, tick, dispatch),
    };

    return resources;
}
