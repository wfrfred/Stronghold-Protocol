import type { Unit, Id } from "../unit/unit.js";
import type { Ref } from "../../common/ref.js";
import type { View as ProjectileView } from "./projectile/projectile.js";
import { hasBlocker } from "../unit/capability/blocking/blocker.js";
import { hasBlockable, resolveVolume } from "../unit/capability/blocking/blockable.js";
import type { BattlefieldView, BlockingRelation } from "./contract.js";
import type { State } from "./state.js";
import { battlefieldTileKey, battlefieldOccupancyKey } from "./storage/indexes.js";

const blockingProjections = new WeakMap<ReadonlyMap<Id, Unit>, readonly BlockingRelation[]>();

function projectBlocking(units: ReadonlyMap<Id, Unit>): readonly BlockingRelation[] {
    let relations = blockingProjections.get(units);

    if (relations === undefined) {
        const projected: BlockingRelation[] = [];

        for (const unit of units.values()) {
            if (hasBlocker(unit)) {
                for (const blocked of unit.blocker.blocked) {
                    projected.push({ blockerUnitId: unit.id, blockedUnitId: blocked.id });
                }
            }
        }

        relations = projected;
        blockingProjections.set(units, relations);
    }

    return relations;
}

export function view<U extends Unit>(state: State<U>): BattlefieldView<U> {
    const map = state.map;

    return {
        map,
        navigation: state.navigation,
        effectLifetimes: state.effectLifetimes,
        get blockingRelations() {
            return projectBlocking(state.units);
        },
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
        blockerOf: (id) => {
            const unit = state.units.get(id);

            return unit !== undefined && hasBlockable(unit)
                ? unit.blockable.blocker?.id
                : undefined;
        },
        blockedBy: (id) => {
            const unit = state.units.get(id);

            return unit !== undefined && hasBlocker(unit)
                ? unit.blocker.blocked.map((blocked) => blocked.id)
                : [];
        },
        blockingUsedCapacity: (id) => {
            const unit = state.units.get(id);

            return unit !== undefined && hasBlocker(unit)
                ? unit.blocker.blocked.reduce((total, ref) => {
                      const blocked = state.units.get(ref.id);

                      return blocked !== undefined && hasBlockable(blocked)
                          ? total + resolveVolume(blocked.definition.blockable, blocked.blockable)
                          : total;
                  }, 0)
                : 0;
        },
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
