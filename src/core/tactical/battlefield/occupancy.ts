import type { Ref } from "../../common/ref.js";
import type { TilePosition } from "../geometry/coordinate.js";
import type { Occupancy } from "../unit/capability/occupancy/capability.js";
import type { Unit } from "../unit/unit.js";
import type { State } from "./state.js";
import { battlefieldTileKey } from "./storage/indexes.js";

export interface TileOccupancy {
    readonly occupant: Ref<Unit & Occupancy> | null;
    readonly support: Ref<Unit & Occupancy> | null;
}

export function at(field: State, tile: TilePosition): TileOccupancy | undefined {
    const key = battlefieldTileKey(field.map, tile);

    return key === undefined ? undefined : field.occupancy.get(key);
}
