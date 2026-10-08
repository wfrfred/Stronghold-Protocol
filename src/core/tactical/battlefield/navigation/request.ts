import { assertNonnegativeNumber, assertNonnegativeSafeInteger } from "../../../common/assert.js";
import {
    createTilePosition,
    createWorldPosition,
    World,
    type TilePosition,
    type WorldPosition,
} from "../../geometry/coordinate.js";

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
    assertNonnegativeSafeInteger(request.id, "navigation request id");

    const [row, col] = request.targetTile;
    const [x, y] = request.goal.position;

    assertNonnegativeNumber(request.goal.reachDistance, "navigation reach distance");

    const options = request.options;

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
