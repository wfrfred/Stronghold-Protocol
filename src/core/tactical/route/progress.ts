import type { NavigationGoal, NavigationRequestId } from "../navigation/request.js";
import type { RouteDefinition } from "./definition.js";

export interface RouteMoveProgress {
    readonly type: "MOVE";
    readonly goal: NavigationGoal;
    readonly navigationRequestId: NavigationRequestId;
}

export interface RouteWaitProgress {
    readonly type: "WAIT";
    readonly remainingSeconds: number;
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
        checkpointIndex: number;
        checkpoint: RouteCheckpointProgress;
    }
    | {
        readonly phase: "END";
        readonly move: RouteMoveProgress;
    }
    | {
        readonly phase: "COMPLETED";
    };

export interface RouteClockBinding {
    readonly waveStartedAtSeconds: number;
    readonly fragmentStartedAtSeconds: number;
}

export interface RouteClock {
    readonly fixedPlayTimeSeconds: number;
    readonly userFixedPlayTimeSeconds: number;
    readonly deltaTimeSeconds: number;
}

export interface RouteState {
    readonly definition: RouteDefinition;
    readonly clockBinding: RouteClockBinding;
    readonly alwaysCheckCurrentPoint: boolean;
    progress: RouteProgress;
}

function finite(value: number, name: string): number {
    if (!Number.isFinite(value)) {
        throw new RangeError(`${name} must be finite`);
    }

    return value;
}

export function createRouteClockBinding(binding: RouteClockBinding): RouteClockBinding {
    return Object.freeze({
        waveStartedAtSeconds: finite(binding.waveStartedAtSeconds, "waveStartedAtSeconds"),
        fragmentStartedAtSeconds: finite(binding.fragmentStartedAtSeconds, "fragmentStartedAtSeconds"),
    });
}

export function createRouteClock(clock: RouteClock): RouteClock {
    const deltaTimeSeconds = finite(clock.deltaTimeSeconds, "deltaTimeSeconds");
    if (deltaTimeSeconds < 0) {
        throw new RangeError("deltaTimeSeconds must be non-negative");
    }

    return Object.freeze({
        fixedPlayTimeSeconds: finite(clock.fixedPlayTimeSeconds, "fixedPlayTimeSeconds"),
        userFixedPlayTimeSeconds: finite(clock.userFixedPlayTimeSeconds, "userFixedPlayTimeSeconds"),
        deltaTimeSeconds,
    });
}

export function createRouteState(
    definition: RouteDefinition,
    clockBinding: RouteClockBinding,
    alwaysCheckCurrentPoint: boolean,
): RouteState {
    if (typeof alwaysCheckCurrentPoint !== "boolean") {
        throw new TypeError("alwaysCheckCurrentPoint must be boolean");
    }

    return {
        definition,
        clockBinding,
        alwaysCheckCurrentPoint,
        progress: {
            phase: "CHECKPOINTS",
            checkpointIndex: 0,
            checkpoint: Object.freeze({ type: "NOT_ENTERED" }),
        },
    };
}
