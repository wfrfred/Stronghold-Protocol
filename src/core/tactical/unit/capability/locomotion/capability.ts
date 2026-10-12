import type { QueryContext } from "../../query.js";
import type { NavigationState } from "../../../battlefield/navigation/state.js";
import type { RouteState } from "./route/state.js";
import type { Unit, UnitDefinition } from "../../unit.js";
import { createSteeringState, type SteeringParameters, type SteeringState } from "./steering.js";
import * as contribution from "../../contribution/contribution.js";
import * as modifier from "../../contribution/value.js";

export interface LocomotionDefinition {
    readonly moveSpeedPerTick: number;
    readonly minimumMoveSpeedPerTick?: number;
    readonly steeringParameters: SteeringParameters;
}

export interface LocomotionState {
    readonly moving: boolean;
    readonly moveSpeed: readonly contribution.Contribution<contribution.Input<QueryContext>>[];
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
    readonly definition: {
        readonly locomotion: LocomotionDefinition;
    };
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

export function hasLocomotion<U extends Unit>(unit: U): unit is U & Locomotion {
    return "locomotion" in unit && "locomotion" in unit.definition;
}

export function hasRoutedLocomotion<U extends Unit>(unit: U): unit is U & RoutedLocomotion {
    return hasLocomotion(unit) && "mainRoute" in unit.locomotion;
}

export function createLocomotionState(): LocomotionState {
    return { moving: false, moveSpeed: [], steering: createSteeringState() };
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

function changeMoveSpeedContributions(
    state: LocomotionState,
    transition: (entries: LocomotionState["moveSpeed"]) => LocomotionState["moveSpeed"],
): LocomotionState {
    const moveSpeed = transition(state.moveSpeed);

    return moveSpeed === state.moveSpeed ? state : { ...state, moveSpeed };
}

export function setMoveSpeedContribution(
    state: LocomotionState,
    entry: contribution.Contribution<contribution.Input<QueryContext>>,
): LocomotionState {
    return changeMoveSpeedContributions(state, (entries) => contribution.set(entries, entry));
}

export function removeMoveSpeedContribution(state: LocomotionState, id: string): LocomotionState {
    return changeMoveSpeedContributions(state, (entries) => contribution.remove(entries, id));
}

export function resolveMoveSpeedPerTick(
    definition: LocomotionDefinition,
    state: LocomotionState,
    context: QueryContext,
): number {
    return Math.max(
        definition.minimumMoveSpeedPerTick ?? 0,
        modifier.apply(
            definition.moveSpeedPerTick,
            contribution.resolve(state.moveSpeed, (value) => contribution.evaluate(value, context)),
        ),
    );
}
