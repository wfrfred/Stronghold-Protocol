import { closeLifetime } from "../../../../battle/execution/lifetime.js";
import { getActionExecution, removeActionExecution, replaceActionExecution } from "./executions.js";
import { assertFiniteNumber, assertNonnegativeSafeInteger } from "../../../../../common/assert.js";
import { appendEvents, getUnit, type BattleState, type Result } from "../../../../battle/state.js";
import { emptyCall, type CallContext } from "../../../../battle/execution/call.js";
import type { UnitId } from "../../../unit.js";
import { isSpatiallyPresent } from "../../presence.js";
import type { TargetBindingId } from "../capability.js";
import type { ProjectileOperations } from "../../../../battlefield/projectile/operations.js";
import { gainUnitSkillSp } from "../../../../battle/execution/skill-sp.js";
import { hasStatusFlag } from "../../status/capability.js";
import { beforeActionRelease } from "../release.js";
import type {
    ActionExecution,
    ActionExecutionBindings,
    ActionExecutionCancelRequest,
    ActionExecutionContext,
    ActionExecutionInput,
    ActionExecutionResources,
    ActionExecutionStepResult,
    ActionExecutionResumeRequest,
    ActionExecutionSamples,
    ActionExecutionSignal,
    ActionExecutionState,
    ActionExecutionOutcome,
    ActionExecutionWait,
    ActionExecutionWaitRequest,
    CompiledActionSegment,
} from "../process.js";

function targetBindings(
    bindings: ReadonlyMap<TargetBindingId, readonly UnitId[]>,
): ActionExecutionBindings {
    return Object.fromEntries(bindings);
}

function validateSamples(samples: ActionExecutionSamples): ActionExecutionSamples {
    for (const [name, value] of Object.entries(samples)) {
        assertFiniteNumber(value, `action sample ${name}`);
    }

    return samples;
}

export function accept(
    state: ActionExecutionState,
    input: ActionExecutionInput,
): {
    readonly state: ActionExecutionState;
    readonly execution: ActionExecution;
} {
    const nextExecutionId = state.nextExecutionId + 1;

    if (!Number.isSafeInteger(nextExecutionId)) {
        throw new RangeError("action execution identity overflow");
    }

    assertNonnegativeSafeInteger(input.tick, "action acceptance tick");
    const execution: ActionExecution = {
        id: state.nextExecutionId,
        sourceUnitId: input.sourceUnitId,
        definition: input.definition,
        acceptedAtTick: input.tick,
        inputTargetUnitId: input.inputTargetUnitId,
        cursor: 0,
        bindings: targetBindings(input.bindings),
        samples: validateSamples(input.samples ?? {}),
        wait: null,
    };

    return { state: { nextExecutionId, executions: [...state.executions, execution] }, execution };
}

function contextFor(
    execution: ActionExecution,
    tick: number,
    call: CallContext,
    projectiles?: ProjectileOperations,
): ActionExecutionContext {
    return {
        sourceUnitId: execution.sourceUnitId,
        executionId: execution.id,
        acceptedAtTick: execution.acceptedAtTick,
        inputTargetUnitId: execution.inputTargetUnitId,
        tick,
        call,
        bindings: new Map(Object.entries(execution.bindings)),
        samples: execution.samples,
        ...(projectiles === undefined ? {} : { projectiles }),
    };
}

function endExecution(
    state: BattleState,
    execution: ActionExecution,
    reason: string,
    call: CallContext,
): BattleState {
    state = {
        ...state,
        actionExecutions: removeActionExecution(state.actionExecutions, execution.id),
    };

    return closeLifetime(state, { type: "ACTION", executionId: execution.id }, reason, call);
}

function finish(
    state: BattleState,
    execution: ActionExecution,
    tick: number,
    signals: readonly ActionExecutionSignal[],
    call: CallContext,
): Result<ActionExecutionOutcome> {
    const signal: ActionExecutionSignal = {
        type: "ACTION_FINISHED",
        executionId: execution.id,
        sourceUnitId: execution.sourceUnitId,
        tick,
    };
    state = endExecution(state, execution, "ACTION_FINISHED", call);

    return {
        state: appendEvents(state, [signal]),
        value: { result: { type: "FINISHED" }, signals: [...signals, signal] },
    };
}

export function cancel(
    state: BattleState,
    request: ActionExecutionCancelRequest,
    call: CallContext = emptyCall,
): Result<ActionExecutionOutcome> {
    const { executionId, tick, reason = "CANCELLED" } = request;
    const execution = getActionExecution(state.actionExecutions, executionId);

    if (execution === undefined) {
        return { state, value: { result: { type: "ABSENT" }, signals: [] } };
    }

    const signal: ActionExecutionSignal = {
        type: "ACTION_CANCELLED",
        executionId,
        sourceUnitId: execution.sourceUnitId,
        tick,
        reason,
    };
    state = endExecution(state, execution, reason, call);

    return {
        state: appendEvents(state, [signal]),
        value: { result: { type: "CANCELLED", reason }, signals: [signal] },
    };
}

function enterWait(request: ActionExecutionWaitRequest, tick: number): ActionExecutionWait {
    switch (request.type) {
        case "FOR_TICKS":
            assertNonnegativeSafeInteger(request.ticks, "action wait duration");

            return { type: "COUNT", remainingTicks: request.ticks, lastConsumedTick: tick };

        case "UNTIL_TICK":
            assertNonnegativeSafeInteger(request.targetTick, "action wait target tick");

            return { type: "UNTIL", targetTick: request.targetTick };
    }
}

