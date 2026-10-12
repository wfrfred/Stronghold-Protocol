import type { ActionExecution, ActionExecutionId, ActionExecutionState } from "../process.js";

export function getActionExecution(
    state: ActionExecutionState,
    id: ActionExecutionId,
): ActionExecution | undefined {
    return state.executions.find((execution) => execution.id === id);
}

export function replaceActionExecution(
    state: ActionExecutionState,
    execution: ActionExecution,
): ActionExecutionState {
    const index = state.executions.findIndex((current) => current.id === execution.id);

    return index < 0 || state.executions[index] === execution
        ? state
        : {
              ...state,
              executions: [
                  ...state.executions.slice(0, index),
                  execution,
                  ...state.executions.slice(index + 1),
              ],
          };
}

export function removeActionExecution(
    state: ActionExecutionState,
    id: ActionExecutionId,
): ActionExecutionState {
    return getActionExecution(state, id) === undefined
        ? state
        : { ...state, executions: state.executions.filter((execution) => execution.id !== id) };
}
