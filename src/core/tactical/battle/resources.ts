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
import type { NumericContributionResources } from "../modifier/providers.js";
import type { NumericProviderFacts } from "../unit/capability/contribution.js";
import { createActionResources } from "../unit/capability/action/resources.js";

export interface CombatEffectRules<S extends object>
    extends EffectContributionRules<S>, DamageEffectRules<S> {}

export class CombatResources {
    readonly effects: EffectResources;
    readonly offense: NumericContributionResources<NumericProviderFacts>;
    readonly defense: NumericContributionResources<NumericProviderFacts>;
    readonly vitality: NumericContributionResources<NumericProviderFacts>;
    readonly effectBindings: EffectBindingResources;
    readonly damage: DamageResources;
    readonly effectLifecycle: EffectLifecycleResources;

    constructor() {
        const resources = createActionResources();
        this.effects = resources.effects;
        this.offense = resources.offense;
        this.defense = resources.defense;
        this.vitality = resources.vitality;
        this.effectBindings = resources.effectBindings;
        this.damage = resources.damage;
        this.effectLifecycle = resources.effectLifecycle;
    }

    registerEffect<S extends object>(
        program: EffectProgram<S>,
        rules: NoInfer<CombatEffectRules<S>> = {},
        bindings: readonly CompiledEffectContribution[] = [],
    ): EffectProgram<S> {
        this.effects.register(program);
        this.effectBindings.register(program.ref, [
            ...compileEffectContributions(program, rules, this),
            ...bindings,
        ]);
        this.damage.register(program.ref, rules, this);

        return program;
    }
}
