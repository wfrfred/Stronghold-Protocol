import { accept, cancel, resume } from "./internal/process.js";
import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import type { BattleState, Result } from "../../../battle/state.js";
import type { CallContext } from "../../../battle/execution/call.js";
import type { UnitId } from "../../unit.js";
import type { ActionDefinition, TargetBindingId } from "./capability.js";
import type { ProjectileOperations } from "../../../battlefield/projectile/operations.js";

export interface ActionExecutionResources {
    readonly projectileOperations?: ProjectileOperations;
    readonly completeAttack?: (
        state: BattleState,
        unitId: UnitId,
        tick: number,
        call?: CallContext,
    ) => BattleState;
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
    readonly call: CallContext;
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

export interface ActionExecutionOutcome {
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
    return accept(state, input);
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
    state: BattleState,
    request: ActionExecutionCancelRequest,
    call?: CallContext,
): Result<ActionExecutionOutcome> {
    return cancel(state, request, call);
}

export function resumeActionExecution(
    state: BattleState,
    request: ActionExecutionResumeRequest,
    resources: ActionExecutionResources,
    call?: CallContext,
): Result<ActionExecutionOutcome> {
    return resume(state, request, resources, call);
}
