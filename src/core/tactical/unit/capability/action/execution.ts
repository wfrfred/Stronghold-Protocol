import { ActionExecutionWork } from "./internal/executions.js";
import { startActionInWork } from "./internal/execution.js";
import type { CombatWork } from "../../../battle/execution/work.js";
import type { UnitId } from "../../unit.js";
import type { CompiledAction } from "./program.js";
import type { ActionExecutionState, ActionExecutionResources } from "./process.js";
import type { ActionResources } from "./resources.js";

export interface ActionStartRequest {
    readonly sourceUnitId: UnitId;
    readonly compiled: CompiledAction;
    readonly tick: number;
    readonly mayStart: boolean;
}

export type ActionStartResources = ActionExecutionResources & Pick<ActionResources, "computations">;

export function startAction(
    work: CombatWork,
    state: ActionExecutionState,
    request: ActionStartRequest,
    resources: ActionStartResources,
): { readonly work: CombatWork; readonly state: ActionExecutionState } {
    const executions = new ActionExecutionWork(state);
    const next = startActionInWork(work, executions, request, resources);

    return { work: next, state: executions.result() };
}
