import type { WorldPosition } from "../geometry/coordinate.js";
import { ownDataRecord, type ImmutableData } from "../../common/immutable-data.js";
import type { CapabilityStates } from "./capability/catalog.js";
import type { RoutedLocomotionState } from "./capability/locomotion/capability.js";

export type UnitId = number;

export type UnitDefinitionId = string;

export interface UnitDefinition {
    readonly id: UnitDefinitionId;
}

export interface Unit<D extends UnitDefinition = UnitDefinition> extends Partial<CapabilityStates> {
    readonly id: UnitId;
    readonly definition: ImmutableData<D>;
    readonly position: WorldPosition;
}

export type StableUnit<U extends Unit> = {
    readonly [K in keyof U]: K extends "position"
        ? WorldPosition
        : K extends keyof CapabilityStates
          ? K extends "locomotion"
              ? NonNullable<U[K]> extends RoutedLocomotionState
                  ? RoutedLocomotionState
                  : CapabilityStates[K]
              : CapabilityStates[K]
          : U[K];
};

export function stabilizeUnit<U extends Unit>(unit: U | StableUnit<U>): StableUnit<U> {
    return unit as StableUnit<U>;
}

export function ownUnitDefinition<D extends UnitDefinition>(
    definition: D | ImmutableData<D>,
): ImmutableData<D> {
    return ownDataRecord(definition, "unit definition") as ImmutableData<D>;
}
