import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import {
    getCombatUnit,
    combatWorkView,
    updateCombatUnit,
    type CombatWork,
} from "../../../battle/execution/work.js";
import type { UnitId } from "../../unit.js";
import { TICKS_PER_SECOND } from "../../../tick.js";
import type { EffectTransitionResources } from "../effects/contract.js";
import { EffectDispatchScope } from "../effects/dispatch.js";
import { finishEffect } from "../effects/lifecycle.js";
import { createEffectOperations } from "../effects/operations.js";
import { isSpatiallyPresent } from "../presence.js";
import { hasStatusFlag } from "../status/capability.js";
import { hasVitality } from "../vitality/capability.js";
import type { DamageOperation } from "../vitality/damage/contract.js";
import type { HealingOperation } from "../vitality/healing/contract.js";
import {
    copySkillState,
    hasSkill,
    skillSpCapacity,
    type SkillActivation,
    type SkillActivationMode,
    type SkillState,
} from "./capability.js";
import type { SkillActivationContext, SkillFacts } from "./program.js";
import { spendSkillSp } from "./sp.js";
import type { SkillResources } from "./resources.js";
import { spendSkillAmmo, type SkillAmmoResult } from "./ammo.js";

export interface SkillExecutionResources extends EffectTransitionResources {
    readonly skills: SkillResources;
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
}

function skillFacts(readWork: () => CombatWork): SkillFacts {
    return {
        get unitIds() {
            return combatWorkView(readWork()).unitIds;
        },
        getUnit: (id) => getCombatUnit(readWork(), id),
        blockerOf: (id) => combatWorkView(readWork()).blockerOf(id),
        blockedBy: (id) => combatWorkView(readWork()).blockedBy(id),
    };
}

export interface SkillActivationInput {
    readonly unitId: UnitId;
    readonly tick: number;
    readonly trigger?: SkillActivationMode;
}

export type SkillSignal = {
    readonly unitId: UnitId;
    readonly skillId: string;
    readonly activationId: number;
    readonly tick: number;
} & (
    | { readonly type: "SKILL_ACTIVATED"; readonly endsAtTick: number | null }
    | { readonly type: "SKILL_FINISHED" }
);

export type SkillExecutionResult =
    | { readonly type: "ACTIVATED" | "FINISHED" | "ADVANCED" | "ABSENT" }
    | {
          readonly type: "REJECTED";
          readonly reason:
              | "UNAVAILABLE"
              | "ACTIVE"
              | "WRONG_TRIGGER"
              | "INSUFFICIENT_SP"
              | "CONDITION"
              | "ALREADY_ACTIVATED"
              | "CONTENT_REJECTED";
          readonly detail?: string;
      };

export interface SkillTransition {
    readonly work: CombatWork;
    readonly result: SkillExecutionResult;
    readonly signals: readonly SkillSignal[];
}

function saveState(work: CombatWork, unitId: UnitId, state: SkillState): CombatWork {
    const unit = getCombatUnit(work, unitId);

    return unit === undefined || !hasSkill(unit) || unit.skill === state
        ? work
        : updateCombatUnit(work, { ...unit, skill: copySkillState(state) });
}

function withSkillContext<R>(
    work: CombatWork,
    unitId: UnitId,
    activation: SkillActivation,
    resources: SkillExecutionResources,
    tick: number,
    run: (context: SkillActivationContext) => R,
    dispatch = new EffectDispatchScope(),
): { readonly work: CombatWork; readonly result: R } {
    let current = work;
    let active = true;

    const readWork = () => {
        if (!active) {
            throw new TypeError("skill context is no longer active");
        }

        return current;
    };

    try {
        const result = run({
            unitId,
            tick,
            activationId: activation.id,
            endsAtTick: activation.endsAtTick,
            facts: skillFacts(readWork),
            effects: createEffectOperations(
                readWork,
                (next) => {
                    current = next;
                },
                resources,
                tick,
                dispatch,
            ),
            damage: (request) => {
                const result = resources.settleDamage(readWork(), { ...request, tick }, dispatch);
                current = result.work;

                return result.report;
            },
            heal: (request) => {
                const result = resources.settleHealing(readWork(), { ...request, tick }, dispatch);
                current = result.work;

                return result.report;
            },
        });

        return { work: current, result };
    } finally {
        active = false;
    }
}

