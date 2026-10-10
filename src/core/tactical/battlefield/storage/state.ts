import type { ProjectileId, ProjectileInstance } from "../projectile/state.js";
import type { NavigationMaps } from "../navigation/map.js";
import type { StableUnit, Unit, UnitId } from "../../unit/unit.js";
import { updateBlockingRelations, type BlockingRelation } from "../blocking/relations.js";
import type { BattlefieldChangeResult } from "../contract.js";
import {
    deriveBattlefieldDependencies,
    type BattlefieldDependencyChanges,
} from "./dependencies.js";
import type { BattlefieldMap } from "../map/map.js";
import type { MechanismId, MechanismRuntime } from "../mechanism.js";
import type { NavigationModifier, NavigationModifierId } from "../navigation/modifier.js";
import { projectNavigationMaps, type NavigationProjection } from "../navigation/projection.js";
import {
    projectBattlefieldSpatial,
    projectUnitsByTile,
    projectOccupancyBySlot,
    projectNavigationModifierRelations,
    projectNavigationModifierCoverage,
    type BattlefieldSpatialView,
} from "./indexes.js";
import {
    getLostSupports,
    reconcileSupportRelations,
    type SupportRelation,
} from "../support/relations.js";
import {
    deriveEffectLifetimes,
    projectEffectLifetimes,
    type EffectLifetimeProjection,
} from "../../unit/capability/effects/lifetime-index.js";

export interface BattlefieldContent<U extends Unit> {
    readonly projectiles: ReadonlyMap<ProjectileId, ProjectileInstance>;
    readonly units: ReadonlyMap<UnitId, U>;
    readonly blockingRelations: readonly BlockingRelation[];
    readonly supportRelations: readonly SupportRelation[];
    readonly mechanisms: ReadonlyMap<MechanismId, MechanismRuntime>;
    readonly navigationModifiers: ReadonlyMap<NavigationModifierId, NavigationModifier>;
}

export interface BattlefieldState<U extends Unit> extends BattlefieldContent<U> {
    readonly navigationMaps: NavigationMaps;
    readonly spatial: BattlefieldSpatialView;
    readonly effectLifetimes: EffectLifetimeProjection;
}

export function createBattlefieldState<U extends Unit>(
    map: BattlefieldMap,
    baseline: NavigationMaps,
): BattlefieldState<U> {
    const units = new Map<UnitId, U>();
    const mechanisms = new Map<MechanismId, MechanismRuntime>();
    const navigationModifiers = new Map<NavigationModifierId, NavigationModifier>();

    return {
        units,
        projectiles: new Map(),
        mechanisms,
        navigationModifiers,
        blockingRelations: [],
        supportRelations: [],
        navigationMaps: baseline,
        spatial: projectBattlefieldSpatial(map, units, mechanisms, navigationModifiers),
        effectLifetimes: projectEffectLifetimes(units.values()),
    };
}

function finishSettlement<U extends Unit>(
    previous: BattlefieldState<U>,
    content: BattlefieldContent<U>,
    spatial: BattlefieldSpatialView,
    projection: NavigationProjection,
    effectLifetimes: EffectLifetimeProjection,
): {
    readonly state: BattlefieldState<U>;
    readonly facts: Pick<BattlefieldChangeResult, "changedNavigationModes" | "lostSupports">;
} {
    const unchanged =
        content.units === previous.units &&
        content.projectiles === previous.projectiles &&
        content.mechanisms === previous.mechanisms &&
        content.navigationModifiers === previous.navigationModifiers &&
        content.blockingRelations === previous.blockingRelations &&
        content.supportRelations === previous.supportRelations &&
        spatial === previous.spatial &&
        projection.maps === previous.navigationMaps &&
        effectLifetimes === previous.effectLifetimes;
    const state: BattlefieldState<U> = unchanged
        ? previous
        : { ...content, spatial, navigationMaps: projection.maps, effectLifetimes };
    const lostSupports =
        content.supportRelations === previous.supportRelations
            ? []
            : getLostSupports(previous.supportRelations, content.supportRelations, content.units);

    return { state, facts: { changedNavigationModes: projection.changedModes, lostSupports } };
}

export function settleBattlefieldState<U extends Unit>(
    map: BattlefieldMap,
    baseline: NavigationMaps,
    previous: BattlefieldState<StableUnit<U>>,
    content: BattlefieldContent<StableUnit<U>>,
    changes: BattlefieldDependencyChanges,
) {
    const dependencies = deriveBattlefieldDependencies(map, previous, content, changes);
    const supportRelations =
        dependencies.support || content.supportRelations !== previous.supportRelations
            ? reconcileSupportRelations(content.units, content.supportRelations)
            : previous.supportRelations;
    let spatial = previous.spatial;

    if (
        dependencies.unitTiles ||
        dependencies.occupancy ||
        dependencies.navigationModifierRelations ||
        dependencies.navigationModifierCoverage
    ) {
        spatial = {
            ...(dependencies.unitTiles
                ? projectUnitsByTile(map, content.units)
                : { unitsByTile: previous.spatial.unitsByTile }),
            ...(dependencies.occupancy
                ? projectOccupancyBySlot(map, content.units)
                : { occupancyBySlot: previous.spatial.occupancyBySlot }),
            ...(dependencies.navigationModifierRelations
                ? projectNavigationModifierRelations(
                      content.units,
                      content.mechanisms,
                      content.navigationModifiers,
                  )
                : {
                      navigationModifiersBySource: previous.spatial.navigationModifiersBySource,
                      navigationModifiersByAnchor: previous.spatial.navigationModifiersByAnchor,
                  }),
            ...(dependencies.navigationModifierCoverage
                ? projectNavigationModifierCoverage(
                      map,
                      content.units,
                      content.mechanisms,
                      content.navigationModifiers,
                  )
                : {
                      navigationModifiersByTile: previous.spatial.navigationModifiersByTile,
                      navigationModifiers: previous.spatial.navigationModifiers,
                  }),
        };
    }

    const projection = projectNavigationMaps(
        baseline,
        spatial.navigationModifiers,
        previous.navigationMaps,
        previous.spatial.navigationModifiers,
    );
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

    return finishSettlement(
        previous,
        { ...content, supportRelations, blockingRelations },
        spatial,
        projection,
        content.units === previous.units
            ? previous.effectLifetimes
            : deriveEffectLifetimes(
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
    baseline: NavigationMaps,
    previous: BattlefieldState<StableUnit<U>>,
    content: BattlefieldContent<StableUnit<U>>,
) {
    const supportRelations = reconcileSupportRelations(content.units, content.supportRelations);
    const spatial = projectBattlefieldSpatial(
        map,
        content.units,
        content.mechanisms,
        content.navigationModifiers,
    );
    const projection = projectNavigationMaps(
        baseline,
        spatial.navigationModifiers,
        previous.navigationMaps,
    );
    const blockingRelations = updateBlockingRelations(
        map,
        content.units,
        content.blockingRelations,
        spatial.unitsByTile,
        supportRelations,
    );

    return finishSettlement(
        previous,
        { ...content, supportRelations, blockingRelations },
        spatial,
        projection,
        projectEffectLifetimes(content.units.values()),
    );
}
