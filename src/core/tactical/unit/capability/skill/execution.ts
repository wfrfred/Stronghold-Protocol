import { closeLifetime } from "../../../battle/execution/lifetime.js";
import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import {
    getUnit,
    battlefieldView,
    updateUnit,
    type BattleState,
    type Result,
} from "../../../battle/state.js";
import { emptyCall, type CallContext } from "../../../battle/execution/call.js";
import type { UnitId } from "../../unit.js";
import { TICKS_PER_SECOND } from "../../../tick.js";
import { isSpatiallyPresent } from "../presence.js";
import { hasStatusFlag } from "../status/capability.js";
import { hasVitality } from "../vitality/capability.js";
import {
    hasSkill,
    skillSpCapacity,
    type SkillActivation,
    type SkillActivationMode,
    type SkillState,
} from "./capability.js";
import type { CompiledSkill, SkillActivationContext } from "./compiled.js";
import { spendSkillSp } from "./sp.js";
import type { SkillResources } from "./resources.js";
import { spendSkillAmmo, type SkillAmmoResult } from "./ammo.js";

export interface SkillExecutionResources {
    readonly skills: SkillResources;
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

function saveState(state: BattleState, unitId: UnitId, skill: SkillState): BattleState {
    const unit = getUnit(state, unitId);

    return unit !== undefined && hasSkill(unit) && unit.skill !== skill
        ? updateUnit(state, { ...unit, skill })
        : state;
}

function skillContext(
    state: BattleState,
    unitId: UnitId,
    activation: SkillActivation,
    tick: number,
    call: CallContext,
): SkillActivationContext {
    return {
        unitId,
        tick,
        activationId: activation.id,
        endsAtTick: activation.endsAtTick,
        facts: battlefieldView(state),
        call,
    };
}

export function activateSkill(
    state: BattleState,
    input: SkillActivationInput,
    resources: SkillExecutionResources,
    call: CallContext = emptyCall,
): Result<SkillTransition> {
    const { unitId, tick, trigger = "MANUAL" } = input;
    assertNonnegativeSafeInteger(tick, "skill activation tick");
    const unit = getUnit(state, unitId);
    const reject = (
        reason: Extract<SkillExecutionResult, { type: "REJECTED" }>["reason"],
    ): Result<SkillTransition> => ({
        state,
        value: { result: { type: "REJECTED", reason }, signals: [] },
    });

    if (
        unit === undefined ||
        !hasSkill(unit) ||
        unit.lifecycle === "LEAVING" ||
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
        facts: battlefieldView(state),
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
    state = saveState(state, unitId, {
        ...spent.state,
        lastAdvancedTick: tick,
        nextActivationId,
        active: activation,
    });
    const invoked = compiled.activate(state, skillContext(state, unitId, activation, tick, call));
    state = invoked.state;

    if (invoked.value.type === "REJECTED") {
        const rejectedUnit = getUnit(state, unitId);

        if (
            rejectedUnit !== undefined &&
            hasSkill(rejectedUnit) &&
            rejectedUnit.skill.active?.id === activation.id
        ) {
            state = saveState(state, unitId, {
                ...rejectedUnit.skill,
                sp: Math.min(
                    skillSpCapacity(compiled.definition),
                    rejectedUnit.skill.sp + compiled.definition.spCost,
                ),
                active: null,
            });
        }

        state = closeLifetime(
            state,
            { type: "SKILL", unitId, activationId: activation.id },
            "SKILL_REJECTED",
            call,
        );

        return {
            state,
            value: {
                result: {
                    type: "REJECTED",
                    reason: "CONTENT_REJECTED",
                    detail: invoked.value.reason,
                },
                signals: [],
            },
        };
    }

    const current = getUnit(state, unitId);

    if (current === undefined || !hasSkill(current) || current.skill.active?.id !== activation.id) {
        state = closeLifetime(
            state,
            { type: "SKILL", unitId, activationId: activation.id },
            "SKILL_FINISHED",
            call,
        );

        return { state, value: { result: { type: "FINISHED" }, signals: [] } };
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
        const finished = finishSkill(state, unitId, tick, resources, call);

        return {
            state: finished.state,
            value: {
                result: { type: "ACTIVATED" },
                signals: [signal, ...finished.value.signals],
            },
        };
    }

    return { state, value: { result: { type: "ACTIVATED" }, signals: [signal] } };
}

export interface SkillAmmoTransition {
    readonly result: SkillAmmoResult;
    readonly signals: readonly SkillSignal[];
}

export function consumeSkillAmmo(
    state: BattleState,
    unitId: UnitId,
    tick: number,
    resources: SkillExecutionResources,
    call: CallContext = emptyCall,
): Result<SkillAmmoTransition> {
    assertNonnegativeSafeInteger(tick, "skill ammunition consumption tick");
    const unit = getUnit(state, unitId);

    if (unit === undefined || !hasSkill(unit)) {
        return { state, value: { result: { type: "REJECTED", reason: "INACTIVE" }, signals: [] } };
    }

    const spent = spendSkillAmmo(unit.skill, unit.definition.skill.ammoPerAttack ?? 1);

    if (spent.result.type === "REJECTED") {
        return { state, value: { result: spent.result, signals: [] } };
    }

    state = saveState(state, unitId, spent.state);

    if (spent.result.remainingAmmo === 0) {
        const finished = finishSkill(state, unitId, tick, resources, call);

        return {
            state: finished.state,
            value: { result: spent.result, signals: finished.value.signals },
        };
    }

    return { state, value: { result: spent.result, signals: [] } };
}

export function finishSkill(
    state: BattleState,
    unitId: UnitId,
    tick: number,
    resources: SkillExecutionResources,
    call: CallContext = emptyCall,
): Result<SkillTransition> {
    const stopped = stopSkillActivation(state, unitId, tick, resources);
    state = stopped.state;

    if (stopped.value === null) {
        return { state, value: { result: { type: "ABSENT" }, signals: [] } };
    }

    state = closeLifetime(
        state,
        { type: "SKILL", unitId, activationId: stopped.value.active.id },
        "SKILL_FINISHED",
        call,
    );

    return notifySkillFinished(state, stopped.value, tick, call);
}

export interface StoppedSkillActivation {
    readonly unitId: UnitId;
    readonly active: SkillActivation;
    readonly compiled: CompiledSkill;
}

export function stopSkillActivation(
    state: BattleState,
    unitId: UnitId,
    tick: number,
    resources: SkillExecutionResources,
): Result<StoppedSkillActivation | null> {
    assertNonnegativeSafeInteger(tick, "skill finish tick");
    const unit = getUnit(state, unitId);

    if (unit === undefined || !hasSkill(unit) || unit.skill.active === null) {
        return { state, value: null };
    }

    const compiled = resources.skills.get(unit.definition.skill);

    const { active } = unit.skill;
    state = saveState(state, unitId, { ...unit.skill, active: null, lastAdvancedTick: tick });

    return { state, value: { unitId, active, compiled } };
}

export function notifySkillFinished(
    state: BattleState,
    activation: StoppedSkillActivation,
    tick: number,
    call: CallContext = emptyCall,
): Result<SkillTransition> {
    const { unitId, active, compiled } = activation;

    if (compiled.finish !== undefined) {
        state = compiled.finish(state, skillContext(state, unitId, active, tick, call));
    }

    return {
        state,
        value: {
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
        },
    };
}

export function advanceSkill(
    state: BattleState,
    unitId: UnitId,
    tick: number,
    resources: SkillExecutionResources,
    call: CallContext = emptyCall,
): Result<SkillTransition> {
    assertNonnegativeSafeInteger(tick, "skill advancement tick");
    let unit = getUnit(state, unitId);

    if (unit === undefined || !hasSkill(unit)) {
        return { state, value: { result: { type: "ABSENT" }, signals: [] } };
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
        const finished = finishSkill(state, unitId, tick, resources, call);
        state = finished.state;
        signals.push(...finished.value.signals);
        unit = getUnit(state, unitId);

        if (unit === undefined || !hasSkill(unit)) {
            return { state, value: { result: { type: "FINISHED" }, signals } };
        }
    }

    const skill = unit.skill;
    let sp = skill.sp;
    let spRecoveryProgressTicks = skill.spRecoveryProgressTicks;
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
        const progress = spRecoveryProgressTicks + tick - skill.lastAdvancedTick;
        const pulses = Math.floor((progress + 1e-8) / interval);
        const gained = Math.min(pulses, capacity - sp);
        sp += gained;
        spRecoveryProgressTicks = sp === capacity ? 0 : Math.max(0, progress - gained * interval);
    }

    state = saveState(state, unitId, {
        ...skill,
        sp,
        spRecoveryProgressTicks,
        lastAdvancedTick: tick,
    });

    if (compiled.definition.activation !== "MANUAL" && !alreadyAdvanced) {
        const attempted = activateSkill(
            state,
            { unitId, tick, trigger: compiled.definition.activation },
            resources,
            call,
        );
        state = attempted.state;
        signals.push(...attempted.value.signals);

        if (
            attempted.value.result.type === "ACTIVATED" ||
            attempted.value.result.type === "FINISHED"
        ) {
            return { state, value: { result: attempted.value.result, signals } };
        }
    }

    return {
        state,
        value: { result: { type: signals.length === 0 ? "ADVANCED" : "FINISHED" }, signals },
    };
}
