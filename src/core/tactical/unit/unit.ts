import type { WorldPosition } from "../geometry/coordinate.js";
import type { ImmutableData } from "../../common/immutable-data.js";
import type { CapabilityStates, WidenedCapabilityState } from "./capability/catalog.js";

export type UnitId = number;

export type UnitDefinitionId = string;

export interface UnitDefinition {
    readonly id: UnitDefinitionId;
}

type OptionalDefinitionKeys<D extends UnitDefinition> = {
    [K in keyof D]-?: object extends Pick<D, K> ? K : never;
}[keyof D];

export type NormalizedUnitDefinition<
    D extends UnitDefinition,
    Shape extends UnitDefinition,
> = D extends unknown
    ? Omit<Shape, OptionalDefinitionKeys<Shape>> & {
          readonly [
              K in keyof D as K extends OptionalDefinitionKeys<Shape> ? K : never
          ]: K extends keyof Shape ? Exclude<Shape[K], undefined> : never;
      }
    : never;

export interface Unit<D extends UnitDefinition = UnitDefinition> extends Partial<CapabilityStates> {
    readonly id: UnitId;
    readonly definition: ImmutableData<D>;
    readonly position: WorldPosition;
}

export type StableUnit<U extends Unit> = {
    readonly [K in keyof U]: K extends "position"
        ? WorldPosition
        : K extends keyof CapabilityStates
          ? WidenedCapabilityState<K, U[K]>
          : U[K];
};

export function widenUnit<U extends Unit>(unit: U | StableUnit<U>): StableUnit<U> {
    return unit as StableUnit<U>;
}
