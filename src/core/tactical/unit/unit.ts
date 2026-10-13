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

export interface Unit<D extends UnitDefinition = UnitDefinition> extends Partial<CapabilityStates> {
    readonly id: UnitId;
    readonly lifecycle: UnitLifecycle;
    readonly definition: ImmutableData<D>;
    readonly position: WorldPosition;
    readonly effects: Effects;
}
