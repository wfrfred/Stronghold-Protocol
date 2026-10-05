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

export interface RouteBossRushWaitProgress {
    readonly type: "WAIT_BOSSRUSH_WAVE";
    readonly targetBossWaveCount: number;
}

export type RouteCheckpointProgress =
    | {
        readonly type: "NOT_ENTERED";
    }
    | {
        readonly type: "ENTERED";
    }
    | RouteMoveProgress
    | RouteWaitProgress
    | RouteBossRushWaitProgress;

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
