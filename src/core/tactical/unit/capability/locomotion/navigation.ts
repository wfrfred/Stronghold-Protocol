import type { NavigationMaps, PathMotionMode } from "../../../battlefield/navigation/map.js";
import { invalidateNavigationPath } from "../../../battlefield/navigation/state.js";
import type { Unit } from "../../unit.js";
import {
    hasLocomotion,
    type LocomotionState,
    type RouteControlState,
    type RoutedLocomotionState,
} from "./capability.js";

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
