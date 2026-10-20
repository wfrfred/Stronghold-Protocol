import { Projectiles } from "../projectile/projectiles.js";
import type { State as NavigationState } from "../navigation/state.js";
import type { Unit, Id } from "../../unit/unit.js";
import { updateBlockingRelations, type BlockingRelation } from "../blocking/relations.js";
import { synchronize as synchronizeMovement } from "../blocking/movement.js";
import type { BattlefieldChangeResult } from "../contract.js";
import {
    deriveBattlefieldDependencies,
    type BattlefieldDependencyChanges,
} from "./dependencies.js";
import type { BattlefieldMap } from "../map/map.js";
import type { MechanismId, Mechanism } from "../mechanism.js";
import {
    projectBattlefieldSpatial,
    projectUnitsByTile,
    projectOccupancyBySlot,
    type BattlefieldSpatialView,
} from "./indexes.js";
import {
    getLostSupports,
    reconcileSupportRelations,
    type SupportRelation,
} from "../support/relations.js";
import { derive, project, type Index } from "./effect-lifetimes.js";

export interface BattlefieldContent<U extends Unit> {
    readonly projectiles: Projectiles;
    readonly units: ReadonlyMap<Id, U>;
    readonly blockingRelations: readonly BlockingRelation[];
    readonly supportRelations: readonly SupportRelation[];
    readonly mechanisms: ReadonlyMap<MechanismId, Mechanism>;
}

export interface BattlefieldState<U extends Unit> extends BattlefieldContent<U> {
    readonly navigation: NavigationState;
    readonly spatial: BattlefieldSpatialView;
    readonly effectLifetimes: Index;
}

export function createBattlefieldState<U extends Unit>(
    map: BattlefieldMap,
    navigation: NavigationState,
): BattlefieldState<U> {
    const units = new Map<Id, U>();

    return {
        units,
        projectiles: Projectiles.empty(),
        mechanisms: new Map<MechanismId, Mechanism>(),
        blockingRelations: [],
        supportRelations: [],
        navigation,
        spatial: projectBattlefieldSpatial(map, units),
        effectLifetimes: project(units.values()),
    };
}

function finishSettlement<U extends Unit>(
    previous: BattlefieldState<U>,
    content: BattlefieldContent<U>,
    spatial: BattlefieldSpatialView,
    effectLifetimes: Index,
): {
    readonly state: BattlefieldState<U>;
    readonly facts: Pick<BattlefieldChangeResult, "lostSupports">;
} {
    const unchanged =
        content.units === previous.units &&
        content.projectiles === previous.projectiles &&
        content.mechanisms === previous.mechanisms &&
        content.blockingRelations === previous.blockingRelations &&
        content.supportRelations === previous.supportRelations &&
        spatial === previous.spatial &&
        effectLifetimes === previous.effectLifetimes;
    const state: BattlefieldState<U> = unchanged
        ? previous
        : { ...content, spatial, navigation: previous.navigation, effectLifetimes };
    const lostSupports =
        content.supportRelations === previous.supportRelations
            ? []
            : getLostSupports(previous.supportRelations, content.supportRelations, content.units);

    return { state, facts: { lostSupports } };
}

export function settleBattlefieldState<U extends Unit>(
    map: BattlefieldMap,
    previous: BattlefieldState<U>,
    content: BattlefieldContent<U>,
    changes: BattlefieldDependencyChanges,
) {
    const dependencies = deriveBattlefieldDependencies(map, previous, content, changes);
    const supportRelations =
        dependencies.support || content.supportRelations !== previous.supportRelations
            ? reconcileSupportRelations(content.units, content.supportRelations)
            : previous.supportRelations;
    let spatial = previous.spatial;

    if (dependencies.unitTiles || dependencies.occupancy) {
        spatial = {
            ...(dependencies.unitTiles
                ? projectUnitsByTile(map, content.units)
                : { unitsByTile: previous.spatial.unitsByTile }),
            ...(dependencies.occupancy
                ? projectOccupancyBySlot(map, content.units)
                : { occupancyBySlot: previous.spatial.occupancyBySlot }),
        };
    }

    const blockingRelations =
        dependencies.blocking ||
        supportRelations !== previous.supportRelations ||
        content.blockingRelations !== previous.blockingRelations
            ? updateBlockingRelations(
                  map,
                  content.units,
                  content.blockingRelations,
                  spatial.unitsByTile,
                  supportRelations,
              )
            : previous.blockingRelations;
    const units = synchronizeMovement(content.units, blockingRelations);

    return finishSettlement(
        previous,
        { ...content, units, supportRelations, blockingRelations },
        spatial,
        content.units === previous.units
            ? previous.effectLifetimes
            : derive(
                  previous.effectLifetimes,
                  [...changes.updatedUnitIds].map((unitId) => ({
                      previousUnit: previous.units.get(unitId),
                      nextUnit: content.units.get(unitId),
                  })),
              ),
    );
}

export function settleBattlefieldStateFully<U extends Unit>(
    map: BattlefieldMap,
    previous: BattlefieldState<U>,
    content: BattlefieldContent<U>,
) {
    const supportRelations = reconcileSupportRelations(content.units, content.supportRelations);
    const spatial = projectBattlefieldSpatial(map, content.units);
    const blockingRelations = updateBlockingRelations(
        map,
        content.units,
        content.blockingRelations,
        spatial.unitsByTile,
        supportRelations,
    );
    const units = synchronizeMovement(content.units, blockingRelations);

    return finishSettlement(
        previous,
        { ...content, units, supportRelations, blockingRelations },
        spatial,
        project(content.units.values()),
    );
}
