import { Tile, World } from "../geometry/coordinate.js";
import type { TilePosition, WorldPosition } from "../geometry/coordinate.js";
import type { NavigationGoal } from "../navigation/request.js";
import { nextCheckpointIndex } from "./execution.js";
import type { RouteState } from "./state.js";

export type RoutePredictionTarget =
    | {
          readonly type: "CHECKPOINT_TARGET";
          readonly checkpointIndex: number;
          readonly targetTile: TilePosition;
          readonly goal: NavigationGoal;
      }
    | {
          readonly type: "END_TARGET";
          readonly targetTile: TilePosition;
          readonly goal: NavigationGoal;
      }
    | { readonly type: "COMPLETED" };

export function predictRouteTarget(state: Readonly<RouteState>): RoutePredictionTarget {
    const progress = state.progress;
    if (progress.phase === "COMPLETED") {
        return { type: "COMPLETED" };
    }
    if (progress.phase === "CHECKPOINTS") {
        let index = progress.checkpointIndex;
        while (index < state.definition.checkpoints.length) {
            const checkpoint = state.definition.checkpoints[index]!;
            switch (checkpoint.type) {
                case "MOVE":
                case "PATROL_MOVE":
                case "MAP_OFFSET_MOVE": {
                    const goal =
                        index === progress.checkpointIndex && progress.checkpoint.type === "MOVE"
                            ? progress.checkpoint.goal
                            : {
                                  position:
                                      checkpoint.type === "MAP_OFFSET_MOVE"
                                          ? World.translate(
                                                Tile.center(checkpoint.target.position),
                                                checkpoint.target.reachOffset,
                                            )
                                          : Tile.center(checkpoint.target.position),
                                  reachDistance: Math.max(checkpoint.target.reachDistance, 0.05),
                              };
                    return {
                        type: "CHECKPOINT_TARGET",
                        checkpointIndex: index,
                        targetTile: checkpoint.target.position,
                        goal,
                    };
                }
                default:
                    index = nextCheckpointIndex(state.definition, index);
            }
        }
    }
    return {
        type: "END_TARGET",
        targetTile: state.definition.endPosition,
        goal:
            progress.phase === "END"
                ? progress.move.goal
                : { position: Tile.center(state.definition.endPosition), reachDistance: 0.05 },
    };
}

export function isRouteEndReached(
    state: Readonly<RouteState>,
    locatorPosition: WorldPosition,
): boolean {
    const progress = state.progress;
    if (progress.phase === "COMPLETED") {
        return true;
    }
    if (
        state.definition.visitEveryCheckPoint &&
        progress.phase === "CHECKPOINTS" &&
        progress.checkpointIndex < state.definition.checkpoints.length
    ) {
        return false;
    }
    const end = state.definition.endPosition;
    const tile = World.toTile(locatorPosition);
    return (
        tile[0] === end[0] &&
        tile[1] === end[1] &&
        World.withinDistance(locatorPosition, Tile.center(end), 0.05)
    );
}

export function isRouteCheckpointReady(state: Readonly<RouteState>): boolean {
    const progress = state.progress;
    if (progress.phase !== "CHECKPOINTS") {
        return false;
    }
    return (
        progress.checkpoint.type === "ENTERED" ||
        (progress.checkpoint.type === "WAIT" && progress.checkpoint.remainingTicks <= 0)
    );
}

export function isRouteMoveCheckpointReached(
    state: Readonly<RouteState>,
    locatorPosition: WorldPosition,
    spatiallyReachable: boolean,
): boolean {
    const progress = state.progress;
    if (progress.phase !== "CHECKPOINTS" || progress.checkpoint.type !== "MOVE") {
        return false;
    }
    if (!state.alwaysCheckCurrentPoint && !spatiallyReachable) {
        return true;
    }
    return World.withinDistance(
        locatorPosition,
        progress.checkpoint.goal.position,
        progress.checkpoint.goal.reachDistance,
    );
}
