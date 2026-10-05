import type { Unit, UnitDefinition } from "../unit.js";

export interface LocomotionDefinition {
    readonly moveSpeed: number;
}

export interface LocomotionState {
    moving: boolean;
}

export interface Locomotion {
    readonly locomotion: LocomotionState;
}

export interface LocomotiveUnitDefinition extends UnitDefinition {
    readonly locomotion: LocomotionDefinition;
}

export type LocomotiveUnit<D extends LocomotiveUnitDefinition = LocomotiveUnitDefinition,> =
    Unit<D> & Locomotion;