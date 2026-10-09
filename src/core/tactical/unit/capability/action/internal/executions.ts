import type { UnitId } from "../../../unit.js";
import type { ActionExecution, ActionExecutionId, ActionExecutionState } from "../process.js";

const indexes = new WeakMap<
    ActionExecutionState,
    ReadonlyMap<UnitId, readonly ActionExecution[]>
>();

export function actionExecutionsBySource(
    state: ActionExecutionState,
): ReadonlyMap<UnitId, readonly ActionExecution[]> {
    let index = indexes.get(state);

    if (index === undefined) {
        const grouped = new Map<UnitId, ActionExecution[]>();

        for (const execution of state.executions) {
            const group = grouped.get(execution.sourceUnitId);

            if (group === undefined) {
                grouped.set(execution.sourceUnitId, [execution]);
            } else {
                group.push(execution);
            }
        }

        index = grouped;
        indexes.set(state, index);
    }

    return index;
}

export class ActionExecutionWork {
    readonly #executions = new Map<ActionExecutionId, ActionExecution>();
    readonly #sources = new Map<UnitId, Set<ActionExecutionId>>();
    #nextExecutionId: ActionExecutionId;
    #result: ActionExecutionState | undefined;

    constructor(state: ActionExecutionState) {
        this.#nextExecutionId = state.nextExecutionId;
        this.#result = state;

        for (const execution of state.executions) {
            this.#executions.set(execution.id, execution);
            const ids = this.#sources.get(execution.sourceUnitId);

            if (ids === undefined) {
                this.#sources.set(execution.sourceUnitId, new Set([execution.id]));
            } else {
                ids.add(execution.id);
            }
        }
    }

    get nextExecutionId(): ActionExecutionId {
        return this.#nextExecutionId;
    }

    get(id: ActionExecutionId): ActionExecution | undefined {
        return this.#executions.get(id);
    }

    forSource(unitId: UnitId): readonly ActionExecution[] {
        const executions: ActionExecution[] = [];

        for (const id of this.#sources.get(unitId) ?? []) {
            executions.push(this.#executions.get(id)!);
        }

        return executions;
    }

    add(execution: ActionExecution): void {
        this.#nextExecutionId = execution.id + 1;
        this.#executions.set(execution.id, execution);
        const ids = this.#sources.get(execution.sourceUnitId);

        if (ids === undefined) {
            this.#sources.set(execution.sourceUnitId, new Set([execution.id]));
        } else {
            ids.add(execution.id);
        }

        this.#result = undefined;
    }

    replace(execution: ActionExecution): void {
        if (
            !this.#executions.has(execution.id) ||
            this.#executions.get(execution.id) === execution
        ) {
            return;
        }

        this.#executions.set(execution.id, execution);
        this.#result = undefined;
    }

    remove(execution: ActionExecution): void {
        this.#executions.delete(execution.id);
        this.#sources.get(execution.sourceUnitId)?.delete(execution.id);
        this.#result = undefined;
    }

    result(): ActionExecutionState {
        this.#result ??= Object.freeze({
            nextExecutionId: this.#nextExecutionId,
            executions: Object.freeze([...this.#executions.values()]),
        });

        return this.#result;
    }
}
