import type { EffectDispatchScope } from "../effects/dispatch.js";
import { ActionExecutionWork } from "./internal/executions.js";
import {
    acceptActionExecutionInWork,
    cancelActionExecutionInWork,
    resumeActionExecutionInWork,
} from "./internal/process.js";
import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import type { BattleState } from "../../../battle/execution/context.js";
import type { UnitId } from "../../unit.js";
import type { EffectTransitionResources } from "../effects/contract.js";
import type { ActionDefinition, TargetBindingId } from "./capability.js";
import type { ProjectileOperations } from "../../../battlefield/projectile/operations.js";
import type { ActionReleaseResources } from "./release.js";

export interface ActionExecutionResources extends EffectTransitionResources {
    readonly actionRelease?: ActionReleaseResources;
    readonly projectileOperations?: ProjectileOperations;
    readonly completeAttack?: (
        work: BattleState,
        unitId: UnitId,
        tick: number,
        dispatch?: EffectDispatchScope,
    ) => void;
}

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
    readonly work: BattleState;
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
          readonly run: (context: ActionExecutionContext) => ActionExecutionStepResult | undefined;
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
    readonly state: ActionExecutionState;
    readonly result: ActionExecutionResult;
    readonly signals: readonly ActionExecutionSignal[];
}

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

export function acceptActionExecution(
    state: ActionExecutionState,
    input: ActionExecutionInput,
): { readonly state: ActionExecutionState; readonly execution: ActionExecution } {
    const executions = new ActionExecutionWork(state);
    const execution = acceptActionExecutionInWork(executions, input);

    return { state: executions.result(), execution };
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

export function cancelActionExecution(
    work: BattleState,
    state: ActionExecutionState,
    request: ActionExecutionCancelRequest,
    resources: EffectTransitionResources,
): ActionExecutionTransition {
    const executions = new ActionExecutionWork(state);
    const result = cancelActionExecutionInWork(work, executions, request, resources);

    return { ...result, state: executions.result() };
}

export function resumeActionExecution(
    work: BattleState,
    state: ActionExecutionState,
    request: ActionExecutionResumeRequest,
    resources: ActionExecutionResources,
): ActionExecutionTransition {
    const executions = new ActionExecutionWork(state);
    const result = resumeActionExecutionInWork(work, executions, request, resources);

    return { ...result, state: executions.result() };
}
