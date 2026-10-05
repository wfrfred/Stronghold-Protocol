import type { TilePosition, WorldOffset } from "../geometry/coordinate.js";
import type { PathMotionMode } from "../navigation/map.js";

export interface RouteMoveTarget {
    readonly position: TilePosition;
    readonly reachOffset: WorldOffset;
    readonly randomizeReachOffset: boolean;
    readonly reachDistance: number;
}

export type RouteCheckpoint =
    | {
        readonly type: "MOVE";
        readonly target: RouteMoveTarget;
    }
    | {
        readonly type: "PATROL_MOVE";
        readonly target: RouteMoveTarget;
    }
    | {
        readonly type: "MAP_OFFSET_MOVE";
        readonly target: RouteMoveTarget;
    }
    | {
        readonly type: "WAIT_FOR_SECONDS";
        readonly durationSeconds: number;
    }
    | {
        readonly type: "WAIT_FOR_PLAY_TIME";
        readonly targetPlayTimeSeconds: number;
    }
    | {
        readonly type: "WAIT_CURRENT_FRAGMENT_TIME";
        readonly targetElapsedSeconds: number;
    }
    | {
        readonly type: "WAIT_CURRENT_WAVE_TIME";
        readonly targetElapsedSeconds: number;
    }
    | {
        readonly type: "WAIT_BOSSRUSH_WAVE";
        readonly bossWaveDelta: number;
    }
    | {
        readonly type: "DISAPPEAR";
    }
    | {
        readonly type: "APPEAR_AT_POS";
        readonly position: TilePosition;
        readonly reachOffset: WorldOffset;
    }
    | {
        readonly type: "ALERT";
    };

export interface RouteDefinition {
    readonly pathMotionMode: PathMotionMode;
    readonly startPosition: TilePosition;
    readonly endPosition: TilePosition;
    readonly spawnOffset: WorldOffset;
    readonly spawnRandomRange: WorldOffset;
    readonly checkpoints: readonly RouteCheckpoint[];
    readonly allowDiagonalMove: boolean;
    readonly visitEveryTileCenter: boolean;
    readonly visitEveryNodeCenter: boolean;
    readonly visitEveryCheckPoint: boolean;
}
