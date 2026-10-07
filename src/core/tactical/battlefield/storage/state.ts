import type { NavigationMaps, PathMotionMode } from "../navigation/map.js";
import { reconcileUnitNavigation } from "../../unit/capability/locomotion/navigation.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import { reconcileBlockingRelations, type BlockingRelation } from "../blocking/relations.js";
import type { BattlefieldChangeResult } from "../contract.js";
import {
    deriveBattlefieldDependencies,
    type BattlefieldDependencyChanges,
} from "./dependencies.js";
import type { BattlefieldMap } from "../map/map.js";
import type { MechanismId, MechanismRuntime } from "../mechanism.js";
import type { NavigationSpatialEffect, SpatialEffectId } from "../navigation/effect.js";
import { projectNavigationMaps, type NavigationProjection } from "../navigation/projection.js";
import {
    projectBattlefieldSpatial,
    projectUnitsByTile,
    projectOccupancyBySlot,
    projectEffectRelations,
    projectEffectCoverage,
    type BattlefieldSpatialView,
} from "./indexes.js";
import {
    getLostSupports,
    reconcileSupportRelations,
    type SupportRelation,
} from "../support/relations.js";

export interface BattlefieldContent<U extends Unit> {
    readonly units: ReadonlyMap<UnitId, U>;
    readonly blockingRelations: readonly BlockingRelation[];
    readonly supportRelations: readonly SupportRelation[];
    readonly mechanisms: ReadonlyMap<MechanismId, MechanismRuntime>;
    readonly effects: ReadonlyMap<SpatialEffectId, NavigationSpatialEffect>;
}

export interface BattlefieldState<U extends Unit> extends BattlefieldContent<U> {
    readonly navigationMaps: NavigationMaps;
    readonly spatial: BattlefieldSpatialView;
}

export function createBattlefieldState<U extends Unit>(
    map: BattlefieldMap,
    baseline: NavigationMaps,
): BattlefieldState<U> {
    const units = new Map<UnitId, U>();
    const mechanisms = new Map<MechanismId, MechanismRuntime>();
    const effects = new Map<SpatialEffectId, NavigationSpatialEffect>();

    return {
        units,
        mechanisms,
        effects,
        blockingRelations: [],
        supportRelations: [],
        navigationMaps: baseline,
        spatial: projectBattlefieldSpatial(map, units, mechanisms, effects),
    };
}

function reconcileNavigation<U extends Unit>(
    units: ReadonlyMap<UnitId, U>,
    maps: NavigationMaps,
    updatedIds?: ReadonlySet<UnitId>,
    changedModes?: readonly PathMotionMode[],
): ReadonlyMap<UnitId, U> {
    let reconciled: Map<UnitId, U> | undefined;
    const ids = updatedIds !== undefined && changedModes?.length === 0 ? updatedIds : units.keys();

    for (const id of ids) {
        const unit = units.get(id);

        if (unit === undefined) {
            continue;
        }

        const next = reconcileUnitNavigation(
            unit,
            maps,
            updatedIds?.has(id) === true ? undefined : changedModes,
        );

        if (next !== unit) {
            reconciled ??= new Map(units);
            reconciled.set(id, next);
        }
    }

    return reconciled ?? units;
}

function finishSettlement<U extends Unit>(
    previous: BattlefieldState<U>,
    content: BattlefieldContent<U>,
    spatial: BattlefieldSpatialView,
    projection: NavigationProjection,
): {
    readonly state: BattlefieldState<U>;
    readonly facts: Pick<BattlefieldChangeResult, "changedNavigationModes" | "lostSupports">;
} {
    const unchanged =
        content.units === previous.units &&
        content.mechanisms === previous.mechanisms &&
        content.effects === previous.effects &&
        content.blockingRelations === previous.blockingRelations &&
        content.supportRelations === previous.supportRelations &&
        spatial === previous.spatial &&
        projection.maps === previous.navigationMaps;
    const state: BattlefieldState<U> = unchanged
        ? previous
        : { ...content, spatial, navigationMaps: projection.maps };
    const lostSupports =
        content.supportRelations === previous.supportRelations
            ? []
            : getLostSupports(previous.supportRelations, content.supportRelations, content.units);

    return { state, facts: { changedNavigationModes: projection.changedModes, lostSupports } };
}

export function settleBattlefieldState<U extends Unit>(
    map: BattlefieldMap,
    baseline: NavigationMaps,
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

    if (
        dependencies.unitTiles ||
        dependencies.occupancy ||
        dependencies.effectRelations ||
        dependencies.effectCoverage
    ) {
        spatial = {
            ...(dependencies.unitTiles
                ? projectUnitsByTile(map, content.units)
                : { unitsByTile: previous.spatial.unitsByTile }),
            ...(dependencies.occupancy
                ? projectOccupancyBySlot(map, content.units)
                : { occupancyBySlot: previous.spatial.occupancyBySlot }),
            ...(dependencies.effectRelations
                ? projectEffectRelations(content.units, content.mechanisms, content.effects)
                : {
                      effectsBySource: previous.spatial.effectsBySource,
                      effectsByAnchor: previous.spatial.effectsByAnchor,
                  }),
            ...(dependencies.effectCoverage
                ? projectEffectCoverage(map, content.units, content.mechanisms, content.effects)
                : {
                      effectsByTile: previous.spatial.effectsByTile,
                      navigationEffects: previous.spatial.navigationEffects,
                  }),
        };
    }

    const projection = projectNavigationMaps(
        baseline,
        spatial.navigationEffects,
        previous.navigationMaps,
        previous.spatial.navigationEffects,
    );
    const units = reconcileNavigation(
        content.units,
        projection.maps,
        changes.updatedUnitIds,
        projection.changedModes,
    );
    const blockingRelations =
        dependencies.blocking ||
        supportRelations !== previous.supportRelations ||
        content.blockingRelations !== previous.blockingRelations
            ? reconcileBlockingRelations(map, units, content.blockingRelations, supportRelations)
            : previous.blockingRelations;

    return finishSettlement(
        previous,
        { ...content, units, supportRelations, blockingRelations },
        spatial,
        projection,
    );
}

export function settleBattlefieldStateFully<U extends Unit>(
    map: BattlefieldMap,
    baseline: NavigationMaps,
    previous: BattlefieldState<U>,
    content: BattlefieldContent<U>,
) {
    const supportRelations = reconcileSupportRelations(content.units, content.supportRelations);
    const spatial = projectBattlefieldSpatial(
        map,
        content.units,
        content.mechanisms,
        content.effects,
    );
    const projection = projectNavigationMaps(
        baseline,
        spatial.navigationEffects,
        previous.navigationMaps,
    );
    const units = reconcileNavigation(content.units, projection.maps);
    const blockingRelations = reconcileBlockingRelations(
        map,
        units,
        content.blockingRelations,
        supportRelations,
    );

    return finishSettlement(
        previous,
        { ...content, units, supportRelations, blockingRelations },
        spatial,
        projection,
    );
}
