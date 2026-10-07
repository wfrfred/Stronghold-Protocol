import { type EffectResources } from "../unit/capability/effects/registry.js";
import { type EffectProgram } from "../unit/capability/effects/program.js";
import {
    compileEffectContributions,
    type EffectBindingResources,
    type EffectContributionRules,
} from "../unit/capability/effects/resources.js";
import {
    type DamageResources,
    type DamageEffectRules,
} from "../unit/capability/vitality/damage/resources.js";
import type { CompiledEffectContribution } from "../unit/capability/effects/contribution-bindings.js";
import type { EffectLifecycleResources } from "../unit/capability/effects/lifecycle-resources.js";
import type { EffectLifecycleProgram } from "../unit/capability/effects/contract.js";
import type {
    HealingResources,
    HealingEffectRules,
} from "../unit/capability/vitality/healing/resources.js";
import type { DamageOperation, HealingOperation } from "../unit/capability/vitality/hook.js";
import type { NumericContributionResources } from "../modifier/providers.js";
import type { NumericProviderFacts } from "../unit/capability/contribution.js";
import { createActionResources } from "../unit/capability/action/resources.js";

export interface CombatEffectFacets<S extends object> {
    readonly contributions?: EffectContributionRules<S>;
    readonly bindings?: readonly CompiledEffectContribution[];
    readonly damage?: DamageEffectRules<S>;
    readonly healing?: HealingEffectRules<S>;
    readonly lifecycle?: EffectLifecycleProgram<S>;
}

export class CombatResources {
    readonly effects: EffectResources;
    readonly offense: NumericContributionResources<NumericProviderFacts>;
    readonly defense: NumericContributionResources<NumericProviderFacts>;
    readonly vitality: NumericContributionResources<NumericProviderFacts>;
    readonly effectBindings: EffectBindingResources;
    readonly damage: DamageResources;
    readonly effectLifecycle: EffectLifecycleResources;
    readonly healing: HealingResources;
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;

    constructor() {
        const resources = createActionResources();
        this.effects = resources.effects;
        this.offense = resources.offense;
        this.defense = resources.defense;
        this.vitality = resources.vitality;
        this.effectBindings = resources.effectBindings;
        this.damage = resources.damage;
        this.effectLifecycle = resources.effectLifecycle;
        this.healing = resources.healing;
        this.settleDamage = resources.settleDamage;
        this.settleHealing = resources.settleHealing;
    }

    registerEffect<S extends object>(
        program: EffectProgram<S>,
        facets: NoInfer<CombatEffectFacets<S>> = {},
    ): EffectProgram<S> {
        this.effects.register(program);
        this.effectBindings.register(program.ref, [
            ...(facets.contributions === undefined
                ? []
                : compileEffectContributions(program, facets.contributions, this)),
            ...(facets.bindings ?? []),
        ]);

        if (facets.damage !== undefined) {
            this.damage.register(program.ref, facets.damage);
        }
        if (facets.healing !== undefined) {
            this.healing.register(program.ref, facets.healing);
        }
        if (facets.lifecycle !== undefined) {
            this.effectLifecycle.register(program.ref, facets.lifecycle);
        }

        return program;
    }
}