function advanceWait(wait: ActionExecutionWait, tick: number): ActionExecutionWait {
    return wait.type === "UNTIL" || tick <= wait.lastConsumedTick || wait.remainingTicks === 0
        ? wait
        : { ...wait, remainingTicks: wait.remainingTicks - 1, lastConsumedTick: tick };
}

function waitComplete(wait: ActionExecutionWait, tick: number): boolean {
    return wait.type === "COUNT" ? wait.remainingTicks === 0 : tick >= wait.targetTick;
}

export function resume(
    state: BattleState,
    request: ActionExecutionResumeRequest,
    resources: ActionExecutionResources,
    call: CallContext = emptyCall,
): Result<ActionExecutionOutcome> {
    const { executionId, segments, tick } = request;
    let execution = getActionExecution(state.actionExecutions, executionId);

    if (execution === undefined) {
        return { state, value: { result: { type: "ABSENT" }, signals: [] } };
    }

    const signals: ActionExecutionSignal[] = [];
    const releaseType = segments.some(({ type }) => type === "RELEASE") ? "RELEASE" : "EXECUTE";
    const absent = (): Result<ActionExecutionOutcome> => ({
        state,
        value: { result: { type: "ABSENT" }, signals },
    });

    const cancelled = (
        reason: "SOURCE_ABSENT" | "INTERRUPTED" | "CONTENT_CANCELLED",
    ): Result<ActionExecutionOutcome> => {
        const result = cancel(state, { executionId, tick, reason }, call);

        return {
            state: result.state,
            value: { ...result.value, signals: [...signals, ...result.value.signals] },
        };
    };

    const initialSource = getUnit(state, execution.sourceUnitId);

    if (
        initialSource === undefined ||
        initialSource.lifecycle === "LEAVING" ||
        !isSpatiallyPresent(initialSource)
    ) {
        return cancelled("SOURCE_ABSENT");
    }

    while (true) {
        const segment: CompiledActionSegment | undefined = segments[execution.cursor];

        if (segment === undefined) {
            return finish(state, execution, tick, signals, call);
        }

        const source = getUnit(state, execution.sourceUnitId);

        if (source === undefined || source.lifecycle === "LEAVING" || !isSpatiallyPresent(source)) {
            return cancelled("SOURCE_ABSENT");
        }

        if (hasStatusFlag(source, "STUNNED")) {
            return cancelled("INTERRUPTED");
        }
        if (
            segment.type === releaseType &&
            !segments.slice(0, execution.cursor).some(({ type }) => type === releaseType)
        ) {
            const interrupted = beforeActionRelease(state, source.id, tick, call);
            state = interrupted.state;

            if (getActionExecution(state.actionExecutions, executionId) === undefined) {
                return absent();
            }
            if (interrupted.value) {
                return cancelled("INTERRUPTED");
            }

            state = gainUnitSkillSp(state, source.id, "ATTACK");
        }

        switch (segment.type) {
            case "EXECUTE": {
                const advanced: Result<ActionExecutionStepResult | undefined> = segment.run(
                    state,
                    contextFor(execution, tick, call, resources.projectileOperations),
                );
                state = advanced.state;
                const result = advanced.value;
                let current = getActionExecution(state.actionExecutions, executionId);

                if (current === undefined) {
                    return absent();
                }

                const preceding = segments.slice(0, execution.cursor);
                const releaseIndex = preceding.findIndex(({ type }) => type === "RELEASE");
                const outputStarted = releaseType === "EXECUTE" || releaseIndex >= 0;
                const previousOutput = preceding
                    .slice(releaseIndex + 1)
                    .some(({ type }) => type === "EXECUTE");

                if (outputStarted && !previousOutput && resources.completeAttack !== undefined) {
                    state = resources.completeAttack(state, execution.sourceUnitId, tick, call);
                    current = getActionExecution(state.actionExecutions, executionId);

                    if (current === undefined) {
                        return absent();
                    }
                }

                execution = {
                    ...current,
                    cursor: execution.cursor + 1,
                    bindings:
                        result?.bindings === undefined
                            ? current.bindings
                            : targetBindings(result.bindings),
                    samples:
                        result?.samples === undefined
                            ? current.samples
                            : validateSamples(result.samples),
                };

                if (result?.continuation === "FINISH") {
                    return finish(state, execution, tick, signals, call);
                }
                if (result?.continuation === "CANCEL") {
                    state = {
                        ...state,
                        actionExecutions: replaceActionExecution(state.actionExecutions, execution),
                    };

                    return cancelled("CONTENT_CANCELLED");
                }

                break;
            }

            case "WAIT": {
                const wait =
                    execution.wait === null
                        ? enterWait(
                              segment.resolve(
                                  contextFor(execution, tick, call, resources.projectileOperations),
                              ),
                              tick,
                          )
                        : advanceWait(execution.wait, tick);

                if (!waitComplete(wait, tick)) {
                    if (wait !== execution.wait) {
                        state = {
                            ...state,
                            actionExecutions: replaceActionExecution(state.actionExecutions, {
                                ...execution,
                                wait,
                            }),
                        };
                    }

                    return { state, value: { result: { type: "WAITING" }, signals } };
                }

                execution = { ...execution, cursor: execution.cursor + 1, wait: null };
                break;
            }

            case "RELEASE": {
                const signal: ActionExecutionSignal = {
                    type: "ACTION_RELEASED",
                    executionId,
                    sourceUnitId: execution.sourceUnitId,
                    tick,
                    markerId: segment.markerId,
                };
                signals.push(signal);
                state = appendEvents(state, [signal]);
                execution = { ...execution, cursor: execution.cursor + 1 };
                break;
            }
        }

        state = {
            ...state,
            actionExecutions: replaceActionExecution(state.actionExecutions, execution),
        };
    }
}