export function activateSkill(
    work: CombatWork,
    input: SkillActivationInput,
    resources: SkillExecutionResources,
): SkillTransition {
    const { unitId, tick, trigger = "MANUAL" } = input;
    assertNonnegativeSafeInteger(tick, "skill activation tick");
    const unit = getCombatUnit(work, unitId);
    const reject = (
        reason: Extract<SkillExecutionResult, { type: "REJECTED" }>["reason"],
    ): SkillTransition => ({
        work,
        result: { type: "REJECTED", reason },
        signals: [],
    });

    if (
        unit === undefined ||
        !hasSkill(unit) ||
        !isSpatiallyPresent(unit) ||
        (hasVitality(unit) && unit.vitality.hp <= 0) ||
        hasStatusFlag(unit, "STUNNED") ||
        hasStatusFlag(unit, "SILENCED")
    ) {
        return reject("UNAVAILABLE");
    }

    const compiled = resources.skills.get(unit.definition.skill);

    if (tick < unit.skill.lastAdvancedTick) {
        throw new RangeError("skill activation cannot precede its current tick");
    }
    if (unit.skill.active !== null) {
        return reject("ACTIVE");
    }
    if (compiled.definition.activation !== trigger) {
        return reject("WRONG_TRIGGER");
    }
    if (trigger === "PASSIVE" && unit.skill.nextActivationId > 0) {
        return reject("ALREADY_ACTIVATED");
    }

    const spent = spendSkillSp(unit.skill, compiled.definition);

    if (spent.result.type === "REJECTED") {
        return reject("INSUFFICIENT_SP");
    }

    const query = {
        unitId,
        tick,
        facts: skillFacts(() => work),
    };

    if (!(compiled.accepts?.(query) ?? true)) {
        return reject("CONDITION");
    }

    const nextActivationId = unit.skill.nextActivationId + 1;
    const endsAtTick =
        compiled.definition.durationTicks === null
            ? null
            : tick + compiled.definition.durationTicks;
    assertNonnegativeSafeInteger(nextActivationId, "skill activation allocation progress");

    if (endsAtTick !== null) {
        assertNonnegativeSafeInteger(endsAtTick, "skill ending tick");
    }

    const activation: SkillActivation = {
        id: unit.skill.nextActivationId,
        startedAtTick: tick,
        endsAtTick,
        ownedEffects: [],
        ...(compiled.definition.ammo === undefined
            ? {}
            : { remainingAmmo: compiled.definition.ammo }),
    };
    const reserved = saveState(work, unitId, {
        ...spent.state,
        lastAdvancedTick: tick,
        nextActivationId,
        active: activation,
    });
    const dispatch = new EffectDispatchScope();
    const invoked = withSkillContext(
        reserved,
        unitId,
        activation,
        resources,
        tick,
        compiled.activate,
        dispatch,
    );

    if (invoked.result.type === "REJECTED") {
        const rejectedUnit = getCombatUnit(invoked.work, unitId);
        const refunded =
            rejectedUnit !== undefined && hasSkill(rejectedUnit)
                ? saveState(invoked.work, unitId, {
                      ...rejectedUnit.skill,
                      sp: Math.min(
                          skillSpCapacity(compiled.definition),
                          rejectedUnit.skill.sp + compiled.definition.spCost,
                      ),
                      active: null,
                  })
                : invoked.work;

        return {
            work: refunded,
            result: { type: "REJECTED", reason: "CONTENT_REJECTED", detail: invoked.result.reason },
            signals: [],
        };
    }

    const current = getCombatUnit(invoked.work, unitId);
    let activated = invoked.work;

    if (current !== undefined && hasSkill(current) && current.skill.active?.id === activation.id) {
        activated = saveState(activated, unitId, {
            ...current.skill,
            active: { ...current.skill.active, ownedEffects: invoked.result.ownedEffects ?? [] },
        });
    } else {
        for (const address of invoked.result.ownedEffects ?? []) {
            activated = finishEffect(activated, address, resources, tick, dispatch);
        }

        return { work: activated, result: { type: "FINISHED" }, signals: [] };
    }

    const signal: SkillSignal = {
        type: "SKILL_ACTIVATED",
        unitId,
        skillId: compiled.definition.id,
        activationId: activation.id,
        tick,
        endsAtTick,
    };

    if (endsAtTick === tick) {
        const finished = finishSkill(activated, unitId, tick, resources, dispatch);

        return {
            ...finished,
            result: { type: "ACTIVATED" },
            signals: [signal, ...finished.signals],
        };
    }

    return { work: activated, result: { type: "ACTIVATED" }, signals: [signal] };
}

export interface SkillAmmoTransition {
    readonly work: CombatWork;
    readonly result: SkillAmmoResult;
    readonly signals: readonly SkillSignal[];
}

