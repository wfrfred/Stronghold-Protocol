import { World } from "../../geometry/coordinate.js";
import { hasOccupancy } from "../../unit/capability/occupancy/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence/capability.js";
import type { Unit, Id } from "../../unit/unit.js";
import type { BattlefieldMap } from "../map/map.js";
import { battlefieldTileKey, sameRegistration } from "./indexes.js";
import type { BattlefieldContent, BattlefieldState } from "./state.js";

export interface BattlefieldDependencyChanges {
    readonly updatedUnitIds: ReadonlySet<Id>;
    readonly unitOrderChanged: boolean;
}

export function compareUnits<U extends Unit>(
    previous: ReadonlyMap<Id, U>,
    next: ReadonlyMap<Id, U>,
): BattlefieldDependencyChanges {
    const updatedUnitIds = new Set<Id>();
    let unitOrderChanged = false;

    if (previous !== next) {
        const order = next.keys();

        for (const [id, unit] of previous) {
            const current = next.get(id);
            unitOrderChanged ||= order.next().value !== id;

            if (current !== unit) {
                updatedUnitIds.add(id);
                unitOrderChanged ||= current === undefined;
            }
        }

        for (const id of next.keys()) {
            if (!previous.has(id)) {
                updatedUnitIds.add(id);
                unitOrderChanged = true;
            }
        }
    }

    return { updatedUnitIds, unitOrderChanged };
}

export function deriveBattlefieldDependencies<U extends Unit>(
    map: BattlefieldMap,
    previous: BattlefieldState<U>,
    content: BattlefieldContent<U>,
    changes: BattlefieldDependencyChanges,
) {
    let unitTiles = changes.unitOrderChanged;
    let occupancy = changes.unitOrderChanged;

    for (const id of changes.updatedUnitIds) {
        const left = previous.units.get(id);
        const right = content.units.get(id);

        if (left === undefined || right === undefined) {
            continue;
        }

        unitTiles ||= isSpatiallyPresent(left) !== isSpatiallyPresent(right);

        if (isSpatiallyPresent(left) && isSpatiallyPresent(right)) {
            unitTiles ||=
                battlefieldTileKey(map, World.toTile(left.position)) !==
                battlefieldTileKey(map, World.toTile(right.position));
        }

        occupancy ||= !sameRegistration(
            hasOccupancy(left) ? left.occupancy.registration : null,
            hasOccupancy(right) ? right.occupancy.registration : null,
        );
    }

    return { unitTiles, occupancy };
}
