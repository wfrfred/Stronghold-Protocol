import {
    createTilePosition,
    createWorldOffset,
    createWorldPosition,
    isWorldPosition,
    type WorldOffset,
    type WorldPosition,
} from "../../geometry/coordinate.js";
import { initializeNavigationCursor, selectNavigationTarget } from "./query.js";
import { NavigationMap, PathMotionMode } from "./map.js";
import type {
    NavigationCursorInitialization,
    NavigationFailureReason,
    NavigationPath,
    NavigationPathCursor,
    NavigationSelection,
    NavigationVisitHistory,
} from "./path.js";
import type { NavigationRequest, NavigationRequestId } from "./request.js";

export type NavigationActivity =
    | {
          readonly type: "IDLE";
      }
    | {
          readonly type: "NEEDS_PATH";
          readonly request: NavigationRequest;
      }
    | {
          readonly type: "FOLLOWING";
          readonly path: NavigationPath;
          readonly cursor: NavigationPathCursor;
      }
    | {
          readonly type: "ARRIVED";
          readonly request: NavigationRequest;
      }
    | {
          readonly type: "UNREACHABLE";
          readonly path: NavigationPath;
          readonly cursor: NavigationPathCursor;
          readonly position: WorldPosition;
          readonly reason: NavigationFailureReason;
      };

export interface NavigationExecution {
    readonly locatorOffset: WorldOffset;
    readonly visits: NavigationVisitHistory;
    readonly activity: NavigationActivity;
}

export interface NavigationState {
    readonly pathMotionMode: PathMotionMode;
    readonly execution: NavigationExecution;
}

export type NavigationOutcome =
    | {
          readonly type: "ARRIVED";
          readonly requestId: NavigationRequestId;
      }
    | {
          readonly type: "UNREACHABLE";
          readonly requestId: NavigationRequestId;
          readonly reason: NavigationFailureReason;
      };

export interface NavigationBinding {
    readonly state: NavigationState;
    readonly initialization: NavigationCursorInitialization;
}

export interface NavigationQuery {
    readonly state: NavigationState;
    readonly selection: NavigationSelection;
    readonly outcomes: readonly NavigationOutcome[];
}

type ActiveNavigation = Extract<NavigationActivity, { readonly type: "FOLLOWING" | "UNREACHABLE" }>;

function activeNavigation(state: NavigationState): ActiveNavigation {
    const activity = state.execution.activity;

    if (activity.type !== "FOLLOWING" && activity.type !== "UNREACHABLE") {
        throw new Error("navigation requires an installed path");
    }

    return activity;
}

export function getNavigationRequest(state: Readonly<NavigationState>): NavigationRequest | null {
    const activity = state.execution.activity;

    if (activity.type === "IDLE") {
        return null;
    }

    return activity.type === "FOLLOWING" || activity.type === "UNREACHABLE"
        ? activity.path.request
        : activity.request;
}

function copyCursor(cursor: NavigationPathCursor): NavigationPathCursor {
    if (cursor.type !== "FIELD") {
        return { ...cursor };
    }

    return {
        ...cursor,
        nextNode: Object.isFrozen(cursor.nextNode)
            ? cursor.nextNode
            : createTilePosition(...cursor.nextNode),
    };
}

function copyActivity(activity: NavigationActivity): NavigationActivity {
    if (activity.type === "UNREACHABLE") {
        return {
            ...activity,
            cursor: copyCursor(activity.cursor),
            position: Object.isFrozen(activity.position)
                ? activity.position
                : createWorldPosition(...activity.position),
        };
    }
    if (activity.type === "FOLLOWING") {
        return { ...activity, cursor: copyCursor(activity.cursor) };
    }

    return { ...activity };
}

export function copyNavigationState(state: Readonly<NavigationState>): NavigationState {
    const activity = copyActivity(state.execution.activity);

    return {
        ...state,
        execution: {
            ...state.execution,
            locatorOffset: Object.isFrozen(state.execution.locatorOffset)
                ? state.execution.locatorOffset
                : createWorldOffset(...state.execution.locatorOffset),
            visits: {
                ...state.execution.visits,
                visitedCenters: state.execution.visits.visitedCenters.map((position) =>
                    Object.isFrozen(position) ? position : createTilePosition(...position),
                ),
            },
            activity,
        },
    };
}

function updateExecution(
    state: NavigationState,
    activity: NavigationActivity,
    visits: NavigationVisitHistory = state.execution.visits,
): NavigationState {
    return {
        pathMotionMode: state.pathMotionMode,
        execution: {
            locatorOffset: state.execution.locatorOffset,
            visits,
            activity,
        },
    };
}

