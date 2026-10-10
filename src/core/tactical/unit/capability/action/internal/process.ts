import { EffectDispatchScope } from "../../effects/dispatch.js";
import type { ActionExecutionWork } from "./executions.js";
import { assertFiniteNumber, assertNonnegativeSafeInteger } from "../../../../../common/assert.js";
import { appendEvents, getUnit, type BattleState } from "../../../../battle/execution/context.js";
import type { UnitId } from "../../../unit.js";
import { isSpatiallyPresent } from "../../presence.js";
import type { EffectTransitionResources } from "../../effects/contract.js";
import { closeEffectLifetimes } from "../../effects/lifecycle.js";
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
    ActionExecutionResumeRequest,
    ActionExecutionSamples,
    ActionExecutionSignal,
    ActionExecutionTransition,
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

export function acceptActionExecutionInWork(
    executions: ActionExecutionWork,
    input: ActionExecutionInput,
): ActionExecution {
    const nextExecutionId = executions.nextExecutionId + 1;

    if (!Number.isSafeInteger(nextExecutionId)) {
        throw new RangeError("action execution identity overflow");
    }

    assertNonnegativeSafeInteger(input.tick, "action acceptance tick");

    const execution: ActionExecution = {
        id: executions.nextExecutionId,
        sourceUnitId: input.sourceUnitId,
        definition: input.definition,
        acceptedAtTick: input.tick,
        inputTargetUnitId: input.inputTargetUnitId,
        cursor: 0,
        bindings: targetBindings(input.bindings),
        samples: validateSamples(input.samples ?? {}),
        wait: null,
    };
    executions.add(execution);

    return execution;
}

function contextFor(
    work: BattleState,
    execution: ActionExecution,
    tick: number,
    projectiles?: ProjectileOperations,
): ActionExecutionContext {
    return {
        work,
        sourceUnitId: execution.sourceUnitId,
        executionId: execution.id,
        acceptedAtTick: execution.acceptedAtTick,
        inputTargetUnitId: execution.inputTargetUnitId,
        tick,
        bindings: new Map(Object.entries(execution.bindings)),
        samples: execution.samples,
        ...(projectiles === undefined ? {} : { projectiles }),
    };
}

type ActionExecutionWorkTransition = Omit<ActionExecutionTransition, "state">;

function endExecution(
    work: BattleState,
    executions: ActionExecutionWork,
    execution: ActionExecution,
    resources: EffectTransitionResources,
    tick: number,
    reason: string,
    dispatch: EffectDispatchScope,
): void {
    executions.remove(execution);

    closeEffectLifetimes(
        work,
        [{ type: "ACTION", executionId: execution.id }],
        resources,
        tick,
        reason,
        dispatch,
    );
}

function finishExecution(
    work: BattleState,
    executions: ActionExecutionWork,
    execution: ActionExecution,
    resources: EffectTransitionResources,
    tick: number,
    signals: readonly ActionExecutionSignal[],
    dispatch: EffectDispatchScope,
): ActionExecutionWorkTransition {
    const signal: ActionExecutionSignal = {
        type: "ACTION_FINISHED",
        executionId: execution.id,
        sourceUnitId: execution.sourceUnitId,
        tick,
    };
    endExecution(work, executions, execution, resources, tick, "ACTION_FINISHED", dispatch);
    appendEvents(work, [signal]);

    return {
        result: { type: "FINISHED" },
        signals: [...signals, signal],
    };
}

export function cancelActionExecutionInWork(
    work: BattleState,
    executions: ActionExecutionWork,
    request: ActionExecutionCancelRequest,
    resources: EffectTransitionResources,
    dispatch = new EffectDispatchScope(),
): ActionExecutionWorkTransition {
    const { executionId, tick, reason = "CANCELLED" } = request;
    const execution = executions.get(executionId);

    if (execution === undefined) {
        return { result: { type: "ABSENT" }, signals: [] };
    }

    if (work.actionExecutions !== executions) {
        work.actionExecutions = executions;
    }

    const signal: ActionExecutionSignal = {
        type: "ACTION_CANCELLED",
        executionId,
        sourceUnitId: execution.sourceUnitId,
        tick,
        reason,
    };
    endExecution(work, executions, execution, resources, tick, reason, dispatch);
    appendEvents(work, [signal]);

    return {
        result: { type: "CANCELLED", reason },
        signals: [signal],
    };
}

function enterWait(request: ActionExecutionWaitRequest, tick: number): ActionExecutionWait {
    switch (request.type) {
        case "FOR_TICKS":
            assertNonnegativeSafeInteger(request.ticks, "action wait duration");

            return {
                type: "COUNT",
                remainingTicks: request.ticks,
                lastConsumedTick: tick,
            };

        case "UNTIL_TICK":
            assertNonnegativeSafeInteger(request.targetTick, "action wait target tick");

            return { type: "UNTIL", targetTick: request.targetTick };
    }
}

function advanceWait(wait: ActionExecutionWait, tick: number): ActionExecutionWait {
    if (wait.type === "UNTIL" || tick <= wait.lastConsumedTick || wait.remainingTicks === 0) {
        return wait;
    }

    return {
        ...wait,
        remainingTicks: wait.remainingTicks - 1,
        lastConsumedTick: tick,
    };
}

