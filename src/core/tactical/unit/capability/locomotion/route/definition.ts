import { assertFiniteNumber, assertNonnegativeSafeInteger } from "../../../../../common/assert.js";
import {
    createTilePosition,
    createWorldOffset,
    type TilePosition,
    type WorldOffset,
} from "../../../../geometry/coordinate.js";
import type { PathMotionMode } from "../../../../battlefield/navigation/map.js";

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
    return createTilePosition(position[0], position[1]);
}

function copyOffset(offset: WorldOffset): WorldOffset {
    return createWorldOffset(offset[0], offset[1]);
}

function copyTarget(target: RouteMoveTarget): RouteMoveTarget {
    assertFiniteNumber(target.reachDistance, "reachDistance");

    return Object.freeze({
        position: copyPosition(target.position),
        reachOffset: copyOffset(target.reachOffset),
        randomizeReachOffset: target.randomizeReachOffset,
        reachDistance: target.reachDistance,
    });
}

function copyCheckpoint(checkpoint: RouteCheckpoint): RouteCheckpoint {
    switch (checkpoint.type) {
        case "MOVE":
        case "PATROL_MOVE":
        case "MAP_OFFSET_MOVE":
            return Object.freeze({ type: checkpoint.type, target: copyTarget(checkpoint.target) });

        case "WAIT_FOR_TICKS":
            assertNonnegativeSafeInteger(checkpoint.durationTicks, "durationTicks");

            return Object.freeze({
                type: checkpoint.type,
                durationTicks: checkpoint.durationTicks,
            });

        case "WAIT_FOR_PLAY_TICK":
            assertNonnegativeSafeInteger(checkpoint.targetPlayTick, "targetPlayTick");

            return Object.freeze({
                type: checkpoint.type,
                targetPlayTick: checkpoint.targetPlayTick,
            });

        case "WAIT_CURRENT_FRAGMENT_TICKS":
        case "WAIT_CURRENT_WAVE_TICKS":
            assertNonnegativeSafeInteger(checkpoint.targetElapsedTicks, "targetElapsedTicks");

            return Object.freeze({
                type: checkpoint.type,
                targetElapsedTicks: checkpoint.targetElapsedTicks,
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
    }
}

export function createRouteDefinition(definition: RouteDefinition): RouteDefinition {
    const checkpoints: RouteCheckpoint[] = [];

    for (let index = 0; index < definition.checkpoints.length; index++) {
        if (!Object.hasOwn(definition.checkpoints, index)) {
            throw new TypeError("route checkpoints must be dense");
        }

        checkpoints.push(copyCheckpoint(definition.checkpoints[index]!));
    }

    return Object.freeze({
        pathMotionMode: definition.pathMotionMode,
        startPosition: copyPosition(definition.startPosition),
        endPosition: copyPosition(definition.endPosition),
        spawnOffset: copyOffset(definition.spawnOffset),
        spawnRandomRange: copyOffset(definition.spawnRandomRange),
        checkpoints: Object.freeze(checkpoints),
        allowDiagonalMove: definition.allowDiagonalMove,
        visitEveryTileCenter: definition.visitEveryTileCenter,
        visitEveryNodeCenter: definition.visitEveryNodeCenter,
        visitEveryCheckPoint: definition.visitEveryCheckPoint,
    });
}
