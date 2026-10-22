import type { Unit } from "../unit/unit.js";
import type { Ref } from "../../common/ref.js";
import type { View as ProjectileView } from "./projectile/projectile.js";
import { blockingUsedCapacity } from "./blocking/relations.js";
import type { BattlefieldView } from "./contract.js";
import type { State } from "./state.js";
import { battlefieldTileKey, battlefieldOccupancyKey } from "./storage/indexes.js";

export function view<U extends Unit>(state: State<U>): BattlefieldView<U> {
    const map = state.map;

    return {
        map,
        navigation: state.navigation,
        effectLifetimes: state.effectLifetimes,
        blockingRelations: state.blockingRelations,
        supportRelations: state.supportRelations,
        get unitIds() {
            return [...state.units.keys()];
        },
        get projectileIds() {
            return [...state.projectiles.keys()];
        },
        getProjectile: <P extends ProjectileView>(reference: Ref<P>) =>
            state.projectiles.get(reference),
        get mechanismIds() {
            return [...state.mechanisms.keys()];
        },
        getMechanism: (id) => state.mechanisms.get(id),
        getUnit: (id) => state.units.get(id),
        unitsAt: (position) => {
            const key = battlefieldTileKey(map, position);
            const ids = key === undefined ? undefined : state.spatial.unitsByTile.get(key);

            return ids === undefined ? [] : [...ids].map((id) => state.units.get(id)!);
        },
        blockerOf: (id) =>
            state.blockingRelations.find((relation) => relation.blockedUnitId === id)
                ?.blockerUnitId,
        blockedBy: (id) =>
            state.blockingRelations
                .filter((relation) => relation.blockerUnitId === id)
                .map((relation) => relation.blockedUnitId),
        blockingUsedCapacity: (id) =>
            blockingUsedCapacity(state.units, state.blockingRelations, id),
        occupancyAt: (position, slot) => {
            const key = battlefieldOccupancyKey(map, position, slot);

            return key === undefined ? [] : [...(state.spatial.occupancyBySlot.get(key) ?? [])];
        },
        supportOf: (id) =>
            state.supportRelations.find((relation) => relation.supportedUnitId === id)
                ?.supportUnitId,
        supportedBy: (id) =>
            state.supportRelations
                .filter((relation) => relation.supportUnitId === id)
                .map((relation) => relation.supportedUnitId),
    };
}
