import type { NavigationMaps, PathMotionMode } from "../navigation/map.js";
import { reconcileUnitNavigation } from "../../unit/capability/locomotion/navigation.js";
import type { StableUnit, Unit, UnitId } from "../../unit/unit.js";
import { reconcileBlockingRelations, type BlockingRelation } from "../blocking/relations.js";
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

export interface BattlefieldContent<U extends Unit> {
    readonly units: ReadonlyMap<UnitId, U>;
    readonly blockingRelations: readonly BlockingRelation[];
    readonly supportRelations: readonly SupportRelation[];
    readonly mechanisms: ReadonlyMap<MechanismId, MechanismRuntime>;
    readonly navigationModifiers: ReadonlyMap<NavigationModifierId, NavigationModifier>;
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
    const navigationModifiers = new Map<NavigationModifierId, NavigationModifier>();

    return {
        units,
        mechanisms,
        navigationModifiers,
        blockingRelations: [],
        supportRelations: [],
        navigationMaps: baseline,
        spatial: projectBattlefieldSpatial(map, units, mechanisms, navigationModifiers),
    };
}

function reconcileNavigation<U extends Unit>(
    units: ReadonlyMap<UnitId, StableUnit<U>>,
    maps: NavigationMaps,
    updatedIds?: ReadonlySet<UnitId>,
    changedModes?: readonly PathMotionMode[],
): ReadonlyMap<UnitId, StableUnit<U>> {
    let reconciled: Map<UnitId, StableUnit<U>> | undefined;
    const ids = updatedIds !== undefined && changedModes?.length === 0 ? updatedIds : units.keys();

    for (const id of ids) {
        const unit = units.get(id);

        if (unit === undefined) {
            continue;
        }

        const next = reconcileUnitNavigation<U>(
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
        content.navigationModifiers === previous.navigationModifiers &&
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
    const units = reconcileNavigation<U>(
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
    const units = reconcileNavigation<U>(content.units, projection.maps);
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
