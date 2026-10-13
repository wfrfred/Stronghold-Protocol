import { closeLifetime } from "../../../battle/execution/lifetime.js";
import {
    getActionExecution,
    removeActionExecution,
    replaceActionExecution,
} from "./internal/executions.js";
import { assertFiniteNumber, assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import { appendEvents, getUnit, type BattleState, type Result } from "../../../battle/state.js";
import { emptyCall, type CallContext } from "../../../battle/execution/call.js";
import type { Id } from "../../unit.js";
import { isSpatiallyPresent } from "../presence.js";
import type { ActionDefinition, TargetBindingId } from "./capability.js";
import type { ProjectileOperations } from "../../../battlefield/projectile/operations.js";
import { gainUnitSkillSp } from "../../../battle/execution/skill-sp.js";
import { hasStatusFlag } from "../status/capability.js";
import { beforeActionRelease } from "./release.js";

export interface ActionExecutionResources {
    readonly projectileOperations?: ProjectileOperations;
    readonly completeAttack?: (
        state: BattleState,
        unitId: Id,
        tick: number,
        call?: CallContext,
    ) => BattleState;
}

export type ActionExecutionId = number;

export type ActionExecutionSamples = Readonly<Record<string, number>>;

export type ActionExecutionBindings = Readonly<Record<TargetBindingId, readonly Id[]>>;

export type ActionExecutionWait =
    | {
          readonly type: "COUNT";
          readonly remainingTicks: number;
          readonly lastConsumedTick: number;
      }
    | { readonly type: "UNTIL"; readonly targetTick: number };

export interface ActionExecution {
    readonly id: ActionExecutionId;
    readonly sourceUnitId: Id;
    readonly definition: ActionDefinition;
    readonly acceptedAtTick: number;
    readonly inputTargetUnitId: Id | null;
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
    readonly sourceUnitId: Id;
    readonly definition: ActionDefinition;
    readonly inputTargetUnitId: Id | null;
    readonly bindings: ReadonlyMap<TargetBindingId, readonly Id[]>;
    readonly tick: number;
    readonly samples?: ActionExecutionSamples;
}

export interface ActionExecutionContext {
    readonly call: CallContext;
    readonly sourceUnitId: Id;
    readonly executionId: ActionExecutionId;
    readonly acceptedAtTick: number;
    readonly inputTargetUnitId: Id | null;
    readonly tick: number;
    readonly bindings: ReadonlyMap<TargetBindingId, readonly Id[]>;
    readonly samples: ActionExecutionSamples;
    readonly projectiles?: ProjectileOperations;
}

export interface ActionExecutionStepResult {
    readonly bindings?: ReadonlyMap<TargetBindingId, readonly Id[]>;
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
          readonly run: (
              state: BattleState,
              context: ActionExecutionContext,
          ) => Result<ActionExecutionStepResult | undefined>;
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
    readonly sourceUnitId: Id;
    readonly tick: number;
} & (
    | { readonly type: "ACTION_RELEASED"; readonly markerId: string }
    | { readonly type: "ACTION_FINISHED" }
    | { readonly type: "ACTION_CANCELLED"; readonly reason: ActionExecutionCancellationReason }
);

export type ActionExecutionResult =
    | { readonly type: "ABSENT" | "WAITING" | "FINISHED" }
    | { readonly type: "CANCELLED"; readonly reason: ActionExecutionCancellationReason };

export interface ActionExecutionResumeRequest {
    readonly executionId: ActionExecutionId;
    readonly segments: readonly CompiledActionSegment[];
    readonly tick: number;
}

export interface ActionExecutionCancelRequest {
    readonly executionId: ActionExecutionId;
    readonly tick: number;
    readonly reason?: ActionExecutionCancellationReason;
}

export function createActionExecutionState(nextExecutionId = 0): ActionExecutionState {
    assertNonnegativeSafeInteger(nextExecutionId, "action execution identity");

    return { nextExecutionId, executions: [] };
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

function targetBindings(
    bindings: ReadonlyMap<TargetBindingId, readonly Id[]>,
): ActionExecutionBindings {
    return Object.fromEntries(bindings);
}

function validateSamples(samples: ActionExecutionSamples): ActionExecutionSamples {
    for (const [name, value] of Object.entries(samples)) {
        assertFiniteNumber(value, `action sample ${name}`);
    }

    return samples;
}

export function acceptActionExecution(
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
    call: CallContext,
): Result<ActionExecutionResult> {
    const signal: ActionExecutionSignal = {
        type: "ACTION_FINISHED",
        executionId: execution.id,
        sourceUnitId: execution.sourceUnitId,
        tick,
    };
    state = endExecution(state, execution, "ACTION_FINISHED", call);

    return {
        state: appendEvents(state, [signal]),
        value: { type: "FINISHED" },
    };
}

export function cancelActionExecution(
    state: BattleState,
    request: ActionExecutionCancelRequest,
    call: CallContext = emptyCall,
): Result<ActionExecutionResult> {
    const { executionId, tick, reason = "CANCELLED" } = request;
    const execution = getActionExecution(state.actionExecutions, executionId);

    if (execution === undefined) {
        return { state, value: { type: "ABSENT" } };
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
        value: { type: "CANCELLED", reason },
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

export function resumeActionExecution(
    state: BattleState,
    request: ActionExecutionResumeRequest,
    resources: ActionExecutionResources,
    call: CallContext = emptyCall,
): Result<ActionExecutionResult> {
    const { executionId, segments, tick } = request;
    let execution = getActionExecution(state.actionExecutions, executionId);

    if (execution === undefined) {
        return { state, value: { type: "ABSENT" } };
    }

    const releaseType = segments.some(({ type }) => type === "RELEASE") ? "RELEASE" : "EXECUTE";
    const absent = (): Result<ActionExecutionResult> => ({
        state,
        value: { type: "ABSENT" },
    });

    const cancelled = (
        reason: "SOURCE_ABSENT" | "INTERRUPTED" | "CONTENT_CANCELLED",
    ): Result<ActionExecutionResult> =>
        cancelActionExecution(state, { executionId, tick, reason }, call);

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
            return finish(state, execution, tick, call);
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
                    return finish(state, execution, tick, call);
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

                    return { state, value: { type: "WAITING" } };
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