export function consumeSkillAmmo(
    work: CombatWork,
    unitId: UnitId,
    tick: number,
    resources: SkillExecutionResources,
): SkillAmmoTransition {
    assertNonnegativeSafeInteger(tick, "skill ammunition consumption tick");
    const unit = getCombatUnit(work, unitId);

    if (unit === undefined || !hasSkill(unit)) {
        return { work, result: { type: "REJECTED", reason: "INACTIVE" }, signals: [] };
    }

    const spent = spendSkillAmmo(unit.skill, unit.definition.skill.ammoPerAttack ?? 1);

    if (spent.result.type === "REJECTED") {
        return { work, result: spent.result, signals: [] };
    }

    work = saveState(work, unitId, spent.state);

    if (spent.result.remainingAmmo === 0) {
        const finished = finishSkill(work, unitId, tick, resources);

        return { work: finished.work, result: spent.result, signals: finished.signals };
    }

    return { work, result: spent.result, signals: [] };
}

export function finishSkill(
    work: CombatWork,
    unitId: UnitId,
    tick: number,
    resources: SkillExecutionResources,
    dispatch = new EffectDispatchScope(),
): SkillTransition {
    assertNonnegativeSafeInteger(tick, "skill finish tick");
    const unit = getCombatUnit(work, unitId);

    if (unit === undefined || !hasSkill(unit) || unit.skill.active === null) {
        return { work, result: { type: "ABSENT" }, signals: [] };
    }

    const compiled = resources.skills.get(unit.definition.skill);

    const { active } = unit.skill;
    work = saveState(work, unitId, { ...unit.skill, active: null, lastAdvancedTick: tick });

    for (const address of active.ownedEffects) {
        work = finishEffect(work, address, resources, tick, dispatch);
    }
    if (compiled.finish !== undefined) {
        work = withSkillContext(
            work,
            unitId,
            active,
            resources,
            tick,
            compiled.finish,
            dispatch,
        ).work;
    }

    return {
        work,
        result: { type: "FINISHED" },
        signals: [
            {
                type: "SKILL_FINISHED",
                unitId,
                skillId: compiled.definition.id,
                activationId: active.id,
                tick,
            },
        ],
    };
}

export function advanceSkill(
    work: CombatWork,
    unitId: UnitId,
    tick: number,
    resources: SkillExecutionResources,
): SkillTransition {
    assertNonnegativeSafeInteger(tick, "skill advancement tick");
    let unit = getCombatUnit(work, unitId);

    if (unit === undefined || !hasSkill(unit)) {
        return { work, result: { type: "ABSENT" }, signals: [] };
    }

    const compiled = resources.skills.get(unit.definition.skill);

    if (tick < unit.skill.lastAdvancedTick) {
        throw new RangeError("skill cannot advance to an earlier tick");
    }

    const signals: SkillSignal[] = [];
    const alreadyAdvanced = tick === unit.skill.lastAdvancedTick && unit.skill.nextActivationId > 0;
    const wasActive = unit.skill.active !== null;

    if (
        unit.skill.active?.endsAtTick !== undefined &&
        unit.skill.active.endsAtTick !== null &&
        tick >= unit.skill.active.endsAtTick
    ) {
        const finished = finishSkill(work, unitId, tick, resources);
        work = finished.work;
        signals.push(...finished.signals);
        unit = getCombatUnit(work, unitId);

        if (unit === undefined || !hasSkill(unit)) {
            return { work, result: { type: "FINISHED" }, signals };
        }
    }

    const state = unit.skill;
    let sp = state.sp;
    let spRecoveryProgressTicks = state.spRecoveryProgressTicks;
    const capacity = skillSpCapacity(compiled.definition);

    if (
        !wasActive &&
        isSpatiallyPresent(unit) &&
        (!hasVitality(unit) || unit.vitality.hp > 0) &&
        !hasStatusFlag(unit, "SP_RECOVERY_BLOCKED") &&
        compiled.definition.spRecovery === "TIME" &&
        sp < capacity
    ) {
        const interval = compiled.definition.spRecoveryIntervalTicks ?? TICKS_PER_SECOND;
        const progress = spRecoveryProgressTicks + tick - state.lastAdvancedTick;
        const pulses = Math.floor((progress + 1e-8) / interval);
        const gained = Math.min(pulses, capacity - sp);
        sp += gained;
        spRecoveryProgressTicks = sp === capacity ? 0 : Math.max(0, progress - gained * interval);
    }

    work = saveState(work, unitId, {
        ...state,
        sp,
        spRecoveryProgressTicks,
        lastAdvancedTick: tick,
    });

    if (compiled.definition.activation !== "MANUAL" && !alreadyAdvanced) {
        const attempted = activateSkill(
            work,
            { unitId, tick, trigger: compiled.definition.activation },
            resources,
        );
        work = attempted.work;
        signals.push(...attempted.signals);

        if (attempted.result.type === "ACTIVATED" || attempted.result.type === "FINISHED") {
            return { work, result: attempted.result, signals };
        }
    }

    return { work, result: { type: signals.length === 0 ? "ADVANCED" : "FINISHED" }, signals };
}