export function createNavigationState(
    pathMotionMode: PathMotionMode,
    locatorOffset: WorldOffset,
): NavigationState {
    if (!PathMotionMode.is(pathMotionMode)) {
        throw new TypeError("invalid path motion mode");
    }
    if (!isWorldPosition(locatorOffset)) {
        throw new RangeError("locator offset must be a valid world pair");
    }

    return {
        pathMotionMode,
        execution: {
            locatorOffset: createWorldOffset(locatorOffset[0], locatorOffset[1]),
            visits: { visitedCenters: [] },
            activity: { type: "IDLE" },
        },
    };
}

export function startNavigationRequest(
    state: NavigationState,
    request: NavigationRequest,
): NavigationState {
    return updateExecution(state, { type: "NEEDS_PATH", request });
}

export function clearNavigationRequest(state: NavigationState): NavigationState {
    return state.execution.activity.type === "IDLE"
        ? state
        : updateExecution(state, { type: "IDLE" });
}

export function invalidateNavigationPath(
    state: NavigationState,
    map: NavigationMap,
): NavigationState {
    const activity = state.execution.activity;

    return (activity.type === "FOLLOWING" || activity.type === "UNREACHABLE") &&
        activity.path.field.map !== map
        ? startNavigationRequest(state, activity.path.request)
        : state;
}

export function markNavigationArrived(state: NavigationState): NavigationState {
    if (state.execution.activity.type === "ARRIVED") {
        return state;
    }

    const request = getNavigationRequest(state);

    if (request === null) {
        throw new Error("navigation has no current request");
    }

    return updateExecution(state, { type: "ARRIVED", request });
}

export function bindNavigationPath(
    state: NavigationState,
    path: NavigationPath,
    position: WorldPosition,
): NavigationBinding {
    const request = getNavigationRequest(state);

    if (request === null) {
        throw new Error("navigation has no current request");
    }
    if (path.request.id !== request.id) {
        throw new RangeError("navigation path belongs to a different request");
    }
    if (path.field.map.pathMotionMode !== state.pathMotionMode) {
        throw new RangeError("navigation map does not match the current motion mode");
    }

    const initialization = initializeNavigationCursor(
        path,
        position,
        state.execution.locatorOffset,
    );
    const next =
        initialization.type === "READY"
            ? updateExecution(state, { type: "FOLLOWING", path, cursor: initialization.cursor })
            : updateExecution(state, { type: "NEEDS_PATH", request });

    return { state: next, initialization };
}

export function setNavigationMotionMode(
    state: NavigationState,
    pathMotionMode: PathMotionMode,
): NavigationState {
    if (pathMotionMode === state.pathMotionMode) {
        return state;
    }

    const activity = state.execution.activity;
    let next = state;

    if (activity.type === "FOLLOWING" || activity.type === "UNREACHABLE") {
        next = updateExecution(state, { type: "NEEDS_PATH", request: activity.path.request });
    }

    return { pathMotionMode, execution: next.execution };
}

export function queryNavigation(state: NavigationState, position: WorldPosition): NavigationQuery {
    const activity = activeNavigation(state);
    const selection = selectNavigationTarget(
        activity.path,
        activity.cursor,
        state.execution.visits,
        position,
        state.execution.locatorOffset,
    );
    const requestId = activity.path.request.id;
    const outcomes: NavigationOutcome[] = [];
    let nextActivity: NavigationActivity;

    switch (selection.decision.type) {
        case "MOVE":
            nextActivity = { type: "FOLLOWING", path: activity.path, cursor: selection.cursor };
            break;

        case "ARRIVAL_CANDIDATE":
            nextActivity = { type: "FOLLOWING", path: activity.path, cursor: selection.cursor };
            break;

        case "UNREACHABLE": {
            const reason = selection.decision.reason;
            nextActivity = {
                type: "UNREACHABLE",
                path: activity.path,
                cursor: selection.cursor,
                position: createWorldPosition(position[0], position[1]),
                reason,
            };

            if (activity.type !== "UNREACHABLE" || activity.reason !== reason) {
                outcomes.push({ type: "UNREACHABLE", requestId, reason });
            }

            break;
        }

        case "OUTSIDE_MAP":
            nextActivity = { ...activity, cursor: selection.cursor };
            break;
    }

    return {
        state: updateExecution(state, nextActivity, selection.visits),
        selection,
        outcomes,
    };
}
