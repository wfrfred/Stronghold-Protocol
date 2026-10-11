import { ActionExecutionWork } from "./internal/executions.js";
import { startActionInWork } from "./internal/execution.js";
import type { BattleState } from "../../../battle/execution/context.js";
import type { UnitId } from "../../unit.js";
import type { CompiledAction } from "./compiled.js";
import type { ActionExecutionState, ActionExecutionResources } from "./process.js";

export interface ActionStartRequest {
    readonly sourceUnitId: UnitId;
    readonly compiled: CompiledAction;
    readonly tick: number;
    readonly mayStart: boolean;
}

export type ActionStartResources = ActionExecutionResources;

export function startAction(
    work: BattleState,
    state: ActionExecutionState,
    request: ActionStartRequest,
    resources: ActionStartResources,
): ActionExecutionState {
    const executions = new ActionExecutionWork(state);
    startActionInWork(work, executions, request, resources);

    return executions.result();
}
