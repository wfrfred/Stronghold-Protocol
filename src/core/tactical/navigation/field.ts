import type { TilePosition } from "../geometry/coordinate.js";
import type { NavigationMap } from "./map.js";
import type { NavigationRequest } from "./request.js";

export interface NavigationFieldQuery {
    readonly targetTile: TilePosition;
    readonly allowDiagonalMove: boolean;
}

export type NavigationFieldNode =
    | {
        readonly type: "UNREACHABLE";
    }
    | {
        readonly type: "TARGET";
        readonly distance: 0;
    }
    | {
        readonly type: "REACHABLE";
        readonly distance: number;
        readonly rawNext: TilePosition;
        readonly next: TilePosition;
    };

export interface NavigationField {
    readonly map: NavigationMap;
    readonly query: NavigationFieldQuery;
    readonly nodes: readonly NavigationFieldNode[];
}

export function deriveNavigationFieldQuery(
    request: NavigationRequest,
): NavigationFieldQuery {
    const [row, col] = request.targetTile;

    return {
        targetTile: [row, col],
        allowDiagonalMove: request.options.allowDiagonalMove,
    };
}
