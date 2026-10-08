import { assertNonnegativeNumber } from "../../../../common/assert.js";
import { createRng, type Seed } from "../../../../common/rng.js";
import { createWorldOffset, World, type WorldPosition } from "../../../geometry/coordinate.js";
import type { NavigationFieldProvider } from "../../../battlefield/navigation/cache.js";
import { NavigationMap, type NavigationMaps } from "../../../battlefield/navigation/map.js";
import {
    canTraverseNavigationSegment,
    canTraverseNavigationRecoverySegment,
} from "../../../battlefield/navigation/segment.js";
import {
    isNavigationGoalReached,
    type NavigationRequestId,
} from "../../../battlefield/navigation/request.js";
import {
    getNavigationRequest,
    markNavigationArrived,
    queryNavigation,
    type NavigationOutcome,
} from "../../../battlefield/navigation/state.js";
import { createRouteExecution, tickRouteWait } from "./route/execution.js";
import {
    isRouteCheckpointReady,
    isRouteEndReached,
    isRouteMoveCheckpointReached,
} from "./route/plan.js";
import { hasSpatialPresence, isSpatiallyPresent } from "../presence.js";
import {
    applyMotionOverride,
    getNavigationRecoveryTarget,
    reflectNavigationMovement,
    type MotionOverride,
} from "./motion.js";
import {
    advanceRouteControl,
    bindRouteNavigation,
    enterRouteControl,
    completeRouteControl,
    isMovingRoute,
    routeLocator,
    type LocatedRouteSignal,
    type RouteControlTransition,
} from "./route-control.js";
import {
    resolveMoveSpeedPerTick,
    type LocomotionDefinition,
    type RouteControlState,
    type RoutedLocomotiveUnit,
    type RoutedLocomotionState,
} from "./capability.js";
import { integrateSteeringDirection } from "./steering.js";
import { widenUnit, type StableUnit } from "../../unit.js";
import type * as contribution from "../../../modifier/contribution.js";

export interface RoutedLocomotionStepContext {
    readonly tick: number;
    readonly maps: NavigationMaps;
    readonly fieldCache: NavigationFieldProvider;
    readonly moveMultiplier: number;
    readonly evaluateContributions?: contribution.Evaluate;
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
    readonly unit: StableUnit<U>;
    readonly signals: readonly LocatedRouteSignal[];
    readonly rngState: Seed;
    readonly nextNavigationRequestId: NavigationRequestId;
    readonly outcomes: readonly NavigationOutcome[];
}

