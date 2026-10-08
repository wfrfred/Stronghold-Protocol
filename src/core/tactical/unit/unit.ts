import type { WorldPosition } from "../geometry/coordinate.js";
import { ownDataRecord, type ImmutableData } from "../../common/immutable-data.js";

export type UnitId = number;

export type UnitDefinitionId = string;

export interface UnitDefinition {
    readonly id: UnitDefinitionId;
}

export interface Unit<D extends UnitDefinition = UnitDefinition> {
    readonly id: UnitId;
    readonly definition: ImmutableData<D>;
    readonly position: WorldPosition;
}

export function ownUnitDefinition<D extends UnitDefinition>(
    definition: D | ImmutableData<D>,
): ImmutableData<D> {
    return ownDataRecord(definition, "unit definition") as ImmutableData<D>;
}
