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
import type { MechanismId, Mechanism } from "../mechanism.js";
import {
    projectBattlefieldSpatial,
    projectUnitsByTile,
    projectOccupancyBySlot,
    type BattlefieldSpatialView,
} from "./indexes.js";
import {
    reconcileSupportRelations,
    validateSupportRelations,
    type SupportRelation,
} from "../support/relations.js";
import { derive, project, type Index } from "./effect-lifetimes.js";

export interface BattlefieldContent<U extends Unit> {
    readonly projectiles: Projectiles;
    readonly units: ReadonlyMap<Id, U>;
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
        supportRelations: [],
        navigation,
        spatial: projectBattlefieldSpatial(map, units),
        effectLifetimes: project(units.values()),
    };
}

function finishSettlement<U extends Unit>(
    previous: FieldState<U>,
    content: BattlefieldContent<U>,
    spatial: BattlefieldSpatialView,
    effectLifetimes: Index,
): FieldState<U> {
    const unchanged =
        content.units === previous.units &&
        content.projectiles === previous.projectiles &&
        content.mechanisms === previous.mechanisms &&
        content.supportRelations === previous.supportRelations &&
        spatial === previous.spatial &&
        effectLifetimes === previous.effectLifetimes;

    return unchanged ? previous : { ...previous, ...content, spatial, effectLifetimes };
}

export function maintain<U extends Unit>(
    previous: FieldState<U>,
    content: BattlefieldContent<U>,
    changes: BattlefieldDependencyChanges = compareUnits(previous.units, content.units),
): FieldState<U> {
    const map = previous.map;
    const dependencies = deriveBattlefieldDependencies(map, previous, content, changes);

    if (content.supportRelations !== previous.supportRelations) {
        validateSupportRelations(content.units, content.supportRelations);
    }

    const supportRelations = dependencies.support
        ? reconcileSupportRelations(content.units, content.supportRelations)
        : content.supportRelations;
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

    return finishSettlement(
        previous,
        { ...content, supportRelations },
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

export function maintainFully<U extends Unit>(
    previous: FieldState<U>,
    content: BattlefieldContent<U>,
): FieldState<U> {
    const map = previous.map;

    if (content.supportRelations !== previous.supportRelations) {
        validateSupportRelations(content.units, content.supportRelations);
    }

    const supportRelations = reconcileSupportRelations(content.units, content.supportRelations);
    const spatial = projectBattlefieldSpatial(map, content.units);

    return finishSettlement(
        previous,
        { ...content, supportRelations },
        spatial,
        project(content.units.values()),
    );
}
