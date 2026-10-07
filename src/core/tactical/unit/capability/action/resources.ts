import { ResourceRegistration } from "../../../../common/resource-registration.js";
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
import { EffectSourceResources } from "../../../battlefield/effect-source/resources.js";

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
    readonly effectSources: EffectSourceResources;
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
}

export function createActionResources(
    registration = new ResourceRegistration(),
): ActionResourceSet {
    const effects = new EffectResources(registration);

    const resources: ActionResourceSet = {
        effects,
        offense: new NumericContributionResources<NumericProviderFacts>(registration),
        defense: new NumericContributionResources<NumericProviderFacts>(registration),
        vitality: new NumericContributionResources<NumericProviderFacts>(registration),
        effectBindings: new EffectBindingResources(registration),
        effectLifecycle: new EffectLifecycleResources(effects, registration),
        effectSources: new EffectSourceResources(registration),
        damage: new DamageResources(effects, registration),
        healing: new HealingResources(effects, registration),
        settleDamage: (work, request, dispatch) => {
            registration.assertUsable();

            return resolveDamage(work, request, resources, dispatch);
        },
        settleHealing: (work, request, tick, dispatch) => {
            registration.assertUsable();

            return resolveHealing(work, request, resources, tick, dispatch);
        },
    };

    return resources;
}
