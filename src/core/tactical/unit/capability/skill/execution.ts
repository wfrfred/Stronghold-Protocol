import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import {
    getUnit,
    battlefieldView,
    updateUnit,
    type BattleState,
} from "../../../battle/execution/context.js";
import type { UnitId } from "../../unit.js";
import { TICKS_PER_SECOND } from "../../../tick.js";
import type { EffectTransitionResources } from "../effects/contract.js";
import { EffectDispatchScope } from "../effects/dispatch.js";
import { closeEffectLifetimes } from "../effects/lifecycle.js";
import { createEffectOperations } from "../effects/operations.js";
import { isSpatiallyPresent } from "../presence.js";
import { hasStatusFlag } from "../status/capability.js";
import { hasVitality } from "../vitality/capability.js";
import type { DamageOperation } from "../vitality/damage/contract.js";
import type { HealingOperation } from "../vitality/healing/contract.js";
import {
    hasSkill,
    skillSpCapacity,
    type SkillActivation,
    type SkillActivationMode,
    type SkillState,
} from "./capability.js";
import type { CompiledSkill, SkillActivationContext, SkillFacts } from "./compiled.js";
import { spendSkillSp } from "./sp.js";
import type { SkillResources } from "./resources.js";
import { spendSkillAmmo, type SkillAmmoResult } from "./ammo.js";

export interface SkillExecutionResources extends EffectTransitionResources {
    readonly skills: SkillResources;
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
}

