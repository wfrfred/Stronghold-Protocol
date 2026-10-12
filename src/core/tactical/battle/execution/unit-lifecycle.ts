import { endScope } from "../../unit/effect/operations.js";
import type { UnitId } from "../../unit/unit.js";
import type { BattlefieldRemovalReason } from "../../battlefield/contract.js";
import type { StoppedSkillActivation } from "../../unit/capability/skill/execution.js";
import type { ActionExecutionSignal } from "../../unit/capability/action/process.js";
import {
    appendEvents,
    getUnit,
    removeUnit,
    updateUnit,
    type BattleState,
    type Result,
} from "../state.js";
import { emptyCall, type CallContext } from "./call.js";
import {
    getActionExecution,
    removeActionExecution,
} from "../../unit/capability/action/internal/executions.js";

export interface UnitLifecycleResources {
    readonly stopSkillActivation: (
        state: BattleState,
        unitId: UnitId,
        tick: number,
    ) => Result<StoppedSkillActivation | null>;
    readonly notifySkillFinished: (
        state: BattleState,
        activation: StoppedSkillActivation,
        tick: number,
        call?: CallContext,
    ) => BattleState;
}

export function retireCombatUnit(
    state: BattleState,
    unitId: UnitId,
    resources: UnitLifecycleResources,
    tick: number,
    call: CallContext = emptyCall,
): BattleState {
    return removeUnitWithEffects(state, unitId, "DEATH", resources, tick, call);
}

export function removeUnitWithEffects(
    state: BattleState,
    unitId: UnitId,
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
        state = endScope(state, { type: "ACTION", executionId: action.id }, reason, call);
        signals.push({
            type: "ACTION_CANCELLED",
            executionId: action.id,
            sourceUnitId: unitId,
            tick,
            reason: "SOURCE_ABSENT",
        });
    }
    if (stopped.value !== null) {
        state = endScope(
            state,
            { type: "SKILL", unitId, activationId: stopped.value.active.id },
            reason,
            call,
        );
    }

    state = endScope(state, lifetime, reason, call);

    if (stopped.value !== null) {
        state = resources.notifySkillFinished(state, stopped.value, tick, call);
    }

    state = appendEvents(state, signals);

    return removeUnit(state, unitId, reason);
}
