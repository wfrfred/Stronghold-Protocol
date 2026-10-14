import {
    appendEvents,
    battlefieldView,
    getUnit,
    updateUnit,
    type BattleState,
} from "../../../battle/state.js";
import { emptyCall, type CallContext } from "../../../battle/execution/call.js";
import { canAct, hasAction } from "./capability.js";
import {
    acceptActionExecution,
    resumeActionExecution,
    type ActionExecutionResources,
} from "./process.js";
import { isSpatiallyPresent } from "../presence/capability.js";
import {
    beginActionCooldown,
    reconcileActionCooldown,
    resolveActionIntervalTicks,
} from "./timing.js";

import type { Id } from "../../unit.js";
import type { CompiledAction } from "./compiled.js";

export interface ActionStartRequest {
    readonly sourceUnitId: Id;
    readonly compiled: CompiledAction;
    readonly tick: number;
    readonly mayStart: boolean;
}

export type ActionStartResources = ActionExecutionResources;

export function startAction(
    state: BattleState,
    request: ActionStartRequest,
    resources: ActionStartResources,
    call: CallContext = emptyCall,
): BattleState {
    const { sourceUnitId, compiled, tick, mayStart } = request;
    const source = getUnit(state, sourceUnitId);

    if (
        source === undefined ||
        source.lifecycle === "LEAVING" ||
        !hasAction(source) ||
        !isSpatiallyPresent(source) ||
        !canAct(source)
    ) {
        return state;
    }

    const intervalTicks = resolveActionIntervalTicks(
        compiled.definition,
        source.definition.action,
        source.action,
        { unit: source, battlefield: battlefieldView(state) },
    );
    const action = reconcileActionCooldown(source.action, intervalTicks, tick);
    const ready = action === source.action ? source : { ...source, action };
    state = updateUnit(state, ready);

    if (!mayStart || tick < action.readyAtTick || tick < action.recoveryUntilTick) {
        return state;
    }

    const bindings = compiled.bind({ source: ready, battlefield: battlefieldView(state) });
    const targetUnitId = bindings.get(compiled.definition.triggerBindingId)![0] ?? null;

    if (targetUnitId === null) {
        return state;
    }

    const { definition } = compiled;
    state = updateUnit(state, {
        ...ready,
        action: beginActionCooldown(action, definition, intervalTicks, tick),
    });
    state = appendEvents(state, [{ type: "ACTION", sourceUnitId, targetUnitId, tick }]);
    const initialized = acceptActionExecution(state.actionExecutions, {
        sourceUnitId,
        definition,
        inputTargetUnitId: targetUnitId,
        bindings,
        tick,
    });
    state = { ...state, actionExecutions: initialized.state };

    return resumeActionExecution(
        state,
        { executionId: initialized.execution.id, segments: compiled.program, tick },
        resources,
        call,
    ).state;
}
