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

export type NavigationArrivalRule =
    | "DISTANCE"
    | "TARGET_TILE_AND_DISTANCE";

export interface NavigationRequest {
    readonly id: NavigationRequestId;
    readonly targetTile: TilePosition;
    readonly goal: NavigationGoal;
    readonly options: NavigationOptions;
    readonly arrivalRule: NavigationArrivalRule;
}
