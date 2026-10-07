import type {
    NavigationGoal,
    NavigationRequestId,
} from "../../../../battlefield/navigation/request.js";
import type { RouteDefinition } from "./definition.js";

export interface RouteMoveProgress {
    readonly type: "MOVE";
    readonly goal: NavigationGoal;
    readonly navigationRequestId: NavigationRequestId;
}

export interface RouteWaitProgress {
    readonly type: "WAIT";
    readonly remainingTicks: number;
}

export type RouteCheckpointProgress =
    | {
          readonly type: "NOT_ENTERED";
      }
    | {
          readonly type: "ENTERED";
      }
    | RouteMoveProgress
    | RouteWaitProgress;

export type RouteProgress =
    | {
          readonly phase: "CHECKPOINTS";
          readonly checkpointIndex: number;
          readonly checkpoint: RouteCheckpointProgress;
      }
    | {
          readonly phase: "END";
          readonly move: RouteMoveProgress;
      }
    | {
          readonly phase: "COMPLETED";
      };

export interface RouteTiming {
    readonly waveStartedAtTick: number;
    readonly fragmentStartedAtTick: number;
}

export interface RouteState {
    readonly definition: RouteDefinition;
    readonly timing: RouteTiming;
    readonly alwaysCheckCurrentPoint: boolean;
    readonly progress: RouteProgress;
}

export function copyRouteState(state: Readonly<RouteState>): RouteState {
    const progress = state.progress;
    let copiedProgress: RouteProgress;

    switch (progress.phase) {
        case "CHECKPOINTS":
            copiedProgress = { ...progress, checkpoint: { ...progress.checkpoint } };
            break;

        case "END":
            copiedProgress = { ...progress, move: { ...progress.move } };
            break;

        case "COMPLETED":
            copiedProgress = { ...progress };
            break;
    }

    return { ...state, progress: copiedProgress };
}

function ticks(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
    }

    return value;
}

export function createRouteTiming(timing: RouteTiming): RouteTiming {
    return Object.freeze({
        waveStartedAtTick: ticks(timing.waveStartedAtTick, "waveStartedAtTick"),
        fragmentStartedAtTick: ticks(timing.fragmentStartedAtTick, "fragmentStartedAtTick"),
    });
}

export function createRouteState(
    definition: RouteDefinition,
    timing: RouteTiming,
    alwaysCheckCurrentPoint: boolean,
): RouteState {
    if (typeof alwaysCheckCurrentPoint !== "boolean") {
        throw new TypeError("alwaysCheckCurrentPoint must be boolean");
    }

    return {
        definition,
        timing,
        alwaysCheckCurrentPoint,
        progress: {
            phase: "CHECKPOINTS",
            checkpointIndex: 0,
            checkpoint: { type: "NOT_ENTERED" },
        },
    };
}
