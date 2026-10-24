import { World, type TilePosition } from "../../geometry/coordinate.js";
import type { Unit, Id } from "../../unit/unit.js";
import { isSpatiallyPresent } from "../../unit/capability/presence/capability.js";
import { hasOccupancy, type Registration } from "../../unit/capability/occupancy/capability.js";
import { ref } from "../../unit/query.js";
import { BattlefieldMap } from "../map/map.js";
import type { TileOccupancy } from "../occupancy.js";

export interface BattlefieldSpatialView {
    readonly unitsByTile: ReadonlyMap<number, ReadonlySet<Id>>;
}

export function battlefieldTileKey(
    map: BattlefieldMap,
    position: TilePosition,
): number | undefined {
    return Number.isSafeInteger(position[0]) &&
        Number.isSafeInteger(position[1]) &&
        BattlefieldMap.contains(map, position)
        ? position[0] * map.columns + position[1]
        : undefined;
}

export function sameRegistration(left: Registration | null, right: Registration | null): boolean {
    return (
        left === right ||
        (left !== null &&
            right !== null &&
            left.slot === right.slot &&
            left.tile[0] === right.tile[0] &&
            left.tile[1] === right.tile[1])
    );
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

export function deriveOccupancy(
    map: BattlefieldMap,
    previousUnits: ReadonlyMap<Id, Unit>,
    nextUnits: ReadonlyMap<Id, Unit>,
    previous: ReadonlyMap<number, TileOccupancy>,
    updatedUnitIds: ReadonlySet<Id>,
): ReadonlyMap<number, TileOccupancy> {
    const changes = [];

    for (const id of updatedUnitIds) {
        const previousUnit = previousUnits.get(id);
        const nextUnit = nextUnits.get(id);
        const before =
            previousUnit !== undefined && hasOccupancy(previousUnit)
                ? previousUnit.occupancy.registration
                : null;
        const after =
            nextUnit !== undefined && hasOccupancy(nextUnit)
                ? nextUnit.occupancy.registration
                : null;

        if (!sameRegistration(before, after)) {
            changes.push({ id, nextUnit, before, after });
        }
    }

    if (changes.length === 0) {
        return previous;
    }

    const occupancy = new Map(previous);

    for (const { before } of changes) {
        if (before === null) {
            continue;
        }

        const key = battlefieldTileKey(map, before.tile)!;
        const entry = occupancy.get(key)!;
        const slot = before.slot === "OCCUPANT" ? "occupant" : "support";
        const next = { ...entry, [slot]: null };

        if (next.occupant === null && next.support === null) {
            occupancy.delete(key);
        } else {
            occupancy.set(key, next);
        }
    }

    for (const { nextUnit, after } of changes) {
        if (nextUnit === undefined || after === null || !hasOccupancy(nextUnit)) {
            continue;
        }

        const key = battlefieldTileKey(map, after.tile);

        if (key === undefined) {
            throw new RangeError("occupancy registration is outside the battlefield");
        }

        const entry = occupancy.get(key) ?? { occupant: null, support: null };
        const slot = after.slot === "OCCUPANT" ? "occupant" : "support";

        if (entry[slot] !== null && entry[slot].id !== nextUnit.id) {
            throw new RangeError("occupancy slot is already occupied");
        }

        occupancy.set(key, { ...entry, [slot]: ref(nextUnit) });
    }

    return occupancy;
}

export function projectBattlefieldSpatial(
    map: BattlefieldMap,
    units: ReadonlyMap<Id, Unit>,
): BattlefieldSpatialView {
    return {
        ...projectUnitsByTile(map, units),
    };
}
