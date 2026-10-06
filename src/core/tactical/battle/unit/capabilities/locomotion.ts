import type { NavigationState } from "../../../navigation/state.js";
import type { RouteState } from "../../../route/progress.js";
import { createSteeringState } from "../locomotion/steering.js";
import type { SteeringState } from "../locomotion/steering.js";
import type { Unit, UnitDefinition } from "../unit.js";

export interface LocomotionDefinition {
    readonly moveSpeed: number;
}

export interface LocomotionState {
    moving: boolean;
    steering: SteeringState;
}

export interface RouteControlState {
    route: RouteState;
    navigation: NavigationState;
}

export interface RoutedLocomotionState extends LocomotionState {
    mainRoute: RouteControlState;
    alternativeRoute: RouteControlState | null;
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

export type LocomotiveUnit<D extends LocomotiveUnitDefinition = LocomotiveUnitDefinition,> =
    Unit<D> & Locomotion;

export function createLocomotionState(): LocomotionState {
    return { moving: false, steering: createSteeringState() };
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
