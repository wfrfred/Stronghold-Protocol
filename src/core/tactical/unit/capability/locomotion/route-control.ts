import { World, type WorldOffset, type WorldPosition } from "../../../geometry/coordinate.js";
import type { NavigationFieldProvider } from "../../../battlefield/navigation/cache.js";
import { NavigationMap, type NavigationMaps } from "../../../battlefield/navigation/map.js";
import { createNavigationPath } from "../../../battlefield/navigation/path.js";
import {
    bindNavigationPath,
    clearNavigationRequest,
    createNavigationState,
    getNavigationRequest,
    startNavigationRequest,
} from "../../../battlefield/navigation/state.js";
import type { RouteDefinition } from "./route/definition.js";
import {
    advanceRoute,
    completeRoute,
    enterRoute,
    type RouteExecutionContext,
    type RouteSignal,
    type RouteTransition,
} from "./route/execution.js";
import { createRouteState, type RouteState, type RouteTiming } from "./route/state.js";
import type { RouteControlState } from "./capability.js";

export interface LocatedRouteSignal {
    readonly signal: RouteSignal;
    readonly position: WorldPosition;
}

export interface RouteControlTransition {
    readonly control: RouteControlState;
    readonly position: WorldPosition;
    readonly present: boolean;
    readonly signals: readonly LocatedRouteSignal[];
}

export interface RouteNavigationContext {
    readonly maps: NavigationMaps;
    readonly fieldCache: NavigationFieldProvider;
}

export function isMovingRoute(route: Readonly<RouteState>): boolean {
    return (
        route.progress.phase === "END" ||
        (route.progress.phase === "CHECKPOINTS" && route.progress.checkpoint.type === "MOVE")
    );
}

function applyTransition(
    control: RouteControlState,
    transition: RouteTransition,
    position: WorldPosition,
    present: boolean,
): RouteControlTransition {
    const signals: LocatedRouteSignal[] = [];

    for (const signal of transition.signals) {
        if (signal.type === "DISAPPEAR") {
            present = false;
        } else if (signal.type === "APPEAR_AT_POS") {
            position = signal.position;
            present = true;
        }

        signals.push({ signal, position });
    }

    let navigation = control.navigation;

    if (transition.request !== undefined) {
        navigation = startNavigationRequest(navigation, transition.request);
    } else if (transition.state !== control.route && !isMovingRoute(transition.state)) {
        navigation = clearNavigationRequest(navigation);
    }

    return {
        control:
            transition.state === control.route && navigation === control.navigation
                ? control
                : { route: transition.state, navigation },
        position,
        present,
        signals,
    };
}

export function enterRouteControl(
    control: RouteControlState,
    position: WorldPosition,
    present: boolean,
    execution: RouteExecutionContext,
): RouteControlTransition {
    return applyTransition(control, enterRoute(control.route, execution), position, present);
}

export function advanceRouteControl(
    control: RouteControlState,
    position: WorldPosition,
    present: boolean,
    execution: RouteExecutionContext,
): RouteControlTransition {
    return applyTransition(control, advanceRoute(control.route, execution), position, present);
}

export function completeRouteControl(control: RouteControlState): RouteControlState {
    const route = completeRoute(control.route);
    const navigation = clearNavigationRequest(control.navigation);

    return route === control.route && navigation === control.navigation
        ? control
        : { route, navigation };
}

export function initializeRouteControl(
    definition: RouteDefinition,
    timing: RouteTiming,
    alwaysCheckCurrentPoint: boolean,
    locatorOffset: WorldOffset,
    position: WorldPosition,
    execution: RouteExecutionContext,
    present = true,
): RouteControlTransition {
    return enterRouteControl(
        {
            route: createRouteState(definition, timing, alwaysCheckCurrentPoint),
            navigation: createNavigationState(definition.pathMotionMode, locatorOffset),
        },
        position,
        present,
        execution,
    );
}

export function bindRouteNavigation(
    control: RouteControlState,
    position: WorldPosition,
    context: RouteNavigationContext,
): RouteControlState {
    const navigation = control.navigation;
    const activity = navigation.execution.activity;
    const map = context.maps[navigation.pathMotionMode];

    if (
        (activity.type === "FOLLOWING" || activity.type === "UNREACHABLE") &&
        NavigationMap.sameContent(activity.path.field.map, map)
    ) {
        return control;
    }

    const request = getNavigationRequest(navigation);

    if (request === null) {
        throw new Error("moving route requires a navigation request");
    }

    const path = createNavigationPath(request, context.fieldCache.get(map, request));

    return { ...control, navigation: bindNavigationPath(navigation, path, position).state };
}

export function routeLocator(control: RouteControlState, position: WorldPosition): WorldPosition {
    return World.translate(position, control.navigation.execution.locatorOffset);
}