function waitComplete(wait: ActionExecutionWait, tick: number): boolean {
    return wait.type === "COUNT" ? wait.remainingTicks === 0 : tick >= wait.targetTick;
}

export function resumeActionExecutionInWork(
    work: BattleState,
    executions: ActionExecutionWork,
    request: ActionExecutionResumeRequest,
    resources: ActionExecutionResources,
): ActionExecutionWorkTransition {
    const { executionId, segments, tick } = request;
    let execution = executions.get(executionId);

    if (execution === undefined) {
        return { result: { type: "ABSENT" }, signals: [] };
    }

    if (work.actionExecutions !== executions) {
        work.actionExecutions = executions;
    }

    const dispatch = new EffectDispatchScope();
    const signals: ActionExecutionSignal[] = [];
    const releaseType = segments.some(({ type }) => type === "RELEASE") ? "RELEASE" : "EXECUTE";

    while (true) {
        const segment: CompiledActionSegment | undefined = segments[execution.cursor];

        if (segment === undefined) {
            return finishExecution(work, executions, execution, resources, tick, signals, dispatch);
        }

        const source = getUnit(work, execution.sourceUnitId);

        if (source === undefined || !isSpatiallyPresent(source)) {
            const cancelled = cancelActionExecutionInWork(
                work,
                executions,
                { executionId, tick, reason: "SOURCE_ABSENT" },
                resources,
                dispatch,
            );

            return { ...cancelled, signals: [...signals, ...cancelled.signals] };
        }

        if (hasStatusFlag(source, "STUNNED")) {
            const cancelled = cancelActionExecutionInWork(
                work,
                executions,
                { executionId, tick, reason: "INTERRUPTED" },
                resources,
                dispatch,
            );

            return { ...cancelled, signals: [...signals, ...cancelled.signals] };
        }

        if (
            segment.type === releaseType &&
            !segments.slice(0, execution.cursor).some(({ type }) => type === releaseType)
        ) {
            const interrupted = beforeActionRelease(work, source.id, tick, resources, dispatch);

            if (executions.get(executionId) === undefined) {
                return { result: { type: "ABSENT" }, signals };
            }

            if (interrupted) {
                const cancelled = cancelActionExecutionInWork(
                    work,
                    executions,
                    { executionId, tick, reason: "INTERRUPTED" },
                    resources,
                    dispatch,
                );

                return { ...cancelled, signals: [...signals, ...cancelled.signals] };
            }

            gainUnitSkillSp(work, source.id, "ATTACK");
        }

        switch (segment.type) {
            case "EXECUTE": {
                const result = segment.run(
                    contextFor(work, execution, tick, resources.projectileOperations),
                );

                if (executions.get(executionId) === undefined) {
                    return { result: { type: "ABSENT" }, signals };
                }

                const preceding = segments.slice(0, execution.cursor);
                const releaseIndex = preceding.findIndex(({ type }) => type === "RELEASE");
                const outputStarted = releaseType === "EXECUTE" || releaseIndex >= 0;
                const previousOutput = preceding
                    .slice(releaseIndex + 1)
                    .some(({ type }) => type === "EXECUTE");

                if (outputStarted && !previousOutput && resources.completeAttack !== undefined) {
                    resources.completeAttack(work, execution.sourceUnitId, tick, dispatch);

                    if (executions.get(executionId) === undefined) {
                        return { result: { type: "ABSENT" }, signals };
                    }
                }

                execution = {
                    ...execution,
                    cursor: execution.cursor + 1,
                    bindings:
                        result?.bindings === undefined
                            ? execution.bindings
                            : targetBindings(result.bindings),
                    samples:
                        result?.samples === undefined
                            ? execution.samples
                            : validateSamples(result.samples),
                };

                if (result?.continuation === "FINISH") {
                    return finishExecution(
                        work,
                        executions,
                        execution,
                        resources,
                        tick,
                        signals,
                        dispatch,
                    );
                }
                if (result?.continuation === "CANCEL") {
                    executions.replace(execution);
                    const cancelled = cancelActionExecutionInWork(
                        work,
                        executions,
                        { executionId, tick, reason: "CONTENT_CANCELLED" },
                        resources,
                        dispatch,
                    );

                    return { ...cancelled, signals: [...signals, ...cancelled.signals] };
                }

                break;
            }

            case "WAIT": {
                const wait =
                    execution.wait === null
                        ? enterWait(
                              segment.resolve(
                                  contextFor(work, execution, tick, resources.projectileOperations),
                              ),
                              tick,
                          )
                        : advanceWait(execution.wait, tick);

                if (!waitComplete(wait, tick)) {
                    if (wait !== execution.wait) {
                        execution = { ...execution, wait };
                        executions.replace(execution);
                    }

                    return {
                        result: { type: "WAITING" },
                        signals,
                    };
                }

                execution = {
                    ...execution,
                    cursor: execution.cursor + 1,
                    wait: null,
                };
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
                appendEvents(work, [signal]);
                execution = { ...execution, cursor: execution.cursor + 1 };
                break;
            }
        }

        executions.replace(execution);
    }
}