export function stepRoutedUnit<U extends RoutedLocomotiveUnit>(
    input: U | StableUnit<U>,
    context: RoutedLocomotionStepContext,
): RoutedUnitStep<U>;
export function stepRoutedUnit(
    input: RoutedLocomotiveUnit,
    context: RoutedLocomotionStepContext,
): RoutedUnitStep {
    const unit = widenUnit(input);
    const step = stepRoutedLocomotion(
        unit.locomotion,
        unit.position,
        unit.definition.locomotion,
        context,
        isSpatiallyPresent(unit),
    );
    let next =
        step.position === unit.position && step.state === unit.locomotion
            ? unit
            : { ...unit, position: step.position, locomotion: step.state };

    if (hasSpatialPresence(unit) || step.signals.some(({ signal }) => signal.type !== "ALERT")) {
        const spatialPresence =
            hasSpatialPresence(unit) && unit.spatialPresence.present === step.present
                ? unit.spatialPresence
                : { present: step.present };

        if (!hasSpatialPresence(unit) || spatialPresence !== unit.spatialPresence) {
            next = { ...next, spatialPresence };
        }
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
    const initialPosition = position;
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
    const speed =
        resolveMoveSpeedPerTick(definition, state, context.evaluateContributions) *
        context.moveMultiplier;

    assertNonnegativeNumber(speed, "movement budget");

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

        const navigation = markNavigationArrived(control.navigation);

        return navigation === control.navigation ? control : { ...control, navigation };
    }

    function heading(control: RouteControlState): {
        readonly control: RouteControlState;
        readonly target: WorldPosition | null;
        readonly present: boolean;
    } {
        while (control.route.progress.phase !== "COMPLETED") {
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

            const next = queryNavigation(control.navigation, position);

            if (next.state !== control.navigation) {
                control = { ...control, navigation: next.state };
            }

            outcomes.push(...next.outcomes);
            const decision = next.selection.decision;

            if (control.route.progress.phase === "CHECKPOINTS") {
                if (decision.type === "ARRIVAL_CANDIDATE") {
                    control = reportArrival(control);
                }
                if (
                    decision.type === "ARRIVAL_CANDIDATE" ||
                    isMoveCheckpointReached(control, position, context)
                ) {
                    if (context.routeAdvanceAllowed) {
                        control = advance(control);
                        continue;
                    }

                    break;
                }
            }

            return {
                control,
                present,
                target:
                    decision.type === "MOVE" || decision.type === "ARRIVAL_CANDIDATE"
                        ? decision.target
                        : null,
            };
        }

        return { control, target: null, present };
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
            (control.route.progress.phase === "CHECKPOINTS" &&
                control.route.progress.checkpoint.type === "NOT_ENTERED") ||
            !isRouteEndReached(control.route, routeLocator(control, position))
        ) {
            return control;
        }

        if (control.route.progress.phase === "END") {
            control = reportArrival(control);
        }

        return completeRouteControl(control);
    }

    let main = state.mainRoute;
    let alternative = state.alternativeRoute;

    if (context.routeAdvanceAllowed) {
        if (alternative === null) {
            main = apply(enterRouteControl(main, position, present, execution));
        } else {
            alternative = apply(enterRouteControl(alternative, position, present, execution));
        }
    }

    let active = alternative ?? main;
    const map = context.maps[active.navigation.pathMotionMode];
    const locator = routeLocator(active, position);
    const recovering =
        !NavigationMap.contains(map, World.toTile(position)) ||
        !NavigationMap.contains(map, World.toTile(locator));

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
    } else if (context.movementAllowed && present) {
        let target: WorldPosition | null;

        if (recovering) {
            target = getNavigationRecoveryTarget(
                map,
                position,
                active.navigation.execution.locatorOffset,
            );
        } else {
            const next = heading(active);
            active = next.control;
            target = next.target;
            present = next.present;
        }

        const pending =
            active.route.progress.phase === "CHECKPOINTS" &&
            active.route.progress.checkpoint.type === "NOT_ENTERED";
        const traverse = recovering
            ? canTraverseNavigationRecoverySegment
            : canTraverseNavigationSegment;
        const permitted = (destination: WorldPosition): boolean =>
            traverse(map, position, destination) &&
            traverse(map, routeLocator(active, position), routeLocator(active, destination));

        if (recovering && target === null) {
            steering = { lastVelocity: createWorldOffset(0, 0) };
        } else if (!pending && present) {
            if (
                target !== null &&
                active.route.progress.phase === "CHECKPOINTS" &&
                World.withinDistance(position, target, speed) &&
                permitted(target)
            ) {
                moving = target[0] !== position[0] || target[1] !== position[1];
                position = target;
            } else {
                const direction =
                    target === null ? createWorldOffset(0, 0) : World.difference(target, position);
                const distance = Math.hypot(direction[0], direction[1]);
                const movement = integrateSteeringDirection(
                    steering,
                    position,
                    direction,
                    distance === 0 ? speed : Math.min(speed, distance),
                    definition.steeringParameters,
                );
                const destination = recovering
                    ? movement.position
                    : reflectNavigationMovement(position, movement.position, map);

                if (permitted(destination)) {
                    moving = destination[0] !== position[0] || destination[1] !== position[1];
                    position = destination;
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

    if (position[0] === initialPosition[0] && position[1] === initialPosition[1]) {
        position = initialPosition;
    }
    if (
        steering.lastVelocity[0] === state.steering.lastVelocity[0] &&
        steering.lastVelocity[1] === state.steering.lastVelocity[1]
    ) {
        steering = state.steering;
    }

    const nextState =
        moving === state.moving &&
        steering === state.steering &&
        main === state.mainRoute &&
        alternative === state.alternativeRoute
            ? state
            : { ...state, moving, steering, mainRoute: main, alternativeRoute: alternative };

    return {
        position,
        present,
        signals,
        outcomes,
        state: nextState,
        ...execution.state(),
    };
}
