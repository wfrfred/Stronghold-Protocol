import { ResourceRegistration } from "../../common/resource-registration.js";
import type { DamageOperation } from "../unit/capability/vitality/damage/contract.js";
import type { HealingOperation } from "../unit/capability/vitality/healing/contract.js";
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
    readonly settleElementDamage: ElementDamageOperation = (battle, request) => {
        this.#registration.assertUsable();

        return resolveElementDamage(battle, request, this);
    };

    readonly settleElementHeal: ElementHealOperation = (battle, request) => {
        this.#registration.assertUsable();

        return resolveElementHeal(battle, request);
    };

    readonly completeAttack = (battle: BattleState, unitId: UnitId, tick: number): void => {
        const consumed = consumeSkillAmmo(battle, unitId, tick, this);
        appendEvents(battle, consumed.signals);
    };

    readonly stopSkillActivation = (battle: BattleState, unitId: UnitId, tick: number) =>
        stopSkillActivation(battle, unitId, tick, this);

    readonly notifySkillFinished = (
        battle: BattleState,
        activation: StoppedSkillActivation,
        tick: number,
    ): void => {
        const finished = notifySkillFinished(battle, activation, tick, this);
        appendEvents(battle, finished.signals);
    };

    readonly finishSkill = (battle: BattleState, unitId: UnitId, tick: number): void => {
        const finished = finishSkill(battle, unitId, tick, this);
        appendEvents(battle, finished.signals);
    };

    readonly retireUnit = (battle: BattleState, unitId: UnitId, tick: number): void => {
        retireCombatUnit(battle, unitId, this, tick);
    };

    readonly settleDamage: DamageOperation = (battle, request, dispatch) => {
        this.#registration.assertUsable();

        return resolveDamage(battle, request, this, dispatch);
    };

    readonly settleHealing: HealingOperation = (battle, request, dispatch) => {
        this.#registration.assertUsable();

        return resolveHealing(battle, request, this, dispatch);
    };

    seal(): this {
        this.#registration.seal();

        return this;
    }
}
