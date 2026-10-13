import { ResourceRegistration } from "../../common/resource-registration.js";
import type { DamageOperation } from "../unit/capability/vitality/damage/contract.js";
import type { HealingOperation } from "../unit/capability/vitality/healing/contract.js";
import { ProjectileResources } from "../battlefield/projectile/resources.js";
import { resolveDamage } from "../unit/capability/vitality/damage/settlement.js";
import { resolveHealing } from "../unit/capability/vitality/healing/settlement.js";
import type { BattleState } from "./state.js";
import { emptyCall, type CallContext } from "./execution/call.js";
import type { Id } from "../unit/unit.js";
import {
    consumeSkillAmmo,
    stopSkillActivation,
    notifySkillFinished,
    type StoppedSkillActivation,
} from "../unit/capability/skill/execution.js";
import { retireCombatUnit } from "./execution/unit-lifecycle.js";
import { ElementalResources } from "../unit/capability/elemental/resources.js";
import {
    resolveElementDamage,
    resolveElementHeal,
    type ElementDamageOperation,
    type ElementHealOperation,
} from "../unit/capability/elemental/execution.js";
import { SkillResources } from "../unit/capability/skill/resources.js";

export class CombatResources {
    readonly #registration = new ResourceRegistration();
    readonly projectiles = new ProjectileResources(this.#registration);
    readonly skills = new SkillResources(this.#registration);
    readonly elemental = new ElementalResources(this.#registration);
    readonly settleElementDamage: ElementDamageOperation = (state, request, call) => {
        this.#registration.assertUsable();

        return resolveElementDamage(state, request, this, call);
    };

    readonly settleElementHeal: ElementHealOperation = (state, request) => {
        this.#registration.assertUsable();

        return resolveElementHeal(state, request);
    };

    readonly completeAttack = (
        state: BattleState,
        unitId: Id,
        tick: number,
        call: CallContext = emptyCall,
    ): BattleState => consumeSkillAmmo(state, unitId, tick, this, call).state;

    readonly stopSkillActivation = (state: BattleState, unitId: Id, tick: number) =>
        stopSkillActivation(state, unitId, tick, this);

    readonly notifySkillFinished = (
        state: BattleState,
        activation: StoppedSkillActivation,
        tick: number,
        call: CallContext = emptyCall,
    ): BattleState => notifySkillFinished(state, activation, tick, call);

    readonly retireUnit = (
        state: BattleState,
        unitId: Id,
        tick: number,
        call: CallContext = emptyCall,
    ): BattleState => retireCombatUnit(state, unitId, this, tick, call);

    readonly settleDamage: DamageOperation = (state, request, call) => {
        this.#registration.assertUsable();

        return resolveDamage(state, request, this, call);
    };

    readonly settleHealing: HealingOperation = (state, request, call) => {
        this.#registration.assertUsable();

        return resolveHealing(state, request, call);
    };

    seal(): this {
        this.#registration.seal();

        return this;
    }
}
