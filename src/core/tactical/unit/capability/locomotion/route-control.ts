import { World, type WorldOffset, type WorldPosition } from "../../../geometry/coordinate.js";
import type { NavigationFieldProvider } from "../../../battlefield/navigation/cache.js";
import type { NavigationMaps } from "../../../battlefield/navigation/map.js";
import {
    createNavigationPath,
    type NavigationPredictionSelection,
} from "../../../battlefield/navigation/path.js";
import {
    initializeNavigationCursor,
    selectNavigationPredictionTarget,
} from "../../../battlefield/navigation/query.js";
import type { NavigationIntent } from "../../../battlefield/navigation/request.js";
import {
    bindNavigationPath,
    clearNavigationRequest,
    createNavigationState,
    getNavigationRequest,
    predictNavigation,
    startNavigationRequest,
    type NavigationState,
} from "../../../battlefield/navigation/state.js";
import type { RouteDefinition } from "./route/definition.js";
import {
    advanceRoute,
    enterRoute,
    routeNavigationOptions,
    type RouteExecutionContext,
    type RouteSignal,
    type RouteTransition,
} from "./route/execution.js";
import { predictRouteTarget } from "./route/plan.js";
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
        activity.path.field.map === map
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

export function predictRouteControl(
    control: RouteControlState,
    position: WorldPosition,
    context: RouteNavigationContext,
): {
    readonly control: RouteControlState;
    readonly selection: NavigationPredictionSelection | null;
} {
    if (isMovingRoute(control.route)) {
        control = bindRouteNavigation(control, position, context);
        const activity = control.navigation.execution.activity;

        if (activity.type !== "FOLLOWING" && activity.type !== "UNREACHABLE") {
            return { control, selection: null };
        }

        const prediction = predictNavigation(control.navigation, position);

        return {
            control: { ...control, navigation: prediction.state },
            selection: prediction.selection,
        };
    }

    const target = predictRouteTarget(control.route);

    if (target.type === "COMPLETED") {
        return { control, selection: null };
    }

    const navigation = control.navigation;
    const map = context.maps[navigation.pathMotionMode];
    const previous = navigation.execution.activity;
    const intent: NavigationIntent = Object.freeze({
        targetTile: target.targetTile,
        goal: Object.freeze(target.goal),
        options: Object.freeze(routeNavigationOptions(control.route.definition)),
        arrivalRule: target.type === "END_TARGET" ? "TARGET_TILE_AND_DISTANCE" : "DISTANCE",
    });
    const samePreview =
        previous.type === "PREVIEWING" &&
        previous.path.field.map === map &&
        previous.path.request.targetTile[0] === target.targetTile[0] &&
        previous.path.request.targetTile[1] === target.targetTile[1];
    const path = samePreview
        ? previous.path
        : createNavigationPath(intent, context.fieldCache.get(map, intent));
    const initialization = samePreview
        ? { type: "READY" as const, cursor: previous.cursor }
        : initializeNavigationCursor(path, position, navigation.execution.locatorOffset);

    if (initialization.type !== "READY") {
        return { control, selection: null };
    }

    const selection = selectNavigationPredictionTarget(
        path,
        initialization.cursor,
        navigation.execution.visits,
        position,
        navigation.execution.locatorOffset,
    );
    const next: NavigationState = {
        ...navigation,
        execution: {
            ...navigation.execution,
            visits: selection.visits,
            activity: { type: "PREVIEWING", path, cursor: selection.cursor },
        },
    };

    return { control: { ...control, navigation: next }, selection };
}

export function routeLocator(control: RouteControlState, position: WorldPosition): WorldPosition {
    return World.translate(position, control.navigation.execution.locatorOffset);
}
