import type { Unit } from "../unit/unit.js";
import { blockingUsedCapacity } from "./blocking/relations.js";
import type { BattlefieldView } from "./contract.js";
import { createNavigationFieldCache, type NavigationFieldProvider } from "./navigation/cache.js";
import type { State } from "./state.js";
import {
    battlefieldTileKey,
    battlefieldOccupancyKey,
    navigationModifierSourceKey,
} from "./storage/indexes.js";

const fields: NavigationFieldProvider = createNavigationFieldCache();

export function view<U extends Unit>(
    state: State<U>,
    fieldProvider: NavigationFieldProvider = fields,
): BattlefieldView<U> {
    const map = state.map;

    return {
        map,
        navigationMaps: state.navigationMaps,
        fieldCache: fieldProvider,
        effectLifetimes: state.effectLifetimes,
        blockingRelations: state.blockingRelations,
        supportRelations: state.supportRelations,
        get unitIds() {
            return [...state.units.keys()];
        },
        get projectileIds() {
            return [...state.projectiles.keys()];
        },
        getProjectile: (id) => state.projectiles.get(id),
        get mechanismIds() {
            return [...state.mechanisms.keys()];
        },
        getMechanism: (id) => state.mechanisms.get(id),
        get navigationModifierIds() {
            return [...state.navigationModifiers.keys()];
        },
        getNavigationModifier: (id) => state.navigationModifiers.get(id),
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
        navigationModifiersAt: (position) => {
            const key = battlefieldTileKey(map, position);

            return key === undefined
                ? []
                : [...(state.spatial.navigationModifiersByTile.get(key) ?? [])];
        },
        navigationModifiersFrom: (source) => [
            ...(state.spatial.navigationModifiersBySource.get(
                navigationModifierSourceKey(source),
            ) ?? []),
        ],
        navigationModifiersFollowing: (unitId) => [
            ...(state.spatial.navigationModifiersByAnchor.get(unitId) ?? []),
        ],
    };
}
