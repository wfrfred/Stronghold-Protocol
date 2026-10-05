import type { WorldPosition } from "../../geometry/coordinate.js";

export type UnitId = number;
export type UnitDefinitionId = string;

export interface UnitDefinition {
    readonly id: UnitDefinitionId;
}

export interface Unit<D extends UnitDefinition = UnitDefinition> {
    readonly id: UnitId;
    readonly definition: D;
    position: WorldPosition;
}
