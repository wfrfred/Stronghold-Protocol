import { World, type TilePosition } from "../../geometry/coordinate.js";
import type { Unit, Id } from "../../unit/unit.js";
import { isSpatiallyPresent } from "../../unit/capability/presence/capability.js";
import {
    hasOccupancy,
    isOccupancyClaimActive,
    type OccupancySlot,
} from "../../unit/capability/occupancy/capability.js";
import { BattlefieldMap } from "../map/map.js";

export interface BattlefieldSpatialView {
    readonly unitsByTile: ReadonlyMap<number, ReadonlySet<Id>>;
    readonly occupancyBySlot: ReadonlyMap<string, ReadonlySet<Id>>;
}

export function battlefieldTileKey(
    map: BattlefieldMap,
    position: TilePosition,
): number | undefined {
    return BattlefieldMap.contains(map, position)
        ? position[0] * map.columns + position[1]
        : undefined;
}

export function battlefieldOccupancyKey(
    map: BattlefieldMap,
    position: TilePosition,
    slot: OccupancySlot,
): string | undefined {
    const key = battlefieldTileKey(map, position);

    return key === undefined ? undefined : `${key}:${slot}`;
}

function indexId<K, V>(index: Map<K, Set<V>>, key: K, id: V): void {
    let ids = index.get(key);

    if (ids === undefined) {
        ids = new Set();
        index.set(key, ids);
    }

    ids.add(id);
}

export function projectUnitsByTile(
    map: BattlefieldMap,
    units: ReadonlyMap<Id, Unit>,
): Pick<BattlefieldSpatialView, "unitsByTile"> {
    const unitsByTile = new Map<number, Set<Id>>();

    for (const unit of units.values()) {
        if (!isSpatiallyPresent(unit)) {
            continue;
        }

        const tileKey = battlefieldTileKey(map, World.toTile(unit.position));

        if (tileKey !== undefined) {
            indexId(unitsByTile, tileKey, unit.id);
        }
    }

    return { unitsByTile };
}

export function projectOccupancyBySlot(
    map: BattlefieldMap,
    units: ReadonlyMap<Id, Unit>,
): Pick<BattlefieldSpatialView, "occupancyBySlot"> {
    const occupancyBySlot = new Map<string, Set<Id>>();

    for (const unit of units.values()) {
        if (!hasOccupancy(unit)) {
            continue;
        }

        for (const claim of unit.occupancy.claims) {
            if (!isOccupancyClaimActive(unit, claim)) {
                continue;
            }

            const key = battlefieldOccupancyKey(map, claim.position, claim.slot);

            if (key === undefined) {
                throw new RangeError("occupancy claim is outside the battlefield");
            }

            const occupants = occupancyBySlot.get(key);

            if (occupants !== undefined && !occupants.has(unit.id)) {
                throw new RangeError("occupancy slot is already claimed");
            }

            indexId(occupancyBySlot, key, unit.id);
        }
    }

    return { occupancyBySlot };
}

export function projectBattlefieldSpatial(
    map: BattlefieldMap,
    units: ReadonlyMap<Id, Unit>,
): BattlefieldSpatialView {
    return {
        ...projectUnitsByTile(map, units),
        ...projectOccupancyBySlot(map, units),
    };
}
