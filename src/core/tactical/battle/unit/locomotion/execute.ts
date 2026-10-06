import { createRng } from "../../../../common/rng.js";
import type { Seed } from "../../../../common/rng.js";
import { World } from "../../../geometry/coordinate.js";
import type { WorldPosition } from "../../../geometry/coordinate.js";
import type { NavigationFieldCache } from "../../../navigation/cache.js";
import type { NavigationMap, PathMotionMode } from "../../../navigation/map.js";
import { createNavigationPath } from "../../../navigation/path.js";
import { isNavigationGoalReached } from "../../../navigation/request.js";
import type { NavigationRequest, NavigationRequestId } from "../../../navigation/request.js";
import {
    bindNavigationPath,
    clearNavigationRequest,
    markNavigationArrived,
    predictNavigation,
    startNavigationRequest,
    steerNavigation,
} from "../../../navigation/state.js";
import type { NavigationOutcome, NavigationState } from "../../../navigation/state.js";
import { advanceRoute, enterRoute, tickRouteWait } from "../../../route/execute.js";
import type { RouteExecutionContext, RouteTransition } from "../../../route/execute.js";
import type { RouteClock, RouteState } from "../../../route/progress.js";
import type { RoutedLocomotionState } from "../capabilities/locomotion.js";
import { integrateSteering } from "./integrate.js";
import type { SteeringParameters } from "./steering.js";

export interface RoutedLocomotionStepContext {
    readonly clock: RouteClock;
    readonly maps: Readonly<Record<PathMotionMode, NavigationMap>>;
    readonly fieldCache: NavigationFieldCache;
    readonly moveMultiplier: number;
    readonly steeringParameters: SteeringParameters;
    readonly movementAllowed: boolean;
    readonly routeAdvanceAllowed: boolean;
    readonly rngState: Seed;
    readonly nextNavigationRequestId: NavigationRequestId;
}

export interface RoutedLocomotionStep {
    readonly state: RoutedLocomotionState;
    readonly position: WorldPosition;
    readonly rngState: Seed;
    readonly nextNavigationRequestId: NavigationRequestId;
    readonly outcomes: readonly NavigationOutcome[];
}

function isMovingRoute(route: RouteState): boolean {
    return route.progress.phase === "END"
        || (route.progress.phase === "CHECKPOINTS" && route.progress.checkpoint.type === "MOVE");
}

function currentRequest(navigation: NavigationState): NavigationRequest {
    const activity = navigation.execution.activity;
    switch (activity.type) {
        case "FOLLOWING":
        case "UNREACHABLE":
            return activity.path.request;
        case "NEEDS_PATH":
        case "ARRIVED":
            return activity.request;
        case "IDLE":
            throw new Error("moving route requires a navigation request");
    }
}

function installTransition(
    navigation: NavigationState,
    transition: RouteTransition,
): NavigationState {
    if (transition.request !== undefined) return startNavigationRequest(navigation, transition.request);
    return isMovingRoute(transition.state) ? navigation : clearNavigationRequest(navigation);
}

function bindCurrentPath(
    navigation: NavigationState,
    position: WorldPosition,
    context: RoutedLocomotionStepContext,
): NavigationState {
    const activity = navigation.execution.activity;
    if (activity.type === "IDLE") throw new Error("cannot bind navigation without a request");
    const map = context.maps[navigation.pathMotionMode];
    if ((activity.type === "FOLLOWING" || activity.type === "UNREACHABLE")
        && activity.path.field.map === map) {
        return navigation;
    }
    const request = currentRequest(navigation);
    const path = createNavigationPath(request, context.fieldCache.get(map, request));
    return bindNavigationPath(navigation, path, position).state;
}

