import type { WorldPosition } from "../geometry/coordinate.js";
import type { ImmutableData } from "../../common/immutable-data.js";
import type { CapabilityStates } from "./capability/catalog.js";
import type { Effects } from "./effect/effects.js";

export type UnitId = number;

export type UnitDefinitionId = string;

export type UnitLifecycle = "PRESENT" | "LEAVING";

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
    readonly lifecycle: UnitLifecycle;
    readonly definition: ImmutableData<D>;
    readonly position: WorldPosition;
    readonly effects: Effects;
}
