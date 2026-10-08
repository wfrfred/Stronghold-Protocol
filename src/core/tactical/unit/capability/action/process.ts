import { ActionExecutionWork } from "./internal/executions.js";
import { assertFiniteNumber, assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import { ownDataRecord } from "../../../../common/immutable-data.js";
import {
    appendCombatEvents,
    getCombatUnit,
    type CombatWork,
} from "../../../battle/execution/work.js";
import type { UnitId } from "../../unit.js";
import { isSpatiallyPresent } from "../presence.js";
import type { EffectTransitionResources } from "../effects/contract.js";
import { finishEffectsOwnedByExecution } from "../effects/lifecycle.js";
import type { ActionDefinition, TargetBindingId } from "./capability.js";
import type { ProjectileOperations } from "../../../battlefield/projectile/operations.js";
import { gainUnitSkillSp } from "../../../battle/execution/skill-sp.js";
import { hasStatusFlag } from "../status/capability.js";

export type ActionExecutionId = number;

export type ActionExecutionSamples = Readonly<Record<string, number>>;

export type ActionExecutionBindings = Readonly<Record<TargetBindingId, readonly UnitId[]>>;

export type ActionExecutionWait =
    | {
          readonly type: "COUNT";
          readonly remainingTicks: number;
          readonly lastConsumedTick: number;
      }
    | { readonly type: "UNTIL"; readonly targetTick: number };

export interface ActionExecution {
    readonly id: ActionExecutionId;
    readonly sourceUnitId: UnitId;
    readonly definition: ActionDefinition;
    readonly acceptedAtTick: number;
    readonly inputTargetUnitId: UnitId | null;
    readonly cursor: number;
    readonly bindings: ActionExecutionBindings;
    readonly samples: ActionExecutionSamples;
    readonly wait: ActionExecutionWait | null;
}

export interface ActionExecutionState {
    readonly nextExecutionId: ActionExecutionId;
    readonly executions: readonly ActionExecution[];
}

export interface ActionExecutionInput {
    readonly sourceUnitId: UnitId;
    readonly definition: ActionDefinition;
    readonly inputTargetUnitId: UnitId | null;
    readonly bindings: ReadonlyMap<TargetBindingId, readonly UnitId[]>;
    readonly tick: number;
    readonly samples?: ActionExecutionSamples;
}

export interface ActionExecutionContext {
    readonly work: CombatWork;
    readonly sourceUnitId: UnitId;
    readonly executionId: ActionExecutionId;
    readonly acceptedAtTick: number;
    readonly inputTargetUnitId: UnitId | null;
    readonly tick: number;
    readonly bindings: ReadonlyMap<TargetBindingId, readonly UnitId[]>;
    readonly samples: ActionExecutionSamples;
    readonly projectiles?: ProjectileOperations;
}

export interface ActionExecutionStepResult {
    readonly work: CombatWork;
    readonly bindings?: ReadonlyMap<TargetBindingId, readonly UnitId[]>;
    readonly samples?: ActionExecutionSamples;
    readonly continuation?: "NEXT" | "FINISH" | "CANCEL";
}

export type ActionExecutionWaitRequest =
    | { readonly type: "FOR_TICKS"; readonly ticks: number }
    | { readonly type: "UNTIL_TICK"; readonly targetTick: number };

export type CompiledActionSegment = {
    readonly blockingMovement?: boolean;
    readonly allowNewAction?: boolean;
} & (
    | {
          readonly type: "EXECUTE";
          readonly run: (context: ActionExecutionContext) => ActionExecutionStepResult;
      }
    | {
          readonly type: "WAIT";
          readonly resolve: (context: ActionExecutionContext) => ActionExecutionWaitRequest;
      }
    | { readonly type: "RELEASE"; readonly markerId: string }
);

export interface ActionExecutionPermissions {
    readonly blockingMovement: boolean;
    readonly allowNewAction: boolean;
}

export type ActionExecutionCancellationReason =
    "CANCELLED" | "CONTENT_CANCELLED" | "SOURCE_ABSENT" | "INTERRUPTED";

export type ActionExecutionSignal = {
    readonly executionId: ActionExecutionId;
    readonly sourceUnitId: UnitId;
    readonly tick: number;
} & (
    | { readonly type: "ACTION_RELEASED"; readonly markerId: string }
    | { readonly type: "ACTION_FINISHED" }
    | { readonly type: "ACTION_CANCELLED"; readonly reason: ActionExecutionCancellationReason }
);

export type ActionExecutionResult =
    | { readonly type: "ABSENT" | "WAITING" | "FINISHED" }
    | { readonly type: "CANCELLED"; readonly reason: ActionExecutionCancellationReason };

export interface ActionExecutionTransition {
    readonly work: CombatWork;
    readonly state: ActionExecutionState;
    readonly result: ActionExecutionResult;
    readonly signals: readonly ActionExecutionSignal[];
}

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

export function createActionExecutionState(nextExecutionId = 0): ActionExecutionState {
    assertNonnegativeSafeInteger(nextExecutionId, "action execution identity");

    return Object.freeze({ nextExecutionId, executions: Object.freeze([]) });
}

export function copyActionExecutionState(state: ActionExecutionState): ActionExecutionState {
    return Object.freeze({
        nextExecutionId: state.nextExecutionId,
        executions: Object.freeze([...state.executions]),
    });
}

export function acceptActionExecution(
    state: ActionExecutionState,
    input: ActionExecutionInput,
): { readonly state: ActionExecutionState; readonly execution: ActionExecution } {
    const executions = new ActionExecutionWork(state);
    const execution = acceptActionExecutionInWork(executions, input);

    return { state: executions.result(), execution };
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

export function actionExecutionPermissions(
    execution: ActionExecution,
    segments: readonly CompiledActionSegment[],
): ActionExecutionPermissions {
    const segment = segments[execution.cursor];

    return {
        blockingMovement: segment?.blockingMovement ?? false,
        allowNewAction: segment?.allowNewAction ?? true,
    };
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

export function cancelActionExecution(
    work: CombatWork,
    state: ActionExecutionState,
    executionId: ActionExecutionId,
    resources: EffectTransitionResources,
    tick: number,
    reason: ActionExecutionCancellationReason = "CANCELLED",
): ActionExecutionTransition {
    const executions = new ActionExecutionWork(state);
    const result = cancelActionExecutionInWork(
        work,
        executions,
        executionId,
        resources,
        tick,
        reason,
    );

    return { ...result, state: executions.result() };
}

export function cancelActionExecutionInWork(
    work: CombatWork,
    executions: ActionExecutionWork,
    executionId: ActionExecutionId,
    resources: EffectTransitionResources,
    tick: number,
    reason: ActionExecutionCancellationReason = "CANCELLED",
): ActionExecutionWorkTransition {
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

export function resumeActionExecution(
    work: CombatWork,
    state: ActionExecutionState,
    executionId: ActionExecutionId,
    segments: readonly CompiledActionSegment[],
    tick: number,
    resources: EffectTransitionResources,
    projectiles?: ProjectileOperations,
): ActionExecutionTransition {
    const executions = new ActionExecutionWork(state);
    const result = resumeActionExecutionInWork(
        work,
        executions,
        executionId,
        segments,
        tick,
        resources,
        projectiles,
    );

    return { ...result, state: executions.result() };
}

export function resumeActionExecutionInWork(
    work: CombatWork,
    executions: ActionExecutionWork,
    executionId: ActionExecutionId,
    segments: readonly CompiledActionSegment[],
    tick: number,
    resources: EffectTransitionResources,
    projectiles?: ProjectileOperations,
): ActionExecutionWorkTransition {
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
                executionId,
                resources,
                tick,
                "SOURCE_ABSENT",
            );

            return { ...cancelled, signals: [...signals, ...cancelled.signals] };
        }

        if (hasStatusFlag(source, "STUNNED")) {
            const cancelled = cancelActionExecutionInWork(
                work,
                executions,
                executionId,
                resources,
                tick,
                "INTERRUPTED",
            );

            return { ...cancelled, signals: [...signals, ...cancelled.signals] };
        }

        if (
            segment.type === releaseType &&
            !segments.slice(0, execution.cursor).some(({ type }) => type === releaseType)
        ) {
            work = gainUnitSkillSp(work, source.id, "ATTACK");
        }

        switch (segment.type) {
            case "EXECUTE": {
                const result: ActionExecutionStepResult = segment.run(
                    contextFor(work, execution, tick, projectiles),
                );
                work = result.work;
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
                        executionId,
                        resources,
                        tick,
                        "CONTENT_CANCELLED",
                    );

                    return { ...cancelled, signals: [...signals, ...cancelled.signals] };
                }

                break;
            }

            case "WAIT": {
                const wait =
                    execution.wait === null
                        ? enterWait(
                              segment.resolve(contextFor(work, execution, tick, projectiles)),
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
