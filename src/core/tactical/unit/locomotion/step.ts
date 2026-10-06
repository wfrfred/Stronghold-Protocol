import { createRng } from "../../../common/rng.js";
import type { Seed } from "../../../common/rng.js";
import { World } from "../../geometry/coordinate.js";
import type { WorldPosition } from "../../geometry/coordinate.js";
import type { NavigationFieldCache } from "../../navigation/cache.js";
import type { NavigationMaps } from "../../navigation/map.js";
import { createNavigationPath } from "../../navigation/path.js";
import { isNavigationGoalReached } from "../../navigation/request.js";
import type { NavigationRequestId } from "../../navigation/request.js";
import {
    bindNavigationPath,
    clearNavigationRequest,
    getNavigationRequest,
    markNavigationArrived,
    predictNavigation,
    startNavigationRequest,
    steerNavigation,
} from "../../navigation/state.js";
import type { NavigationOutcome, NavigationState } from "../../navigation/state.js";
import { advanceRoute, createRouteExecution, enterRoute, tickRouteWait } from "../../route/execution.js";
import type { RouteTransition } from "../../route/execution.js";
import type { RouteState } from "../../route/state.js";
import type { RoutedLocomotionState } from "./state.js";
import { integrateSteering } from "./steering.js";
import type { SteeringParameters } from "./steering.js";

export interface RoutedLocomotionStepContext {
    readonly maps: NavigationMaps;
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
    const request = getNavigationRequest(navigation);
    if (request === null) throw new Error("moving route requires a navigation request");
    const path = createNavigationPath(request, context.fieldCache.get(map, request));
    return bindNavigationPath(navigation, path, position).state;
}

export function stepRoutedLocomotion(
    state: Readonly<RoutedLocomotionState>,
    position: WorldPosition,
    baseMoveSpeedPerTick: number,
    context: RoutedLocomotionStepContext,
): RoutedLocomotionStep {
    if (state.alternativeRoute !== null) {
        throw new RangeError("alternative route execution is not supported");
    }
    const execution = createRouteExecution(createRng(context.rngState), context.nextNavigationRequestId);
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
    const moveSpeedPerTick = baseMoveSpeedPerTick * context.moveMultiplier;
    const stepDistance = moveSpeedPerTick;
    if (!Number.isFinite(moveSpeedPerTick) || moveSpeedPerTick < 0) {
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
                        && route.progress.checkpoint.remainingTicks <= 0)) {
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
                                moveSpeedPerTick,
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

    route = tickRouteWait(route);
    if (route.progress.phase === "CHECKPOINTS"
        && route.progress.checkpoint.type === "WAIT"
        && route.progress.checkpoint.remainingTicks <= 0) {
        if (context.routeAdvanceAllowed) advance();
    } else if (isMovingRoute(route)) {
        const request = getNavigationRequest(navigation);
        if (request === null) throw new Error("moving route requires a navigation request");
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
        ...execution.state(),
        outcomes,
    };
}
