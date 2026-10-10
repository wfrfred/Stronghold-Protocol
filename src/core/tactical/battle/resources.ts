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
import type { DamageOperation } from "../unit/capability/vitality/damage/contract.js";
import type { HealingOperation } from "../unit/capability/vitality/healing/contract.js";
import * as computation from "../modifier/computation.js";
import type { ContributionFacts } from "../unit/capability/contribution.js";
import { EffectSourceResources } from "../battlefield/effect-source/resources.js";
import { ProjectileResources } from "../battlefield/projectile/resources.js";
import { resolveDamage } from "../unit/capability/vitality/damage/settlement.js";
import { resolveHealing } from "../unit/capability/vitality/healing/settlement.js";
import { appendEvents, type BattleState } from "./execution/context.js";
import type { UnitId } from "../unit/unit.js";
import {
    consumeSkillAmmo,
    finishSkill,
    stopSkillActivation,
    notifySkillFinished,
    type StoppedSkillActivation,
} from "../unit/capability/skill/execution.js";
import type { EffectDispatchScope } from "../unit/capability/effects/dispatch.js";
import {
    ActionReleaseResources,
    type ActionReleaseRules,
} from "../unit/capability/action/release.js";
import { ElementalResources } from "../unit/capability/elemental/resources.js";
import {
    resolveElementDamage,
    resolveElementHeal,
    type ElementDamageOperation,
    type ElementHealOperation,
} from "../unit/capability/elemental/execution.js";
import { SkillResources } from "../unit/capability/skill/resources.js";

export interface CombatEffectFacets<S extends object> {
    readonly contributions?: readonly contributions.Definition<S>[];
    readonly bindings?: readonly EffectBinding[];
    readonly damage?: DamageEffectRules<S>;
    readonly healing?: HealingEffectRules<S>;
    readonly lifecycle?: EffectLifecycleProgram<S>;
    readonly action?: ActionReleaseRules<S>;
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
    readonly skills = new SkillResources(this.#registration);
    readonly elemental = new ElementalResources(this.#registration);
    readonly settleElementDamage: ElementDamageOperation = (work, request) => {
        this.#registration.assertUsable();

        return resolveElementDamage(work, request, this);
    };

    readonly settleElementHeal: ElementHealOperation = (work, request) => {
        this.#registration.assertUsable();

        return resolveElementHeal(work, request);
    };

    readonly actionRelease = new ActionReleaseResources(this.effects, this.#registration);
    readonly completeAttack = (
        work: BattleState,
        unitId: UnitId,
        tick: number,
        dispatch?: EffectDispatchScope,
    ): void => {
        const consumed = consumeSkillAmmo(work, unitId, tick, this, dispatch);

        appendEvents(work, consumed.signals);
    };

    readonly stopSkillActivation = (work: BattleState, unitId: UnitId, tick: number) =>
        stopSkillActivation(work, unitId, tick, this);

    readonly notifySkillFinished = (
        work: BattleState,
        activation: StoppedSkillActivation,
        tick: number,
        dispatch: EffectDispatchScope,
    ): void => {
        const finished = notifySkillFinished(work, activation, tick, this, dispatch);

        appendEvents(work, finished.signals);
    };

    readonly finishSkill = (
        work: BattleState,
        unitId: UnitId,
        tick: number,
        dispatch?: EffectDispatchScope,
    ): void => {
        const finished = finishSkill(work, unitId, tick, this, dispatch);

        appendEvents(work, finished.signals);
    };

    readonly settleDamage: DamageOperation = (work, request, dispatch) => {
        this.#registration.assertUsable();

        return resolveDamage(work, request, this, dispatch);
    };

    readonly settleHealing: HealingOperation = (work, request, dispatch) => {
        this.#registration.assertUsable();

        return resolveHealing(work, request, this, dispatch);
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
            if (facets.action !== undefined) {
                this.actionRelease.register(registered.ref, facets.action);
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