export function stepRoutedLocomotion(
    state: Readonly<RoutedLocomotionState>,
    position: WorldPosition,
    baseMoveSpeed: number,
    context: RoutedLocomotionStepContext,
): RoutedLocomotionStep {
    if (state.alternativeRoute !== null) {
        throw new RangeError("alternative route execution is not supported");
    }
    const rng = createRng(context.rngState);
    let nextNavigationRequestId = context.nextNavigationRequestId;
    const execution: RouteExecutionContext = {
        rng,
        nextNavigationRequestId() {
            const id = nextNavigationRequestId;
            const next = id + 1;
            if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(next)) {
                throw new RangeError("navigation request identity overflow");
            }
            nextNavigationRequestId = next;
            return id;
        },
    };
    const mainRoute = state.mainRoute;
    const initial = enterRoute(mainRoute.route, execution);
    let route = initial.state;
    let navigation = installTransition(mainRoute.navigation, initial);
    const initialPosition = position;
    let steeringState = state.steering;
    const outcomes: NavigationOutcome[] = [];
    const previouslyArrived = mainRoute.navigation.execution.activity.type === "ARRIVED"
        ? mainRoute.navigation.execution.activity.request.id
        : null;
    const moveSpeed = baseMoveSpeed * context.moveMultiplier;
    const stepDistance = moveSpeed * context.clock.deltaTimeSeconds;
    if (!Number.isFinite(moveSpeed) || moveSpeed < 0 || !Number.isFinite(stepDistance)) {
        throw new RangeError("movement budget must be finite and non-negative");
    }

    function advance(): void {
        const transition = advanceRoute(route, execution);
        route = transition.state;
        navigation = installTransition(navigation, transition);
    }

    function reportArrival(requestId: NavigationRequestId): void {
        if (requestId !== previouslyArrived
            && !outcomes.some(outcome => outcome.type === "ARRIVED" && outcome.requestId === requestId)) {
            outcomes.push({ type: "ARRIVED", requestId });
        }
    }

    if (context.movementAllowed && isMovingRoute(route)) {
        navigation = bindCurrentPath(navigation, position, context);
        const activity = navigation.execution.activity;
        if (activity.type === "FOLLOWING" || activity.type === "UNREACHABLE") {
            const prediction = predictNavigation(navigation, position);
            navigation = prediction.state;
            const decision = prediction.selection.decision;
            if (decision.type === "TARGET" && World.withinDistance(position, decision.target, stepDistance)) {
                position = decision.target;
            } else if (decision.type === "TARGET") {
                while (isMovingRoute(route)
                    || (route.progress.phase === "CHECKPOINTS"
                        && route.progress.checkpoint.type === "WAIT"
                        && route.progress.checkpoint.remainingSeconds <= 0)) {
                    if (!isMovingRoute(route)) {
                        if (!context.routeAdvanceAllowed) break;
                        advance();
                        continue;
                    }
                    navigation = bindCurrentPath(navigation, position, context);
                    const current = navigation.execution.activity;
                    if (current.type !== "FOLLOWING" && current.type !== "UNREACHABLE") break;
                    const steering = steerNavigation(navigation, position);
                    navigation = steering.state;
                    for (const outcome of steering.outcomes) {
                        if (outcome.type === "ARRIVED") reportArrival(outcome.requestId);
                        else outcomes.push(outcome);
                    }
                    switch (steering.selection.decision.type) {
                        case "MOVE": {
                            const movement = integrateSteering(
                                steeringState,
                                position,
                                steering.selection.decision.target,
                                moveSpeed,
                                context.clock.deltaTimeSeconds,
                                context.steeringParameters,
                            );
                            position = movement.position;
                            steeringState = movement.state;
                            break;
                        }
                        case "ARRIVED":
                            if (context.routeAdvanceAllowed) {
                                advance();
                                continue;
                            }
                            break;
                        case "UNREACHABLE":
                        case "OUTSIDE_MAP":
                            break;
                    }
                    break;
                }
            }
        }
    }

    route = tickRouteWait(route, context.clock);
    if (route.progress.phase === "CHECKPOINTS"
        && route.progress.checkpoint.type === "WAIT"
        && route.progress.checkpoint.remainingSeconds <= 0) {
        if (context.routeAdvanceAllowed) advance();
    } else if (isMovingRoute(route)) {
        const request = currentRequest(navigation);
        if (isNavigationGoalReached(request, World.translate(position, navigation.execution.locatorOffset))) {
            navigation = markNavigationArrived(navigation);
            reportArrival(request.id);
            if (context.routeAdvanceAllowed) advance();
        }
    }
    return {
        position,
        state: {
            ...state,
            moving: position[0] !== initialPosition[0] || position[1] !== initialPosition[1],
            steering: steeringState,
            mainRoute: { route, navigation },
        },
        rngState: rng.state(),
        nextNavigationRequestId,
        outcomes,
    };
}
