import { Projectiles } from "../projectile/projectiles.js";
import type { State as NavigationState } from "../navigation/state.js";
import type { Unit, Id } from "../../unit/unit.js";
import type { State as FieldState } from "../state.js";
import {
    compareUnits,
    deriveBattlefieldDependencies,
    type BattlefieldDependencyChanges,
} from "./dependencies.js";
import type { BattlefieldMap } from "../map/map.js";
import {
    projectBattlefieldSpatial,
    projectUnitsByTile,
    deriveOccupancy,
    type BattlefieldSpatialView,
} from "./indexes.js";
import type { TileOccupancy } from "../occupancy.js";

export interface BattlefieldContent<U extends Unit> {
    readonly projectiles: Projectiles;
    readonly units: ReadonlyMap<Id, U>;
}

export interface BattlefieldState<U extends Unit> extends BattlefieldContent<U> {
    readonly navigation: NavigationState;
    readonly occupancy: ReadonlyMap<number, TileOccupancy>;
    readonly spatial: BattlefieldSpatialView;
}

export function createBattlefieldState<U extends Unit>(
    map: BattlefieldMap,
    navigation: NavigationState,
): BattlefieldState<U> {
    const units = new Map<Id, U>();

    return {
        units,
        projectiles: Projectiles.empty(),
        occupancy: new Map(),
        navigation,
        spatial: projectBattlefieldSpatial(map, units),
    };
}

function finishSettlement<U extends Unit>(
    previous: FieldState<U>,
    content: BattlefieldContent<U>,
    occupancy: ReadonlyMap<number, TileOccupancy>,
    spatial: BattlefieldSpatialView,
): FieldState<U> {
    const unchanged =
        content.units === previous.units &&
        content.projectiles === previous.projectiles &&
        occupancy === previous.occupancy &&
        spatial === previous.spatial;

    return unchanged ? previous : { ...previous, ...content, occupancy, spatial };
}

export function maintain<U extends Unit>(
    previous: FieldState<U>,
    content: BattlefieldContent<U>,
    changes: BattlefieldDependencyChanges = compareUnits(previous.units, content.units),
): FieldState<U> {
    const map = previous.map;
    const dependencies = deriveBattlefieldDependencies(map, previous, content, changes);

    return finishSettlement(
        previous,
        content,
        dependencies.occupancy
            ? deriveOccupancy(
                  map,
                  previous.units,
                  content.units,
                  previous.occupancy,
                  changes.updatedUnitIds,
              )
            : previous.occupancy,
        dependencies.unitTiles ? projectUnitsByTile(map, content.units) : previous.spatial,
    );
}
