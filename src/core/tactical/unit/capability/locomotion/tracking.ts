import {
    World,
    createWorldOffset,
    type WorldOffset,
    type WorldPosition,
} from "../../../geometry/coordinate.js";
import * as navigation from "../../../battlefield/navigation/state.js";
import { apply } from "../../../battlefield/navigation/apply.js";
import {
    isNavigationGoalReached,
    type NavigationRequest,
    type NavigationRequestId,
} from "./route/request.js";

type FailureReason = "TARGET_UNREACHABLE" | "POSITION_UNREACHABLE";

export type Activity =
    | { readonly type: "IDLE" }
    | { readonly type: "FOLLOWING"; readonly request: NavigationRequest }
    | { readonly type: "ARRIVED"; readonly request: NavigationRequest }
    | {
          readonly type: "UNREACHABLE";
          readonly request: NavigationRequest;
          readonly position: WorldPosition;
          readonly reason: FailureReason;
      };

export interface State {
    readonly pathMotionMode: navigation.MotionMode;
    readonly execution: {
        readonly locatorOffset: WorldOffset;
        readonly activity: Activity;
    };
}

export type Outcome =
    | { readonly type: "ARRIVED"; readonly requestId: NavigationRequestId }
    | {
          readonly type: "UNREACHABLE";
          readonly requestId: NavigationRequestId;
          readonly reason: FailureReason;
      };

export type Decision =
    | { readonly type: "MOVE" | "ARRIVAL_CANDIDATE"; readonly target: WorldPosition }
    | { readonly type: "UNREACHABLE"; readonly reason: FailureReason }
    | { readonly type: "OUTSIDE_MAP" };

export function create(pathMotionMode: navigation.MotionMode, locatorOffset: WorldOffset): State {
    return {
        pathMotionMode,
        execution: {
            locatorOffset: createWorldOffset(locatorOffset[0], locatorOffset[1]),
            activity: { type: "IDLE" },
        },
    };
}

export function getRequest(state: State): NavigationRequest | null {
    return state.execution.activity.type === "IDLE" ? null : state.execution.activity.request;
}

function update(state: State, activity: Activity): State {
    return activity === state.execution.activity
        ? state
        : { ...state, execution: { ...state.execution, activity } };
}

export function start(state: State, request: NavigationRequest): State {
    return update(state, { type: "FOLLOWING", request });
}

export function clear(state: State): State {
    return state.execution.activity.type === "IDLE" ? state : update(state, { type: "IDLE" });
}

export function arrive(state: State): State {
    if (state.execution.activity.type === "ARRIVED") {
        return state;
    }

    const request = getRequest(state);

    if (request === null) {
        throw new Error("route has no current movement request");
    }

    return update(state, { type: "ARRIVED", request });
}

export function setMotionMode(state: State, pathMotionMode: navigation.MotionMode): State {
    return state.pathMotionMode === pathMotionMode ? state : { ...state, pathMotionMode };
}

export function query(
    state: State,
    environment: navigation.State,
    position: WorldPosition,
): { readonly state: State; readonly decision: Decision; readonly outcomes: readonly Outcome[] } {
    const activity = state.execution.activity;

    if (activity.type !== "FOLLOWING" && activity.type !== "UNREACHABLE") {
        throw new Error("route has no active movement request");
    }

    const locator = World.translate(position, state.execution.locatorOffset);
    const mode = state.pathMotionMode;

    if (!environment.baseline[mode].contains(World.toTile(locator))) {
        return { state, decision: { type: "OUTSIDE_MAP" }, outcomes: [] };
    }

    const request = activity.request;
    const point = navigation.nextPoint(environment, mode, locator, request.goal.position);

    if (point === null) {
        const map = apply(environment.baseline[mode], environment.overlays[mode]);
        const reason = map.get(World.toTile(request.goal.position))?.passable
            ? "POSITION_UNREACHABLE"
            : "TARGET_UNREACHABLE";
        const unchanged = activity.type === "UNREACHABLE" && activity.reason === reason;
        const next =
            unchanged &&
            activity.position[0] === position[0] &&
            activity.position[1] === position[1]
                ? state
                : update(state, { type: "UNREACHABLE", request, position, reason });

        return {
            state: next,
            decision: { type: "UNREACHABLE", reason },
            outcomes: unchanged ? [] : [{ type: "UNREACHABLE", requestId: request.id, reason }],
        };
    }

    return {
        state: activity.type === "FOLLOWING" ? state : start(state, request),
        decision: {
            type: isNavigationGoalReached(request, locator) ? "ARRIVAL_CANDIDATE" : "MOVE",
            target: World.translate(point, World.negate(state.execution.locatorOffset)),
        },
        outcomes: [],
    };
}
