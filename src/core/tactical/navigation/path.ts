import type { TilePosition, WorldPosition } from "../geometry/coordinate.js";
import type { NavigationField } from "./field.js";
import type { NavigationIntent, NavigationRequest } from "./request.js";

export interface NavigationPath<I extends NavigationIntent = NavigationRequest> {
    readonly request: I;
    readonly field: NavigationField;
}

export type NavigationPathCursor =
    | {
          readonly type: "FIELD";
          readonly nextNode: TilePosition;
      }
    | {
          readonly type: "GOAL";
      };

export interface NavigationVisitHistory {
    readonly visitedCenters: readonly TilePosition[];
}

export type NavigationFailureReason = "TARGET_UNREACHABLE" | "POSITION_UNREACHABLE";

export type NavigationPathDecision =
    | {
          readonly type: "MOVE";
          readonly target: WorldPosition;
      }
    | {
          readonly type: "ARRIVED";
      }
    | {
          readonly type: "UNREACHABLE";
          readonly reason: NavigationFailureReason;
      }
    | {
          readonly type: "OUTSIDE_MAP";
      };

export interface NavigationSelection {
    readonly cursor: NavigationPathCursor;
    readonly visits: NavigationVisitHistory;
    readonly decision: NavigationPathDecision;
}

export type NavigationCursorInitialization =
    | {
          readonly type: "READY";
          readonly cursor: NavigationPathCursor;
      }
    | {
          readonly type: "OUTSIDE_MAP";
      };

export interface NavigationPredictionSelection {
    readonly cursor: NavigationPathCursor;
    readonly visits: NavigationVisitHistory;
    readonly decision:
        | {
              readonly type: "TARGET";
              readonly target: WorldPosition;
          }
        | {
              readonly type: "OUTSIDE_MAP";
          };
}

export function createNavigationPath<I extends NavigationIntent>(
    request: I,
    field: NavigationField,
): NavigationPath<I> {
    if (
        field.query.targetTile[0] !== request.targetTile[0] ||
        field.query.targetTile[1] !== request.targetTile[1] ||
        field.query.allowDiagonalMove !== request.options.allowDiagonalMove
    ) {
        throw new RangeError("navigation field does not match the request");
    }

    return Object.freeze({ request, field });
}
