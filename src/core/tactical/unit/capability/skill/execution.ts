import { closeLifetime } from "../../../battle/execution/lifetime.js";
import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import {
    getUnit,
    battlefieldView,
    updateUnit,
    appendEvents,
    type State as BattleState,
    type Result,
} from "../../../battle/state.js";
import { emptyCall, type CallContext } from "../../../battle/execution/call.js";
import type { Id } from "../../unit.js";
import { TICKS_PER_SECOND } from "../../../tick.js";
import { isSpatiallyPresent } from "../presence/capability.js";
import { hasVitality } from "../vitality/capability.js";
import {
    hasSkill,
    canActivate,
    canGainSp,
    skillSpCapacity,
    type SkillActivation,
    type SkillActivationMode,
    type State,
} from "./capability.js";
import type { CompiledSkill, SkillActivationContext } from "./compiled.js";
import { spendSkillSp } from "./sp.js";
import type { SkillResources } from "./resources.js";
import { spendSkillAmmo, type SkillAmmoResult } from "./ammo.js";

export interface SkillExecutionResources {
    readonly skills: SkillResources;
}

export interface SkillActivationInput {
    readonly unitId: Id;
    readonly tick: number;
    readonly trigger?: SkillActivationMode;
}

export type SkillSignal = {
    readonly unitId: Id;
    readonly skillId: string;
    readonly activationId: number;
    readonly tick: number;
} & (
    | { readonly type: "SKILL_ACTIVATED"; readonly endsAtTick: number | null }
    | { readonly type: "SKILL_FINISHED" }
);

export type SkillExecutionResult =
    | { readonly type: "ACTIVATED" | "FINISHED" }
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

function saveState(state: BattleState, unitId: Id, skill: State): BattleState {
    const unit = getUnit(state, unitId);

    return unit !== undefined && hasSkill(unit) && unit.skill !== skill
        ? updateUnit(state, { ...unit, skill })
        : state;
}

function skillContext(
    state: BattleState,
    unitId: Id,
    activation: SkillActivation,
    tick: number,
    call: CallContext,
): SkillActivationContext {
    return {
        unitId,
        tick,
        activationId: activation.id,
        endsAtTick: activation.endsAtTick,
        battlefield: battlefieldView(state),
        call,
    };
}

export function activateSkill(
    state: BattleState,
    input: SkillActivationInput,
    resources: SkillExecutionResources,
    call: CallContext = emptyCall,
): Result<SkillExecutionResult> {
    const { unitId, tick, trigger = "MANUAL" } = input;
    assertNonnegativeSafeInteger(tick, "skill activation tick");
    const unit = getUnit(state, unitId);
    const reject = (
        reason: Extract<SkillExecutionResult, { type: "REJECTED" }>["reason"],
    ): Result<SkillExecutionResult> => ({
        state,
        value: { type: "REJECTED", reason },
    });

    if (
        unit === undefined ||
        !hasSkill(unit) ||
        unit.lifecycle === "LEAVING" ||
        !isSpatiallyPresent(unit) ||
        (hasVitality(unit) && unit.vitality.hp <= 0) ||
        !canActivate(unit)
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
        battlefield: battlefieldView(state),
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
                type: "REJECTED",
                reason: "CONTENT_REJECTED",
                detail: invoked.value.reason,
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

        return { state, value: { type: "FINISHED" } };
    }

    const signal: SkillSignal = {
        type: "SKILL_ACTIVATED",
        unitId,
        skillId: compiled.definition.id,
        activationId: activation.id,
        tick,
        endsAtTick,
    };
    state = appendEvents(state, [signal]);

    if (endsAtTick === tick) {
        state = finishSkill(state, unitId, tick, resources, call);
    }

    return { state, value: { type: "ACTIVATED" } };
}

export function consumeSkillAmmo(
    state: BattleState,
    unitId: Id,
    tick: number,
    resources: SkillExecutionResources,
    call: CallContext = emptyCall,
): Result<SkillAmmoResult> {
    assertNonnegativeSafeInteger(tick, "skill ammunition consumption tick");
    const unit = getUnit(state, unitId);

    if (unit === undefined || !hasSkill(unit)) {
        return { state, value: { type: "REJECTED", reason: "INACTIVE" } };
    }

    const spent = spendSkillAmmo(unit.skill, unit.definition.skill.ammoPerAttack ?? 1);

    if (spent.result.type === "REJECTED") {
        return { state, value: spent.result };
    }

    state = saveState(state, unitId, spent.state);

    if (spent.result.remainingAmmo === 0) {
        state = finishSkill(state, unitId, tick, resources, call);
    }

    return { state, value: spent.result };
}

export function finishSkill(
    state: BattleState,
    unitId: Id,
    tick: number,
    resources: SkillExecutionResources,
    call: CallContext = emptyCall,
): BattleState {
    const stopped = stopSkillActivation(state, unitId, tick, resources);
    state = stopped.state;

    if (stopped.value === null) {
        return state;
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
    readonly unitId: Id;
    readonly active: SkillActivation;
    readonly compiled: CompiledSkill;
}

export function stopSkillActivation(
    state: BattleState,
    unitId: Id,
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
): BattleState {
    const { unitId, active, compiled } = activation;

    if (compiled.finish !== undefined) {
        state = compiled.finish(state, skillContext(state, unitId, active, tick, call));
    }

    return appendEvents(state, [
        {
            type: "SKILL_FINISHED",
            unitId,
            skillId: compiled.definition.id,
            activationId: active.id,
            tick,
        },
    ]);
}

export function advanceSkill(
    state: BattleState,
    unitId: Id,
    tick: number,
    resources: SkillExecutionResources,
    call: CallContext = emptyCall,
): BattleState {
    assertNonnegativeSafeInteger(tick, "skill advancement tick");
    let unit = getUnit(state, unitId);

    if (unit === undefined || !hasSkill(unit)) {
        return state;
    }

    const compiled = resources.skills.get(unit.definition.skill);

    if (tick < unit.skill.lastAdvancedTick) {
        throw new RangeError("skill cannot advance to an earlier tick");
    }

    const alreadyAdvanced = tick === unit.skill.lastAdvancedTick && unit.skill.nextActivationId > 0;
    const wasActive = unit.skill.active !== null;

    if (
        unit.skill.active?.endsAtTick !== undefined &&
        unit.skill.active.endsAtTick !== null &&
        tick >= unit.skill.active.endsAtTick
    ) {
        state = finishSkill(state, unitId, tick, resources, call);
        unit = getUnit(state, unitId);

        if (unit === undefined || !hasSkill(unit)) {
            return state;
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
        canGainSp(unit) &&
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
        state = activateSkill(
            state,
            { unitId, tick, trigger: compiled.definition.activation },
            resources,
            call,
        ).state;
    }

    return state;
}
