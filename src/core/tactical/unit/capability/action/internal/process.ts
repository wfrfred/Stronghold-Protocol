import type { ActionExecutionWork } from "./executions.js";
import { assertFiniteNumber, assertNonnegativeSafeInteger } from "../../../../../common/assert.js";
import { ownDataRecord } from "../../../../../common/immutable-data.js";
import {
    appendCombatEvents,
    getCombatUnit,
    type CombatWork,
} from "../../../../battle/execution/work.js";
import type { UnitId } from "../../../unit.js";
import { isSpatiallyPresent } from "../../presence.js";
import type { EffectTransitionResources } from "../../effects/contract.js";
import { finishEffectsOwnedByExecution } from "../../effects/lifecycle.js";
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
    ActionExecutionStepResult,
    ActionExecutionTransition,
    ActionExecutionWait,
    ActionExecutionWaitRequest,
    CompiledActionSegment,
} from "../process.js";

function ownBindings(
    bindings: ReadonlyMap<TargetBindingId, readonly UnitId[]>,
): ActionExecutionBindings {
    return ownDataRecord(Object.fromEntries(bindings), "action target bindings");
}

function ownSamples(samples: ActionExecutionSamples): ActionExecutionSamples {
    for (const [name, value] of Object.entries(samples)) {
        assertFiniteNumber(value, `action sample ${name}`);
    }

    return ownDataRecord(samples, "action samples");
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

    const execution: ActionExecution = Object.freeze({
        id: executions.nextExecutionId,
        sourceUnitId: input.sourceUnitId,
        definition: input.definition,
        acceptedAtTick: input.tick,
        inputTargetUnitId: input.inputTargetUnitId,
        cursor: 0,
        bindings: ownBindings(input.bindings),
        samples: ownSamples(input.samples ?? {}),
        wait: null,
    });
    executions.add(execution);

    return execution;
}

function contextFor(
    work: CombatWork,
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
    work: CombatWork,
    executions: ActionExecutionWork,
    execution: ActionExecution,
    resources: EffectTransitionResources,
    tick: number,
): CombatWork {
    const next = finishEffectsOwnedByExecution(
        work,
        execution.sourceUnitId,
        execution.id,
        resources,
        tick,
    );
    executions.remove(execution);

    return next;
}

function finishExecution(
    work: CombatWork,
    executions: ActionExecutionWork,
    execution: ActionExecution,
    resources: EffectTransitionResources,
    tick: number,
    signals: readonly ActionExecutionSignal[],
): ActionExecutionWorkTransition {
    const signal: ActionExecutionSignal = {
        type: "ACTION_FINISHED",
        executionId: execution.id,
        sourceUnitId: execution.sourceUnitId,
        tick,
    };
    const ended = endExecution(work, executions, execution, resources, tick);

    return {
        work: appendCombatEvents(ended, [signal]),
        result: { type: "FINISHED" },
        signals: [...signals, signal],
    };
}

export function cancelActionExecutionInWork(
    work: CombatWork,
    executions: ActionExecutionWork,
    request: ActionExecutionCancelRequest,
    resources: EffectTransitionResources,
): ActionExecutionWorkTransition {
    const { executionId, tick, reason = "CANCELLED" } = request;
    const execution = executions.get(executionId);

    if (execution === undefined) {
        return { work, result: { type: "ABSENT" }, signals: [] };
    }

    const signal: ActionExecutionSignal = {
        type: "ACTION_CANCELLED",
        executionId,
        sourceUnitId: execution.sourceUnitId,
        tick,
        reason,
    };
    const ended = endExecution(work, executions, execution, resources, tick);

    return {
        work: appendCombatEvents(ended, [signal]),
        result: { type: "CANCELLED", reason },
        signals: [signal],
    };
}

function enterWait(request: ActionExecutionWaitRequest, tick: number): ActionExecutionWait {
    switch (request.type) {
        case "FOR_TICKS":
            assertNonnegativeSafeInteger(request.ticks, "action wait duration");

            return Object.freeze({
                type: "COUNT",
                remainingTicks: request.ticks,
                lastConsumedTick: tick,
            });

        case "UNTIL_TICK":
            assertNonnegativeSafeInteger(request.targetTick, "action wait target tick");

            return Object.freeze({ type: "UNTIL", targetTick: request.targetTick });
    }
}

