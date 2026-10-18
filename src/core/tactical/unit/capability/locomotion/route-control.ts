import { World, type WorldOffset, type WorldPosition } from "../../../geometry/coordinate.js";
import * as tracking from "./tracking.js";
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
        navigation = tracking.start(navigation, transition.request);
    } else if (transition.state !== control.route && !isMovingRoute(transition.state)) {
        navigation = tracking.clear(navigation);
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
    const navigation = tracking.clear(control.navigation);

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
            navigation: tracking.create(definition.pathMotionMode, locatorOffset),
        },
        position,
        present,
        execution,
    );
}

export function routeLocator(control: RouteControlState, position: WorldPosition): WorldPosition {
    return World.translate(position, control.navigation.execution.locatorOffset);
}
