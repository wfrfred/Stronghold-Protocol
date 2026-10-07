import { createWorldOffset } from "../../../geometry/coordinate.js";
import type { NavigationMaps, PathMotionMode } from "../../../navigation/map.js";
import {
    copyNavigationState,
    invalidateNavigationPath,
    type NavigationState,
} from "../../../navigation/state.js";
import { copyRouteState, type RouteState } from "../../../route/state.js";
import type { Unit, UnitDefinition } from "../../unit.js";
import { createSteeringState, type SteeringParameters, type SteeringState } from "./steering.js";

export interface LocomotionDefinition {
    readonly moveSpeedPerTick: number;
    readonly steeringParameters: SteeringParameters;
}

export interface LocomotionState {
    readonly moving: boolean;
    readonly steering: SteeringState;
}

export interface RouteControlState {
    readonly route: RouteState;
    readonly navigation: NavigationState;
}

export interface RoutedLocomotionState extends LocomotionState {
    readonly mainRoute: RouteControlState;
    readonly alternativeRoute: RouteControlState | null;
}

export interface Locomotion {
    readonly locomotion: LocomotionState;
}

export interface RoutedLocomotion extends Locomotion {
    readonly locomotion: RoutedLocomotionState;
}

export interface LocomotiveUnitDefinition extends UnitDefinition {
    readonly locomotion: LocomotionDefinition;
}

export type LocomotiveUnit<D extends LocomotiveUnitDefinition = LocomotiveUnitDefinition> =
    Unit<D> & Locomotion;

export type RoutedLocomotiveUnit<D extends LocomotiveUnitDefinition = LocomotiveUnitDefinition> =
    Unit<D> & RoutedLocomotion;

export function hasLocomotion<U extends Unit>(
    unit: U,
): unit is U & LocomotiveUnit<U["definition"] & LocomotiveUnitDefinition> {
    return "locomotion" in unit && "locomotion" in unit.definition;
}

export function hasRoutedLocomotion<U extends Unit>(
    unit: U,
): unit is U & RoutedLocomotiveUnit<U["definition"] & LocomotiveUnitDefinition> {
    return hasLocomotion(unit) && "mainRoute" in unit.locomotion;
}

function copyRouteControlState(state: RouteControlState): RouteControlState {
    return {
        ...state,
        route: copyRouteState(state.route),
        navigation: copyNavigationState(state.navigation),
    };
}

export function copyLocomotionState(state: Readonly<RoutedLocomotionState>): RoutedLocomotionState;
export function copyLocomotionState(state: Readonly<LocomotionState>): LocomotionState;
export function copyLocomotionState(state: Readonly<LocomotionState>): LocomotionState {
    const snapshot = {
        ...state,
        steering: {
            ...state.steering,
            lastVelocity: Object.isFrozen(state.steering.lastVelocity)
                ? state.steering.lastVelocity
                : createWorldOffset(...state.steering.lastVelocity),
        },
    };

    if (!("mainRoute" in state)) {
        return snapshot;
    }

    const routed = state as Readonly<RoutedLocomotionState>;
    const copied: RoutedLocomotionState = {
        ...snapshot,
        mainRoute: copyRouteControlState(routed.mainRoute),
        alternativeRoute:
            routed.alternativeRoute === null
                ? null
                : copyRouteControlState(routed.alternativeRoute),
    };

    return copied;
}

function reconcileRouteNavigation(
    state: RouteControlState,
    maps: NavigationMaps,
    modes?: readonly PathMotionMode[],
): RouteControlState {
    if (modes !== undefined && !modes.includes(state.navigation.pathMotionMode)) {
        return state;
    }

    const navigation = invalidateNavigationPath(
        state.navigation,
        maps[state.navigation.pathMotionMode],
    );

    return navigation === state.navigation ? state : { ...state, navigation };
}

export function reconcileLocomotionNavigation(
    state: RoutedLocomotionState,
    maps: NavigationMaps,
    modes?: readonly PathMotionMode[],
): RoutedLocomotionState;
export function reconcileLocomotionNavigation(
    state: LocomotionState,
    maps: NavigationMaps,
    modes?: readonly PathMotionMode[],
): LocomotionState;
export function reconcileLocomotionNavigation(
    state: LocomotionState,
    maps: NavigationMaps,
    modes?: readonly PathMotionMode[],
): LocomotionState {
    if (!("mainRoute" in state)) {
        return state;
    }

    const routed = state as RoutedLocomotionState;
    const mainRoute = reconcileRouteNavigation(routed.mainRoute, maps, modes);
    const alternativeRoute =
        routed.alternativeRoute === null
            ? null
            : reconcileRouteNavigation(routed.alternativeRoute, maps, modes);

    if (mainRoute === routed.mainRoute && alternativeRoute === routed.alternativeRoute) {
        return state;
    }

    const next: RoutedLocomotionState = { ...routed, mainRoute, alternativeRoute };

    return next;
}

export function reconcileUnitNavigation<U extends Unit>(
    unit: U,
    maps: NavigationMaps,
    modes?: readonly PathMotionMode[],
): U {
    if (!hasLocomotion(unit)) {
        return unit;
    }

    const locomotion = reconcileLocomotionNavigation(unit.locomotion, maps, modes);

    return locomotion === unit.locomotion ? unit : { ...unit, locomotion };
}

export function createLocomotionState(): LocomotionState {
    return { moving: false, steering: createSteeringState() };
}

export function initializeLocomotionState(
    definition: LocomotionDefinition,
    context: { readonly tick: number },
): LocomotionState;
export function initializeLocomotionState(): LocomotionState {
    return createLocomotionState();
}

export function createRoutedLocomotionState(
    route: RouteState,
    navigation: NavigationState,
): RoutedLocomotionState {
    return {
        ...createLocomotionState(),
        mainRoute: { route, navigation },
        alternativeRoute: null,
    };
}
