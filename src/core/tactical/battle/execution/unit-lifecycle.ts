import { closeLifetime } from "./lifetime.js";
import type { Id } from "../../unit/unit.js";
import type { BattlefieldRemovalReason } from "../../battlefield/contract.js";
import type { StoppedSkillActivation } from "../../unit/capability/skill/execution.js";
import type { ActionExecutionSignal } from "../../unit/capability/action/process.js";
import {
    appendEvents,
    getMechanism,
    getUnit,
    removeUnit,
    updateUnit,
    type State as BattleState,
    type Result,
} from "../state.js";
import { emptyCall, type CallContext } from "./call.js";
import {
    getActionExecution,
    removeActionExecution,
} from "../../unit/capability/action/internal/executions.js";
import { refundUnit, recycleUnitCard } from "../deployment/deployment.js";

export interface UnitLifecycleResources {
    readonly stopSkillActivation: (
        state: BattleState,
        unitId: Id,
        tick: number,
    ) => Result<StoppedSkillActivation | null>;
    readonly notifySkillFinished: (
        state: BattleState,
        activation: StoppedSkillActivation,
        tick: number,
        call?: CallContext,
    ) => BattleState;
}

export function enterUnits(state: BattleState, unitIds: readonly Id[]): BattleState {
    for (const unitId of unitIds) {
        const unit = getUnit(state, unitId);

        if (unit?.lifecycle === "PRESENT" && unit.definition.onEnter !== undefined) {
            state = unit.definition.onEnter(state, unitId);
        }
    }

    return state;
}

export function advanceUnits(state: BattleState): BattleState {
    const unitIds = [...state.battlefield.units.keys()];

    for (const unitId of unitIds) {
        const unit = getUnit(state, unitId);

        if (unit?.lifecycle === "PRESENT" && unit.definition.onTick !== undefined) {
            state = unit.definition.onTick(state, unitId);
        }
    }

    return state;
}

export function retireCombatUnit(
    state: BattleState,
    unitId: Id,
    resources: UnitLifecycleResources,
    tick: number,
    call: CallContext = emptyCall,
): BattleState {
    return removeUnitWithEffects(state, unitId, "DEATH", resources, tick, call);
}

export function removeUnitWithEffects(
    state: BattleState,
    unitId: Id,
    reason: BattlefieldRemovalReason,
    resources: UnitLifecycleResources,
    tick: number,
    call: CallContext = emptyCall,
): BattleState {
    const lifetime = { type: "UNIT" as const, unitId };
    const unit = getUnit(state, unitId);

    if (unit === undefined || unit.lifecycle === "LEAVING") {
        return state;
    }

    state = updateUnit(state, { ...unit, lifecycle: "LEAVING" });
    state = refundUnit(state, unit, reason, tick);
    const actions = state.actionExecutions.executions.filter(
        (action) => action.sourceUnitId === unitId,
    );
    const stopped = resources.stopSkillActivation(state, unitId, tick);
    state = stopped.state;
    const signals: ActionExecutionSignal[] = [];

    for (const action of actions) {
        if (getActionExecution(state.actionExecutions, action.id) === undefined) {
            continue;
        }

        state = {
            ...state,
            actionExecutions: removeActionExecution(state.actionExecutions, action.id),
        };
        state = closeLifetime(state, { type: "ACTION", executionId: action.id }, reason, call);
        signals.push({
            type: "ACTION_CANCELLED",
            executionId: action.id,
            sourceUnitId: unitId,
            tick,
            reason: "SOURCE_ABSENT",
        });
    }
    if (stopped.value !== null) {
        state = closeLifetime(
            state,
            { type: "SKILL", unitId, activationId: stopped.value.active.id },
            reason,
            call,
        );
    }

    state = closeLifetime(state, lifetime, reason, call);

    if (stopped.value !== null) {
        state = resources.notifySkillFinished(state, stopped.value, tick, call);
    }

    state = appendEvents(state, signals);
    state = removeUnit(state, unitId, reason);
    state = recycleUnitCard(state, unit, reason, tick);
    const departure = { unit, reason };

    if (unit.definition.onLeave !== undefined) {
        state = unit.definition.onLeave(state, departure);
    }

    const mechanismIds = [...state.battlefield.mechanisms.keys()];

    for (const mechanismId of mechanismIds) {
        const mechanism = getMechanism(state, mechanismId);

        if (mechanism?.active && mechanism.definition.onUnitLeave !== undefined) {
            state = mechanism.definition.onUnitLeave(state, mechanismId, departure);
        }
    }

    return state;
}
