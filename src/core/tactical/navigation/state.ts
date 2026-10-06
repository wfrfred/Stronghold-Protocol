import { createWorldOffset, isWorldPosition } from "../geometry/coordinate.js";
import type { WorldOffset, WorldPosition } from "../geometry/coordinate.js";
import { PathMotionMode } from "./map.js";
import type {
    NavigationFailureReason,
    NavigationPath,
    NavigationPathCursor,
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
        execution: Object.freeze({
            locatorOffset: createWorldOffset(locatorOffset[0], locatorOffset[1]),
            visits: Object.freeze({ visitedCenters: Object.freeze([]) }),
            activity: Object.freeze({ type: "IDLE" }),
        }),
    };
}
