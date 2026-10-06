import {
    createTilePosition,
    createWorldPosition,
    isTilePosition,
    isWorldPosition,
    World,
} from "../geometry/coordinate.js";
import type { TilePosition, WorldPosition } from "../geometry/coordinate.js";

export type NavigationRequestId = number;

export interface NavigationGoal {
    readonly position: WorldPosition;
    readonly reachDistance: number;
}

export interface NavigationOptions {
    readonly allowDiagonalMove: boolean;
    readonly visitEveryTileCenter: boolean;
    readonly visitEveryNodeCenter: boolean;
    readonly visitEveryNodeStably: boolean;
}

export type NavigationArrivalRule = "DISTANCE" | "TARGET_TILE_AND_DISTANCE";

export interface NavigationIntent {
    readonly targetTile: TilePosition;
    readonly goal: NavigationGoal;
    readonly options: NavigationOptions;
    readonly arrivalRule: NavigationArrivalRule;
}

export interface NavigationRequest extends NavigationIntent {
    readonly id: NavigationRequestId;
}

export function isNavigationGoalReached(
    request: NavigationIntent,
    locatorPosition: WorldPosition,
): boolean {
    if (request.arrivalRule === "TARGET_TILE_AND_DISTANCE") {
        const tile = World.toTile(locatorPosition);
        if (tile[0] !== request.targetTile[0] || tile[1] !== request.targetTile[1]) {
            return false;
        }
    }
    return World.withinDistance(locatorPosition, request.goal.position, request.goal.reachDistance);
}

export function createNavigationRequest(request: NavigationRequest): NavigationRequest {
    if (!Number.isSafeInteger(request.id) || request.id < 0) {
        throw new RangeError("navigation request id must be a nonnegative safe integer");
    }
    if (!isTilePosition(request.targetTile) || !isWorldPosition(request.goal.position)) {
        throw new RangeError("navigation coordinates must be valid pairs");
    }
    const [row, col] = request.targetTile;
    const [x, y] = request.goal.position;
    if (!Number.isFinite(request.goal.reachDistance) || request.goal.reachDistance < 0) {
        throw new RangeError("navigation reach distance must be finite and nonnegative");
    }
    if (request.arrivalRule !== "DISTANCE" && request.arrivalRule !== "TARGET_TILE_AND_DISTANCE") {
        throw new TypeError("invalid navigation arrival rule");
    }
    const options = request.options;
    if (
        typeof options.allowDiagonalMove !== "boolean" ||
        typeof options.visitEveryTileCenter !== "boolean" ||
        typeof options.visitEveryNodeCenter !== "boolean" ||
        typeof options.visitEveryNodeStably !== "boolean"
    ) {
        throw new TypeError("navigation options must be explicit booleans");
    }
    return Object.freeze({
        id: request.id,
        targetTile: createTilePosition(row, col),
        goal: Object.freeze({
            position: createWorldPosition(x, y),
            reachDistance: request.goal.reachDistance === 0 ? 0 : request.goal.reachDistance,
        }),
        options: Object.freeze({
            allowDiagonalMove: options.allowDiagonalMove,
            visitEveryTileCenter: options.visitEveryTileCenter,
            visitEveryNodeCenter: options.visitEveryNodeCenter,
            visitEveryNodeStably: options.visitEveryNodeStably,
        }),
        arrivalRule: request.arrivalRule,
    });
}