function advanceWait(wait: ActionExecutionWait, tick: number): ActionExecutionWait {
    if (wait.type === "UNTIL" || tick <= wait.lastConsumedTick || wait.remainingTicks === 0) {
        return wait;
    }

    return Object.freeze({
        ...wait,
        remainingTicks: wait.remainingTicks - 1,
        lastConsumedTick: tick,
    });
}

function waitComplete(wait: ActionExecutionWait, tick: number): boolean {
    return wait.type === "COUNT" ? wait.remainingTicks === 0 : tick >= wait.targetTick;
}

export function resumeActionExecutionInWork(
    work: CombatWork,
    executions: ActionExecutionWork,
    request: ActionExecutionResumeRequest,
    resources: ActionExecutionResources,
): ActionExecutionWorkTransition {
    const { executionId, segments, tick } = request;
    let execution = executions.get(executionId);

    if (execution === undefined) {
        return { work, result: { type: "ABSENT" }, signals: [] };
    }

    const signals: ActionExecutionSignal[] = [];
    const releaseType = segments.some(({ type }) => type === "RELEASE") ? "RELEASE" : "EXECUTE";

    while (true) {
        const segment: CompiledActionSegment | undefined = segments[execution.cursor];

        if (segment === undefined) {
            return finishExecution(work, executions, execution, resources, tick, signals);
        }

        const source = getCombatUnit(work, execution.sourceUnitId);

        if (source === undefined || !isSpatiallyPresent(source)) {
            const cancelled = cancelActionExecutionInWork(
                work,
                executions,
                { executionId, tick, reason: "SOURCE_ABSENT" },
                resources,
            );

            return { ...cancelled, signals: [...signals, ...cancelled.signals] };
        }

        if (hasStatusFlag(source, "STUNNED")) {
            const cancelled = cancelActionExecutionInWork(
                work,
                executions,
                { executionId, tick, reason: "INTERRUPTED" },
                resources,
            );

            return { ...cancelled, signals: [...signals, ...cancelled.signals] };
        }

        if (
            segment.type === releaseType &&
            !segments.slice(0, execution.cursor).some(({ type }) => type === releaseType)
        ) {
            const releasing = beforeActionRelease(work, source.id, tick, resources);
            work = releasing.work;

            if (releasing.interrupted) {
                const cancelled = cancelActionExecutionInWork(
                    work,
                    executions,
                    { executionId, tick, reason: "INTERRUPTED" },
                    resources,
                );

                return { ...cancelled, signals: [...signals, ...cancelled.signals] };
            }

            work = gainUnitSkillSp(work, source.id, "ATTACK");
        }

        switch (segment.type) {
            case "EXECUTE": {
                const result: ActionExecutionStepResult = segment.run(
                    contextFor(work, execution, tick, resources.projectileOperations),
                );
                work = result.work;
                const preceding = segments.slice(0, execution.cursor);
                const releaseIndex = preceding.findIndex(({ type }) => type === "RELEASE");
                const outputStarted = releaseType === "EXECUTE" || releaseIndex >= 0;
                const previousOutput = preceding
                    .slice(releaseIndex + 1)
                    .some(({ type }) => type === "EXECUTE");

                if (outputStarted && !previousOutput && resources.completeAttack !== undefined) {
                    work = resources.completeAttack(work, execution.sourceUnitId, tick);
                }

                execution = Object.freeze({
                    ...execution,
                    cursor: execution.cursor + 1,
                    bindings:
                        result.bindings === undefined
                            ? execution.bindings
                            : ownBindings(result.bindings),
                    samples:
                        result.samples === undefined
                            ? execution.samples
                            : ownSamples(result.samples),
                });

                if (result.continuation === "FINISH") {
                    return finishExecution(work, executions, execution, resources, tick, signals);
                }
                if (result.continuation === "CANCEL") {
                    executions.replace(execution);
                    const cancelled = cancelActionExecutionInWork(
                        work,
                        executions,
                        { executionId, tick, reason: "CONTENT_CANCELLED" },
                        resources,
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
                        execution = Object.freeze({ ...execution, wait });
                        executions.replace(execution);
                    }

                    return {
                        work,
                        result: { type: "WAITING" },
                        signals,
                    };
                }

                execution = Object.freeze({
                    ...execution,
                    cursor: execution.cursor + 1,
                    wait: null,
                });
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
                work = appendCombatEvents(work, [signal]);
                execution = Object.freeze({ ...execution, cursor: execution.cursor + 1 });
                break;
            }
        }
    }
}
