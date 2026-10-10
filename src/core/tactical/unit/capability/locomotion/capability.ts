import type { NavigationState } from "../../../battlefield/navigation/state.js";
import type { RouteState } from "./route/state.js";
import { widenUnit, type StableUnit, type Unit, type UnitDefinition } from "../../unit.js";
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

export function createLocomotionState(): LocomotionState {
    return { moving: false, moveSpeed: contribution.empty(), steering: createSteeringState() };
}

export function initializeLocomotionState(
    definition: LocomotionDefinition,
    context: { readonly tick: number },
): LocomotionState;
export function initializeLocomotionState(): LocomotionState {
    return createLocomotionState();
}

export function createRoutedLocomotionState(mainRoute: RouteControlState): RoutedLocomotionState {
    return {
        ...createLocomotionState(),
        mainRoute,
        alternativeRoute: null,
    };
}

export function updateMoveSpeedContributions<U extends Unit>(
    input: U | StableUnit<U>,
    transition: contribution.Transition,
): StableUnit<U> {
    const unit = widenUnit<U>(input);

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