function skillFacts(readWork: () => BattleState): SkillFacts {
    return {
        get unitIds() {
            return battlefieldView(readWork()).unitIds;
        },
        getUnit: (id) => getUnit(readWork(), id),
        blockerOf: (id) => battlefieldView(readWork()).blockerOf(id),
        blockedBy: (id) => battlefieldView(readWork()).blockedBy(id),
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
    readonly result: SkillExecutionResult;
    readonly signals: readonly SkillSignal[];
}

function saveState(work: BattleState, unitId: UnitId, state: SkillState): void {
    const unit = getUnit(work, unitId);

    if (unit !== undefined && hasSkill(unit) && unit.skill !== state) {
        updateUnit(work, { ...unit, skill: state });
    }
}

function withSkillContext<R>(
    work: BattleState,
    unitId: UnitId,
    activation: SkillActivation,
    resources: SkillExecutionResources,
    tick: number,
    run: (context: SkillActivationContext) => R,
    dispatch = new EffectDispatchScope(),
): R {
    let active = true;

    const readWork = () => {
        if (!active) {
            throw new TypeError("skill context is no longer active");
        }

        return work;
    };

    try {
        return run({
            unitId,
            tick,
            activationId: activation.id,
            endsAtTick: activation.endsAtTick,
            facts: skillFacts(readWork),
            effects: createEffectOperations(readWork, resources, tick, dispatch),
            damage: (request) => {
                return resources.settleDamage(readWork(), { ...request, tick }, dispatch);
            },
            heal: (request) => {
                return resources.settleHealing(readWork(), { ...request, tick }, dispatch);
            },
        });
    } finally {
        active = false;
    }
}

export function activateSkill(
    work: BattleState,
    input: SkillActivationInput,
    resources: SkillExecutionResources,
    dispatch = new EffectDispatchScope(),
): SkillTransition {
    const { unitId, tick, trigger = "MANUAL" } = input;
    assertNonnegativeSafeInteger(tick, "skill activation tick");
    const unit = getUnit(work, unitId);
    const reject = (
        reason: Extract<SkillExecutionResult, { type: "REJECTED" }>["reason"],
    ): SkillTransition => ({
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
        ...(compiled.definition.ammo === undefined
            ? {}
            : { remainingAmmo: compiled.definition.ammo }),
    };
    saveState(work, unitId, {
        ...spent.state,
        lastAdvancedTick: tick,
        nextActivationId,
        active: activation,
    });
    const invoked = withSkillContext(
        work,
        unitId,
        activation,
        resources,
        tick,
        compiled.activate,
        dispatch,
    );

    if (invoked.type === "REJECTED") {
        const rejectedUnit = getUnit(work, unitId);

        if (
            rejectedUnit !== undefined &&
            hasSkill(rejectedUnit) &&
            rejectedUnit.skill.active?.id === activation.id
        ) {
            saveState(work, unitId, {
                ...rejectedUnit.skill,
                sp: Math.min(
                    skillSpCapacity(compiled.definition),
                    rejectedUnit.skill.sp + compiled.definition.spCost,
                ),
                active: null,
            });
        }

        closeEffectLifetimes(
            work,
            [{ type: "SKILL", unitId, activationId: activation.id }],
            resources,
            tick,
            "SKILL_REJECTED",
            dispatch,
        );

        return {
            result: { type: "REJECTED", reason: "CONTENT_REJECTED", detail: invoked.reason },
            signals: [],
        };
    }

    const current = getUnit(work, unitId);

    if (current === undefined || !hasSkill(current) || current.skill.active?.id !== activation.id) {
        closeEffectLifetimes(
            work,
            [{ type: "SKILL", unitId, activationId: activation.id }],
            resources,
            tick,
            "SKILL_FINISHED",
            dispatch,
        );

        return {
            result: { type: "FINISHED" },
            signals: [],
        };
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
        const finished = finishSkill(work, unitId, tick, resources, dispatch);

        return {
            ...finished,
            result: { type: "ACTIVATED" },
            signals: [signal, ...finished.signals],
        };
    }

    return { result: { type: "ACTIVATED" }, signals: [signal] };
}

export interface SkillAmmoTransition {
    readonly result: SkillAmmoResult;
    readonly signals: readonly SkillSignal[];
}

export function consumeSkillAmmo(
    work: BattleState,
    unitId: UnitId,
    tick: number,
    resources: SkillExecutionResources,
    dispatch = new EffectDispatchScope(),
): SkillAmmoTransition {
    assertNonnegativeSafeInteger(tick, "skill ammunition consumption tick");
    const unit = getUnit(work, unitId);

    if (unit === undefined || !hasSkill(unit)) {
        return { result: { type: "REJECTED", reason: "INACTIVE" }, signals: [] };
    }

    const spent = spendSkillAmmo(unit.skill, unit.definition.skill.ammoPerAttack ?? 1);

    if (spent.result.type === "REJECTED") {
        return { result: spent.result, signals: [] };
    }

    saveState(work, unitId, spent.state);

    if (spent.result.remainingAmmo === 0) {
        const finished = finishSkill(work, unitId, tick, resources, dispatch);

        return { result: spent.result, signals: finished.signals };
    }

    return { result: spent.result, signals: [] };
}

export function finishSkill(
    work: BattleState,
    unitId: UnitId,
    tick: number,
    resources: SkillExecutionResources,
    dispatch = new EffectDispatchScope(),
): SkillTransition {
    const stopped = stopSkillActivation(work, unitId, tick, resources);

    if (stopped === null) {
        return { result: { type: "ABSENT" }, signals: [] };
    }

    closeEffectLifetimes(
        work,
        [{ type: "SKILL", unitId, activationId: stopped.active.id }],
        resources,
        tick,
        "SKILL_FINISHED",
        dispatch,
    );

    return notifySkillFinished(work, stopped, tick, resources, dispatch);
}

export interface StoppedSkillActivation {
    readonly unitId: UnitId;
    readonly active: SkillActivation;
    readonly compiled: CompiledSkill;
}

export function stopSkillActivation(
    work: BattleState,
    unitId: UnitId,
    tick: number,
    resources: SkillExecutionResources,
): StoppedSkillActivation | null {
    assertNonnegativeSafeInteger(tick, "skill finish tick");
    const unit = getUnit(work, unitId);

    if (unit === undefined || !hasSkill(unit) || unit.skill.active === null) {
        return null;
    }

    const compiled = resources.skills.get(unit.definition.skill);

    const { active } = unit.skill;
    saveState(work, unitId, { ...unit.skill, active: null, lastAdvancedTick: tick });

    return { unitId, active, compiled };
}

export function notifySkillFinished(
    work: BattleState,
    activation: StoppedSkillActivation,
    tick: number,
    resources: SkillExecutionResources,
    dispatch = new EffectDispatchScope(),
): SkillTransition {
    const { unitId, active, compiled } = activation;

    if (compiled.finish !== undefined) {
        withSkillContext(work, unitId, active, resources, tick, compiled.finish, dispatch);
    }

    return {
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
    work: BattleState,
    unitId: UnitId,
    tick: number,
    resources: SkillExecutionResources,
    dispatch = new EffectDispatchScope(),
): SkillTransition {
    assertNonnegativeSafeInteger(tick, "skill advancement tick");
    let unit = getUnit(work, unitId);

    if (unit === undefined || !hasSkill(unit)) {
        return { result: { type: "ABSENT" }, signals: [] };
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
        const finished = finishSkill(work, unitId, tick, resources, dispatch);
        signals.push(...finished.signals);
        unit = getUnit(work, unitId);

        if (unit === undefined || !hasSkill(unit)) {
            return { result: { type: "FINISHED" }, signals };
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

    saveState(work, unitId, {
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
            dispatch,
        );
        signals.push(...attempted.signals);

        if (attempted.result.type === "ACTIVATED" || attempted.result.type === "FINISHED") {
            return { result: attempted.result, signals };
        }
    }

    return { result: { type: signals.length === 0 ? "ADVANCED" : "FINISHED" }, signals };
}
