import { createWorldOffset } from "../../../geometry/coordinate.js";
import {
    copyNavigationState,
    type NavigationState,
} from "../../../battlefield/navigation/state.js";
import { copyRouteState, type RouteState } from "./route/state.js";
import { stabilizeUnit, type StableUnit, type Unit, type UnitDefinition } from "../../unit.js";
import { createSteeringState, type SteeringParameters, type SteeringState } from "./steering.js";
import * as contribution from "../../../modifier/contribution.js";
import * as modifier from "../../../modifier/value.js";

export interface LocomotionDefinition {
    readonly moveSpeedPerTick: number;
    readonly minimumMoveSpeedPerTick?: number;
    readonly steeringParameters: SteeringParameters;
}

export interface LocomotionState {
    readonly moving: boolean;
    readonly moveSpeed: contribution.State;
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
        moveSpeed: contribution.copy(state.moveSpeed),
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

export function createLocomotionState(): LocomotionState {
    return { moving: false, moveSpeed: contribution.create(), steering: createSteeringState() };
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

export function updateMoveSpeedContributions<U extends Unit>(
    input: U | StableUnit<U>,
    transition: contribution.Transition,
): StableUnit<U> {
    const unit = stabilizeUnit<U>(input);

    if (!hasLocomotion(unit)) {
        throw new TypeError("move speed contributions require Locomotion capability");
    }

    const moveSpeed = transition(unit.locomotion.moveSpeed);

    return moveSpeed === unit.locomotion.moveSpeed
        ? unit
        : { ...unit, locomotion: { ...unit.locomotion, moveSpeed } };
}

export function resolveMoveSpeedPerTick(
    definition: LocomotionDefinition,
    state: LocomotionState,
    evaluate?: contribution.Evaluate,
): number {
    return Math.max(
        definition.minimumMoveSpeedPerTick ?? 0,
        modifier.apply(
            definition.moveSpeedPerTick,
            contribution.resolve(state.moveSpeed, evaluate),
        ),
    );
}
