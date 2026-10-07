import { createRng, type Seed } from "../../../../common/rng.js";
import {
    createWorldOffset,
    World,
    type WorldOffset,
    type WorldPosition,
} from "../../../geometry/coordinate.js";
import type { NavigationFieldProvider } from "../../../navigation/cache.js";
import { NavigationMap, type NavigationMaps } from "../../../navigation/map.js";
import { canTraverseNavigationSegment } from "../../../navigation/query.js";
import { isNavigationGoalReached, type NavigationRequestId } from "../../../navigation/request.js";
import {
    clearNavigationRequest,
    canCompleteNavigationSegment,
    getNavigationRequest,
    markNavigationArrived,
    steerNavigation,
    type NavigationOutcome,
} from "../../../navigation/state.js";
import { createRouteExecution, tickRouteWait } from "../../../route/execution.js";
import {
    isRouteCheckpointReady,
    isRouteEndReached,
    isRouteMoveCheckpointReached,
} from "../../../route/plan.js";
import { hasSpatialPresence, isSpatiallyPresent } from "../presence.js";
import {
    applyMotionOverride,
    getNavigationBoundaryDirection,
    reflectNavigationMovement,
    type MotionOverride,
} from "./motion.js";
import {
    advanceRouteControl,
    bindRouteNavigation,
    enterRouteControl,
    isMovingRoute,
    predictRouteControl,
    routeLocator,
    type LocatedRouteSignal,
    type RouteControlTransition,
} from "./route-control.js";
import type {
    LocomotionDefinition,
    RouteControlState,
    RoutedLocomotiveUnit,
    RoutedLocomotionState,
} from "./state.js";
import { integrateSteeringDirection } from "./steering.js";

export interface RoutedLocomotionStepContext {
    readonly tick: number;
    readonly maps: NavigationMaps;
    readonly fieldCache: NavigationFieldProvider;
    readonly moveMultiplier: number;
    readonly movementAllowed: boolean;
    readonly waitTickAllowed: boolean;
    readonly routeAdvanceAllowed: boolean;
    readonly motionOverride?: MotionOverride;
    readonly rngState: Seed;
    readonly nextNavigationRequestId: NavigationRequestId;
}

export interface RoutedLocomotionStep {
    readonly state: RoutedLocomotionState;
    readonly position: WorldPosition;
    readonly present: boolean;
    readonly signals: readonly LocatedRouteSignal[];
    readonly rngState: Seed;
    readonly nextNavigationRequestId: NavigationRequestId;
    readonly outcomes: readonly NavigationOutcome[];
}

export interface RoutedUnitStep<U extends RoutedLocomotiveUnit = RoutedLocomotiveUnit> {
    readonly unit: U;
    readonly signals: readonly LocatedRouteSignal[];
    readonly rngState: Seed;
    readonly nextNavigationRequestId: NavigationRequestId;
    readonly outcomes: readonly NavigationOutcome[];
}

export function stepRoutedUnit<U extends RoutedLocomotiveUnit>(
    unit: U,
    context: RoutedLocomotionStepContext,
): RoutedUnitStep<U> {
    const step = stepRoutedLocomotion(
        unit.locomotion,
        unit.position,
        unit.definition.locomotion,
        context,
        isSpatiallyPresent(unit),
    );
    let next = { ...unit, position: step.position, locomotion: step.state };

    if (hasSpatialPresence(unit) || step.signals.some(({ signal }) => signal.type !== "ALERT")) {
        const spatialPresence =
            hasSpatialPresence(unit) && unit.spatialPresence.present === step.present
                ? unit.spatialPresence
                : { present: step.present };
        next = { ...next, spatialPresence };
    }

    return {
        unit: next,
        signals: step.signals,
        rngState: step.rngState,
        nextNavigationRequestId: step.nextNavigationRequestId,
        outcomes: step.outcomes,
    };
}

function isMoveCheckpointReached(
    control: RouteControlState,
    position: WorldPosition,
    context: RoutedLocomotionStepContext,
): boolean {
    const route = control.route;

    if (route.progress.phase !== "CHECKPOINTS" || route.progress.checkpoint.type !== "MOVE") {
        return false;
    }

    const locator = routeLocator(control, position);

    if (isRouteMoveCheckpointReached(route, locator, true)) {
        return true;
    }
    if (route.alwaysCheckCurrentPoint) {
        return false;
    }

    const request = getNavigationRequest(control.navigation)!;
    const map = context.maps[control.navigation.pathMotionMode];
    const tile = World.toTile(locator);
    const field = context.fieldCache.get(map, request);
    const reachable =
        NavigationMap.get(map, tile)?.passable === true &&
        field.nodes[tile[0] * map.columns + tile[1]]?.type !== "UNREACHABLE";

    return isRouteMoveCheckpointReached(route, locator, reachable);
}

