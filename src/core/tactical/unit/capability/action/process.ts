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

export type ActionExecutionCancellationReason = "CANCELLED" | "CONTENT_CANCELLED" | "SOURCE_ABSENT";

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
    const nextExecutionId = state.nextExecutionId + 1;

    if (!Number.isSafeInteger(nextExecutionId)) {
        throw new RangeError("action execution identity overflow");
    }

    assertNonnegativeSafeInteger(input.tick, "action acceptance tick");

    const execution: ActionExecution = Object.freeze({
        id: state.nextExecutionId,
        sourceUnitId: input.sourceUnitId,
        definition: input.definition,
        acceptedAtTick: input.tick,
        inputTargetUnitId: input.inputTargetUnitId,
        cursor: 0,
        bindings: ownBindings(input.bindings),
        samples: ownSamples(input.samples ?? {}),
        wait: null,
    });

    return {
        execution,
        state: Object.freeze({
            nextExecutionId,
            executions: Object.freeze([...state.executions, execution]),
        }),
    };
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

function replaceExecution(
    state: ActionExecutionState,
    execution: ActionExecution,
): ActionExecutionState {
    return Object.freeze({
        nextExecutionId: state.nextExecutionId,
        executions: Object.freeze(
            state.executions.map((current) => (current.id === execution.id ? execution : current)),
        ),
    });
}

function endExecution(
    work: CombatWork,
    state: ActionExecutionState,
    execution: ActionExecution,
    resources: EffectTransitionResources,
    tick: number,
): { readonly work: CombatWork; readonly state: ActionExecutionState } {
    return {
        work: finishEffectsOwnedByExecution(
            work,
            execution.sourceUnitId,
            execution.id,
            resources,
            tick,
        ),
        state: Object.freeze({
            nextExecutionId: state.nextExecutionId,
            executions: Object.freeze(
                state.executions.filter((current) => current.id !== execution.id),
            ),
        }),
    };
}

function finishExecution(
    work: CombatWork,
    state: ActionExecutionState,
    execution: ActionExecution,
    resources: EffectTransitionResources,
    tick: number,
    signals: readonly ActionExecutionSignal[],
): ActionExecutionTransition {
    const signal: ActionExecutionSignal = {
        type: "ACTION_FINISHED",
        executionId: execution.id,
        sourceUnitId: execution.sourceUnitId,
        tick,
    };
    const ended = endExecution(work, state, execution, resources, tick);

    return {
        ...ended,
        work: appendCombatEvents(ended.work, [signal]),
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
    const execution = state.executions.find((current) => current.id === executionId);

    if (execution === undefined) {
        return { work, state, result: { type: "ABSENT" }, signals: [] };
    }

    const signal: ActionExecutionSignal = {
        type: "ACTION_CANCELLED",
        executionId,
        sourceUnitId: execution.sourceUnitId,
        tick,
        reason,
    };
    const ended = endExecution(work, state, execution, resources, tick);

    return {
        ...ended,
        work: appendCombatEvents(ended.work, [signal]),
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
    let execution: ActionExecution | undefined = state.executions.find(
        (current) => current.id === executionId,
    );

    if (execution === undefined) {
        return { work, state, result: { type: "ABSENT" }, signals: [] };
    }

    const signals: ActionExecutionSignal[] = [];

    while (true) {
        const segment: CompiledActionSegment | undefined = segments[execution.cursor];

        if (segment === undefined) {
            return finishExecution(work, state, execution, resources, tick, signals);
        }

        const source = getCombatUnit(work, execution.sourceUnitId);

        if (source === undefined || !isSpatiallyPresent(source)) {
            const cancelled = cancelActionExecution(
                work,
                state,
                executionId,
                resources,
                tick,
                "SOURCE_ABSENT",
            );

            return { ...cancelled, signals: [...signals, ...cancelled.signals] };
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
                    return finishExecution(work, state, execution, resources, tick, signals);
                }
                if (result.continuation === "CANCEL") {
                    const cancelled = cancelActionExecution(
                        work,
                        replaceExecution(state, execution),
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
                    execution = Object.freeze({ ...execution, wait });

                    return {
                        work,
                        state: replaceExecution(state, execution),
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
