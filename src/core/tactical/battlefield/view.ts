import type { Unit, Id } from "../unit/unit.js";
import type { Ref } from "../../common/ref.js";
import type { View as ProjectileView } from "./projectile/projectile.js";
import { hasBlocker } from "../unit/capability/blocking/blocker.js";
import { hasBlockable, resolveVolume } from "../unit/capability/blocking/blockable.js";
import type { BattlefieldView, BlockingRelation } from "./contract.js";
import type { State } from "./state.js";
import { battlefieldTileKey } from "./storage/indexes.js";
import { at } from "./occupancy.js";
import * as support from "./support.js";
import { ref } from "../unit/query.js";

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
        get supportRelations() {
            return support.all(state).map((relation) => ({
                supportedUnitId: relation.occupant.id,
                supportUnitId: relation.support.id,
            }));
        },
        get unitIds() {
            return [...state.units.keys()];
        },
        get projectileIds() {
            return [...state.projectiles.keys()];
        },
        getProjectile: <P extends ProjectileView>(reference: Ref<P>) =>
            state.projectiles.get(reference),
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
            const occupancy = at(state, position);
            const reference = slot === "OCCUPANT" ? occupancy?.occupant : occupancy?.support;

            return reference === undefined || reference === null ? [] : [reference.id];
        },
        supportOf: (id) => {
            const unit = state.units.get(id);

            return unit === undefined ? undefined : support.of(state, ref(unit))?.support.id;
        },
        supportedBy: (id) =>
            support
                .all(state)
                .filter((relation) => relation.support.id === id)
                .map((relation) => relation.occupant.id),
    };
}
