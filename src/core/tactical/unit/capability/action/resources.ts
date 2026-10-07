import {
    NumericContributionResources,
    type NumericContributionProvider,
} from "../../../modifier/providers.js";
import type { NumericProviderFacts } from "../contribution.js";
import { EffectResources } from "../effects/registry.js";
import { EffectLifecycleResources } from "../effects/lifecycle-resources.js";
import { EffectBindingResources } from "../effects/resources.js";
import { DamageResources, type DamageResourceServices } from "../vitality/damage/resources.js";

export interface ActionResources extends DamageResourceServices {
    readonly offense: NumericContributionProvider<NumericProviderFacts>;
}

export function createActionResources() {
    const effects = new EffectResources();

    return {
        effects,
        offense: new NumericContributionResources<NumericProviderFacts>(),
        defense: new NumericContributionResources<NumericProviderFacts>(),
        vitality: new NumericContributionResources<NumericProviderFacts>(),
        effectBindings: new EffectBindingResources(),
        effectLifecycle: new EffectLifecycleResources(effects),
        damage: new DamageResources(effects),
    };
}
