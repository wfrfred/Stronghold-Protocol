import {
    createTilePosition,
    createWorldOffset,
    isTilePosition,
    isWorldPosition,
    type TilePosition,
    type WorldOffset,
} from "../../../../geometry/coordinate.js";
import { PathMotionMode } from "../../../../battlefield/navigation/map.js";

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
          readonly type: "WAIT_FOR_TICKS";
          readonly durationTicks: number;
      }
    | {
          readonly type: "WAIT_FOR_PLAY_TICK";
          readonly targetPlayTick: number;
      }
    | {
          readonly type: "WAIT_CURRENT_FRAGMENT_TICKS";
          readonly targetElapsedTicks: number;
      }
    | {
          readonly type: "WAIT_CURRENT_WAVE_TICKS";
          readonly targetElapsedTicks: number;
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

function copyPosition(position: TilePosition): TilePosition {
    if (!isTilePosition(position)) {
        throw new TypeError("route position must contain two coordinates");
    }

    return createTilePosition(position[0], position[1]);
}

function copyOffset(offset: WorldOffset): WorldOffset {
    if (!isWorldPosition(offset)) {
        throw new TypeError("route offset must contain two coordinates");
    }

    return createWorldOffset(offset[0], offset[1]);
}

function finite(value: number, name: string): number {
    if (!Number.isFinite(value)) {
        throw new RangeError(`${name} must be finite`);
    }

    return value;
}

function ticks(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
    }

    return value;
}

function boolean(value: boolean, name: string): boolean {
    if (typeof value !== "boolean") {
        throw new TypeError(`${name} must be boolean`);
    }

    return value;
}

function copyTarget(target: RouteMoveTarget): RouteMoveTarget {
    const value: unknown = target;

    if (value === null || typeof value !== "object") {
        throw new TypeError("route move target must be an object");
    }

    return Object.freeze({
        position: copyPosition(target.position),
        reachOffset: copyOffset(target.reachOffset),
        randomizeReachOffset: boolean(target.randomizeReachOffset, "randomizeReachOffset"),
        reachDistance: finite(target.reachDistance, "reachDistance"),
    });
}

function copyCheckpoint(checkpoint: RouteCheckpoint): RouteCheckpoint {
    const value: unknown = checkpoint;

    if (value === null || typeof value !== "object") {
        throw new TypeError("route checkpoint must be an object");
    }

    switch (checkpoint.type) {
        case "MOVE":
        case "PATROL_MOVE":
        case "MAP_OFFSET_MOVE":
            return Object.freeze({ type: checkpoint.type, target: copyTarget(checkpoint.target) });

        case "WAIT_FOR_TICKS":
            return Object.freeze({
                type: checkpoint.type,
                durationTicks: ticks(checkpoint.durationTicks, "durationTicks"),
            });

        case "WAIT_FOR_PLAY_TICK":
            return Object.freeze({
                type: checkpoint.type,
                targetPlayTick: ticks(checkpoint.targetPlayTick, "targetPlayTick"),
            });

        case "WAIT_CURRENT_FRAGMENT_TICKS":
        case "WAIT_CURRENT_WAVE_TICKS":
            return Object.freeze({
                type: checkpoint.type,
                targetElapsedTicks: ticks(checkpoint.targetElapsedTicks, "targetElapsedTicks"),
            });

        case "APPEAR_AT_POS":
            return Object.freeze({
                type: checkpoint.type,
                position: copyPosition(checkpoint.position),
                reachOffset: copyOffset(checkpoint.reachOffset),
            });

        case "DISAPPEAR":
        case "ALERT":
            return Object.freeze({ type: checkpoint.type });

        default:
            throw new RangeError("unsupported route checkpoint type");
    }
}

export function createRouteDefinition(definition: RouteDefinition): RouteDefinition {
    if (!PathMotionMode.is(definition.pathMotionMode)) {
        throw new RangeError("unsupported route path motion mode");
    }

    const checkpointsAreArray: boolean = Array.isArray(definition.checkpoints);

    if (!checkpointsAreArray) {
        throw new TypeError("route checkpoints must be an array");
    }

    const checkpoints: RouteCheckpoint[] = [];

    for (let index = 0; index < definition.checkpoints.length; index++) {
        const checkpoint = definition.checkpoints[index];

        if (!Object.hasOwn(definition.checkpoints, index) || checkpoint === undefined) {
            throw new TypeError("route checkpoints must be dense");
        }

        checkpoints.push(copyCheckpoint(checkpoint));
    }

    return Object.freeze({
        pathMotionMode: definition.pathMotionMode,
        startPosition: copyPosition(definition.startPosition),
        endPosition: copyPosition(definition.endPosition),
        spawnOffset: copyOffset(definition.spawnOffset),
        spawnRandomRange: copyOffset(definition.spawnRandomRange),
        checkpoints: Object.freeze(checkpoints),
        allowDiagonalMove: boolean(definition.allowDiagonalMove, "allowDiagonalMove"),
        visitEveryTileCenter: boolean(definition.visitEveryTileCenter, "visitEveryTileCenter"),
        visitEveryNodeCenter: boolean(definition.visitEveryNodeCenter, "visitEveryNodeCenter"),
        visitEveryCheckPoint: boolean(definition.visitEveryCheckPoint, "visitEveryCheckPoint"),
    });
}
