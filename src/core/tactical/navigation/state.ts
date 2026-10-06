import { createWorldOffset, createWorldPosition, isWorldPosition } from "../geometry/coordinate.js";
import type { WorldOffset, WorldPosition } from "../geometry/coordinate.js";
import {
    initializeNavigationCursor,
    selectNavigationPredictionTarget,
    selectNavigationSteeringTarget,
} from "./execute.js";
import { PathMotionMode } from "./map.js";
import type {
    NavigationCursorInitialization,
    NavigationFailureReason,
    NavigationPath,
    NavigationPathCursor,
    NavigationPredictionSelection,
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
    pathMotionMode: PathMotionMode;
    execution: NavigationExecution;
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

export interface NavigationPrediction {
    readonly state: NavigationState;
    readonly selection: NavigationPredictionSelection;
}

export interface NavigationSteering {
    readonly state: NavigationState;
    readonly selection: NavigationSelection;
    readonly outcomes: readonly NavigationOutcome[];
}

type ActiveNavigation = Extract<NavigationActivity, { readonly path: NavigationPath }>;

function activeNavigation(state: NavigationState): ActiveNavigation {
    const activity = state.execution.activity;
    if (activity.type !== "FOLLOWING" && activity.type !== "UNREACHABLE") {
        throw new Error("navigation requires an installed path");
    }
    return activity;
}

function requestOf(activity: NavigationActivity): NavigationRequest {
    if (activity.type === "IDLE") {
        throw new Error("navigation has no current request");
    }
    return activity.type === "FOLLOWING" || activity.type === "UNREACHABLE"
        ? activity.path.request
        : activity.request;
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
    return state.execution.activity.type === "IDLE" ? state : updateExecution(state, { type: "IDLE" });
}

export function markNavigationArrived(state: NavigationState): NavigationState {
    return state.execution.activity.type === "ARRIVED"
        ? state
        : updateExecution(state, { type: "ARRIVED", request: requestOf(state.execution.activity) });
}

export function bindNavigationPath(
    state: NavigationState,
    path: NavigationPath,
    position: WorldPosition,
): NavigationBinding {
    const request = requestOf(state.execution.activity);
    if (path.request.id !== request.id) {
        throw new RangeError("navigation path belongs to a different request");
    }
    if (path.field.map.pathMotionMode !== state.pathMotionMode) {
        throw new RangeError("navigation map does not match the current motion mode");
    }
    const initialization = initializeNavigationCursor(path, position, state.execution.locatorOffset);
    const next = initialization.type === "READY"
        ? updateExecution(state, { type: "FOLLOWING", path, cursor: initialization.cursor })
        : updateExecution(state, { type: "NEEDS_PATH", request });
    return { state: next, initialization };
}

export function setNavigationMotionMode(
    state: NavigationState,
    pathMotionMode: PathMotionMode,
): NavigationState {
    if (pathMotionMode === state.pathMotionMode) return state;
    const activity = state.execution.activity;
    const next = activity.type === "FOLLOWING" || activity.type === "UNREACHABLE"
        ? updateExecution(state, { type: "NEEDS_PATH", request: activity.path.request })
        : state;
    return { pathMotionMode, execution: next.execution };
}

export function predictNavigation(
    state: NavigationState,
    position: WorldPosition,
): NavigationPrediction {
    const activity = activeNavigation(state);
    const selection = selectNavigationPredictionTarget(
        activity.path,
        activity.cursor,
        state.execution.visits,
        position,
        state.execution.locatorOffset,
    );
    return {
        state: updateExecution(state, { ...activity, cursor: selection.cursor }, selection.visits),
        selection,
    };
}

export function steerNavigation(
    state: NavigationState,
    position: WorldPosition,
): NavigationSteering {
    const activity = activeNavigation(state);
    const selection = selectNavigationSteeringTarget(
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
        case "ARRIVED":
            nextActivity = { type: "ARRIVED", request: activity.path.request };
            outcomes.push({ type: "ARRIVED", requestId });
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
