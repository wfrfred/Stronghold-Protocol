import { ResourceRegistration } from "../../common/resource-registration.js";
import { EffectResources } from "../unit/capability/effects/registry.js";
import { type EffectProgram } from "../unit/capability/effects/program.js";
import { EffectBindingResources } from "../unit/capability/effects/resources.js";
import * as contributions from "../unit/capability/effects/contributions.js";
import {
    DamageResources,
    type DamageEffectRules,
} from "../unit/capability/vitality/damage/resources.js";
import type { EffectBinding } from "../unit/capability/effects/binding.js";
import { EffectLifecycleResources } from "../unit/capability/effects/lifecycle-resources.js";
import type { EffectLifecycleProgram } from "../unit/capability/effects/contract.js";
import {
    HealingResources,
    type HealingEffectRules,
} from "../unit/capability/vitality/healing/resources.js";
import type { DamageOperation, HealingOperation } from "../unit/capability/vitality/hook.js";
import * as computation from "../modifier/computation.js";
import type { ContributionFacts } from "../unit/capability/contribution.js";
import { EffectSourceResources } from "../battlefield/effect-source/resources.js";
import { ProjectileResources } from "../battlefield/projectile/resources.js";
import { resolveDamage } from "../unit/capability/vitality/damage/settlement.js";
import { resolveHealing } from "../unit/capability/vitality/healing/settlement.js";

export interface CombatEffectFacets<S extends object> {
    readonly contributions?: readonly contributions.Definition<S>[];
    readonly bindings?: readonly EffectBinding[];
    readonly damage?: DamageEffectRules<S>;
    readonly healing?: HealingEffectRules<S>;
    readonly lifecycle?: EffectLifecycleProgram<S>;
}

export class CombatResources {
    readonly #registration = new ResourceRegistration();
    readonly effects = new EffectResources(this.#registration);
    readonly computations = new computation.Resources<ContributionFacts>(this.#registration);
    readonly effectBindings = new EffectBindingResources(this.#registration);
    readonly damage = new DamageResources(this.effects, this.#registration);
    readonly effectLifecycle = new EffectLifecycleResources(this.effects, this.#registration);
    readonly healing = new HealingResources(this.effects, this.#registration);
    readonly effectSources = new EffectSourceResources(this.#registration);
    readonly projectiles = new ProjectileResources(this.#registration);
    readonly settleDamage: DamageOperation = (work, request, dispatch) => {
        this.#registration.assertUsable();

        return resolveDamage(work, request, this, dispatch);
    };

    readonly settleHealing: HealingOperation = (work, request, tick, dispatch) => {
        this.#registration.assertUsable();

        return resolveHealing(work, request, this, tick, dispatch);
    };

    seal(): this {
        this.#registration.seal();

        return this;
    }

    registerEffect<S extends object>(
        program: EffectProgram<S>,
        facets: NoInfer<CombatEffectFacets<S>> = {},
    ): EffectProgram<S> {
        this.#registration.assertWritable();

        try {
            const registered = this.effects.register(program);
            this.effectBindings.register(registered.ref, [
                ...(facets.contributions === undefined
                    ? []
                    : contributions.compile(registered, facets.contributions, this)),
                ...(facets.bindings ?? []),
            ]);

            if (facets.damage !== undefined) {
                this.damage.register(registered.ref, facets.damage);
            }
            if (facets.healing !== undefined) {
                this.healing.register(registered.ref, facets.healing);
            }
            if (facets.lifecycle !== undefined) {
                this.effectLifecycle.register(registered.ref, facets.lifecycle);
            }

            return registered;
        } catch (error) {
            this.#registration.fail();
            throw error;
        }
    }
}