export function stepRoutedLocomotion(
    state: Readonly<RoutedLocomotionState>,
    position: WorldPosition,
    definition: LocomotionDefinition,
    context: RoutedLocomotionStepContext,
    present = true,
): RoutedLocomotionStep {
    const execution = createRouteExecution(
        createRng(context.rngState),
        context.nextNavigationRequestId,
        context.tick,
    );
    const signals: LocatedRouteSignal[] = [];
    const outcomes: NavigationOutcome[] = [];
    const arrived = new Set<NavigationRequestId>();

    for (const control of [state.mainRoute, state.alternativeRoute]) {
        if (control?.navigation.execution.activity.type === "ARRIVED") {
            arrived.add(control.navigation.execution.activity.request.id);
        }
    }

    let steering = state.steering;
    let moving = false;
    const speed = definition.moveSpeedPerTick * context.moveMultiplier;

    if (!Number.isFinite(speed) || speed < 0) {
        throw new RangeError("movement budget must be finite and non-negative");
    }

    function apply(transition: RouteControlTransition): RouteControlState {
        position = transition.position;
        present = transition.present;
        signals.push(...transition.signals);

        return transition.control;
    }

    function advance(control: RouteControlState): RouteControlState {
        return apply(advanceRouteControl(control, position, present, execution));
    }

    function reportArrival(control: RouteControlState): RouteControlState {
        const request = getNavigationRequest(control.navigation)!;

        if (!arrived.has(request.id)) {
            outcomes.push({ type: "ARRIVED", requestId: request.id });
            arrived.add(request.id);
        }

        return { ...control, navigation: markNavigationArrived(control.navigation) };
    }

    function heading(control: RouteControlState): {
        readonly control: RouteControlState;
        readonly direction: WorldOffset;
        readonly present: boolean;
    } {
        while (true) {
            if (control.route.progress.phase === "COMPLETED") {
                break;
            }

            const boundary = getNavigationBoundaryDirection(
                context.maps[control.navigation.pathMotionMode],
                routeLocator(control, position),
            );

            if (boundary[0] !== 0 || boundary[1] !== 0) {
                return { control, direction: boundary, present };
            }

            if (isRouteCheckpointReady(control.route)) {
                if (!context.routeAdvanceAllowed) {
                    break;
                }

                control = advance(control);
                continue;
            }
            if (!isMovingRoute(control.route)) {
                break;
            }

            control = bindRouteNavigation(control, position, context);
            const activity = control.navigation.execution.activity;

            if (activity.type !== "FOLLOWING" && activity.type !== "UNREACHABLE") {
                if (
                    context.routeAdvanceAllowed &&
                    isMoveCheckpointReached(control, position, context)
                ) {
                    control = advance(control);
                    continue;
                }

                break;
            }

            const next = steerNavigation(control.navigation, position);

            if (
                control.route.progress.phase === "END" &&
                next.selection.decision.type === "ARRIVED"
            ) {
                const request = getNavigationRequest(control.navigation)!;
                control = {
                    ...control,
                    navigation: {
                        ...next.state,
                        execution: {
                            ...next.state.execution,
                            activity: {
                                type: "FOLLOWING",
                                path: activity.path,
                                cursor: next.selection.cursor,
                            },
                        },
                    },
                };

                return {
                    control,
                    present,
                    direction: World.difference(
                        request.goal.position,
                        routeLocator(control, position),
                    ),
                };
            }

            control = { ...control, navigation: next.state };

            for (const outcome of next.outcomes) {
                if (outcome.type === "ARRIVED") {
                    if (arrived.has(outcome.requestId)) {
                        continue;
                    }

                    arrived.add(outcome.requestId);
                }

                outcomes.push(outcome);
            }

            if (next.selection.decision.type === "ARRIVED") {
                if (context.routeAdvanceAllowed) {
                    control = advance(control);
                    continue;
                }

                break;
            }
            if (
                context.routeAdvanceAllowed &&
                isMoveCheckpointReached(control, position, context)
            ) {
                control = advance(control);
                continue;
            }
            if (next.selection.decision.type === "MOVE" && present) {
                return {
                    control,
                    present,
                    direction: World.difference(next.selection.decision.target, position),
                };
            }

            break;
        }

        return { control, direction: createWorldOffset(0, 0), present };
    }

    function tickWait(control: RouteControlState): RouteControlState {
        const route = context.waitTickAllowed
            ? tickRouteWait(control.route, context.tick)
            : control.route;

        return route === control.route ? control : { ...control, route };
    }

    function advanceReached(control: RouteControlState): RouteControlState {
        if (!context.routeAdvanceAllowed) {
            return control;
        }
        if (isRouteCheckpointReady(control.route)) {
            return advance(control);
        }
        if (!isMovingRoute(control.route)) {
            return control;
        }

        const request = getNavigationRequest(control.navigation)!;
        const reached = isNavigationGoalReached(request, routeLocator(control, position));

        if (reached) {
            control = reportArrival(control);
        }
        if (reached || isMoveCheckpointReached(control, position, context)) {
            return advance(control);
        }

        return control;
    }

    function completeAtEnd(control: RouteControlState): RouteControlState {
        if (
            !context.routeAdvanceAllowed ||
            control.route.progress.phase === "COMPLETED" ||
            !isRouteEndReached(control.route, routeLocator(control, position))
        ) {
            return control;
        }

        if (control.route.progress.phase === "END") {
            control = reportArrival(control);
        }

        return {
            route: { ...control.route, progress: { phase: "COMPLETED" } },
            navigation: clearNavigationRequest(control.navigation),
        };
    }

    function canSnapToTarget(
        control: RouteControlState,
        target: WorldPosition,
        recoveringLocator: boolean,
    ): boolean {
        if (!World.withinDistance(position, target, speed)) {
            return false;
        }
        if (recoveringLocator) {
            return true;
        }

        return (
            canCompleteNavigationSegment(control.navigation, position, target) &&
            canTraverseNavigationSegment(
                context.maps[control.navigation.pathMotionMode],
                position,
                target,
            )
        );
    }

    let main = apply(enterRouteControl(state.mainRoute, position, present, execution));
    let alternative =
        state.alternativeRoute === null
            ? null
            : apply(enterRouteControl(state.alternativeRoute, position, present, execution));
    let active = alternative ?? main;
    const boundary = getNavigationBoundaryDirection(
        context.maps[active.navigation.pathMotionMode],
        position,
    );

    if (context.motionOverride !== undefined) {
        if (
            context.motionOverride.type === "DISPLACEMENT" ||
            (context.movementAllowed && present)
        ) {
            const next = applyMotionOverride(
                steering,
                position,
                context.motionOverride,
                speed,
                definition.steeringParameters,
            );
            moving =
                context.motionOverride.type === "DIRECTION" &&
                (next.position[0] !== position[0] || next.position[1] !== position[1]);
            position = next.position;
            steering = next.state;
        }
    } else if (context.movementAllowed && present && (boundary[0] !== 0 || boundary[1] !== 0)) {
        const next = World.translate(position, World.scale(boundary, speed));
        moving = next[0] !== position[0] || next[1] !== position[1];
        position = next;
    } else if (context.movementAllowed && present) {
        const locatorBoundary = getNavigationBoundaryDirection(
            context.maps[active.navigation.pathMotionMode],
            routeLocator(active, position),
        );
        let target: WorldPosition | null = null;
        const recoveringLocator =
            active.route.progress.phase !== "COMPLETED" &&
            (locatorBoundary[0] !== 0 || locatorBoundary[1] !== 0);

        if (recoveringLocator) {
            target = World.translate(position, locatorBoundary);
        } else {
            const prediction = predictRouteControl(active, position, context);
            active = prediction.control;

            if (prediction.selection?.decision.type === "TARGET") {
                target = prediction.selection.decision.target;
            }
        }

        if (target !== null && canSnapToTarget(active, target, recoveringLocator)) {
            moving = target[0] !== position[0] || target[1] !== position[1];
            position = target;
        } else {
            const next = heading(active);
            active = next.control;

            if (next.present) {
                const distance = Math.hypot(next.direction[0], next.direction[1]);
                const movement = integrateSteeringDirection(
                    steering,
                    position,
                    next.direction,
                    distance === 0 ? speed : Math.min(speed, distance),
                    definition.steeringParameters,
                );
                const reflected = reflectNavigationMovement(
                    position,
                    movement.position,
                    context.maps[active.navigation.pathMotionMode],
                );
                const map = context.maps[active.navigation.pathMotionMode];
                const permitted =
                    recoveringLocator ||
                    (canTraverseNavigationSegment(map, position, reflected) &&
                        canTraverseNavigationSegment(
                            map,
                            routeLocator(active, position),
                            routeLocator(active, reflected),
                        ));

                if (permitted) {
                    moving = reflected[0] !== position[0] || reflected[1] !== position[1];
                    position = reflected;
                }

                steering = movement.state;
            }
        }
    }

    if (alternative === null) {
        main = active;
    } else {
        alternative = active;
    }

    main = tickWait(main);

    if (alternative === null) {
        main = advanceReached(main);
    } else {
        alternative = completeAtEnd(advanceReached(tickWait(alternative)));
    }

    main = completeAtEnd(main);

    return {
        position,
        present,
        signals,
        outcomes,
        state: { ...state, moving, steering, mainRoute: main, alternativeRoute: alternative },
        ...execution.state(),
    };
}
