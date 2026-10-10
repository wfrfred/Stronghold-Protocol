import { World, type TilePosition } from "../../geometry/coordinate.js";
import { RangeGrid } from "../../geometry/range.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import { isSpatiallyPresent } from "../../unit/capability/presence.js";
import {
    hasOccupancy,
    isOccupancyClaimActive,
    type OccupancySlot,
} from "../../unit/capability/occupancy.js";
import { BattlefieldMap } from "../map/map.js";
import type { MechanismId, Mechanism } from "../mechanism.js";
import type {
    NavigationModifier,
    NavigationModifierId,
    NavigationModifierSource,
} from "../navigation/modifier.js";
import type { ProjectedNavigationModifier } from "../navigation/projection.js";

export interface BattlefieldSpatialView {
    readonly unitsByTile: ReadonlyMap<number, ReadonlySet<UnitId>>;
    readonly occupancyBySlot: ReadonlyMap<string, ReadonlySet<UnitId>>;
    readonly navigationModifiersByTile: ReadonlyMap<number, ReadonlySet<NavigationModifierId>>;
    readonly navigationModifiersBySource: ReadonlyMap<string, ReadonlySet<NavigationModifierId>>;
    readonly navigationModifiersByAnchor: ReadonlyMap<UnitId, ReadonlySet<NavigationModifierId>>;
    readonly navigationModifiers: readonly ProjectedNavigationModifier[];
}

export function battlefieldTileKey(
    map: BattlefieldMap,
    position: TilePosition,
): number | undefined {
    return BattlefieldMap.contains(map, position)
        ? position[0] * map.columns + position[1]
        : undefined;
}

export function navigationModifierSourceKey(source: NavigationModifierSource): string {
    return source.type === "UNIT" ? `UNIT:${source.unitId}` : `MECHANISM:${source.mechanismId}`;
}

export function battlefieldOccupancyKey(
    map: BattlefieldMap,
    position: TilePosition,
    slot: OccupancySlot,
): string | undefined {
    const key = battlefieldTileKey(map, position);

    return key === undefined ? undefined : `${key}:${slot}`;
}

function indexId<K, V>(index: Map<K, Set<V>>, key: K, id: V): void {
    let ids = index.get(key);

    if (ids === undefined) {
        ids = new Set();
        index.set(key, ids);
    }

    ids.add(id);
}

function requireEntry<K extends number, V>(entries: ReadonlyMap<K, V>, id: K, name: string): V {
    const entry = entries.get(id);

    if (entry === undefined) {
        throw new RangeError(`unknown ${name}: ${id}`);
    }

    return entry;
}

export function projectUnitsByTile(
    map: BattlefieldMap,
    units: ReadonlyMap<UnitId, Unit>,
): Pick<BattlefieldSpatialView, "unitsByTile"> {
    const unitsByTile = new Map<number, Set<UnitId>>();

    for (const unit of units.values()) {
        if (!isSpatiallyPresent(unit)) {
            continue;
        }

        const tileKey = battlefieldTileKey(map, World.toTile(unit.position));

        if (tileKey !== undefined) {
            indexId(unitsByTile, tileKey, unit.id);
        }
    }

    return { unitsByTile };
}

export function projectOccupancyBySlot(
    map: BattlefieldMap,
    units: ReadonlyMap<UnitId, Unit>,
): Pick<BattlefieldSpatialView, "occupancyBySlot"> {
    const occupancyBySlot = new Map<string, Set<UnitId>>();

    for (const unit of units.values()) {
        if (!hasOccupancy(unit)) {
            continue;
        }

        for (const claim of unit.occupancy.claims) {
            if (!isOccupancyClaimActive(unit, claim)) {
                continue;
            }

            const key = battlefieldOccupancyKey(map, claim.position, claim.slot);

            if (key === undefined) {
                throw new RangeError("occupancy claim is outside the battlefield");
            }

            const occupants = occupancyBySlot.get(key);

            if (occupants !== undefined && !occupants.has(unit.id)) {
                throw new RangeError("occupancy slot is already claimed");
            }

            indexId(occupancyBySlot, key, unit.id);
        }
    }

    return { occupancyBySlot };
}

export function projectNavigationModifierRelations(
    units: ReadonlyMap<UnitId, Unit>,
    mechanisms: ReadonlyMap<MechanismId, Mechanism>,
    navigationModifiers: ReadonlyMap<NavigationModifierId, NavigationModifier>,
): Pick<BattlefieldSpatialView, "navigationModifiersBySource" | "navigationModifiersByAnchor"> {
    const navigationModifiersBySource = new Map<string, Set<NavigationModifierId>>();
    const navigationModifiersByAnchor = new Map<UnitId, Set<NavigationModifierId>>();

    for (const navigationModifier of navigationModifiers.values()) {
        if (navigationModifier.source.type === "UNIT") {
            requireEntry(
                units,
                navigationModifier.source.unitId,
                "navigation modifier source unit",
            );
        } else {
            requireEntry(
                mechanisms,
                navigationModifier.source.mechanismId,
                "navigation modifier source mechanism",
            );
        }

        indexId(
            navigationModifiersBySource,
            navigationModifierSourceKey(navigationModifier.source),
            navigationModifier.id,
        );

        if (navigationModifier.region.type === "FOLLOW_UNIT") {
            requireEntry(
                units,
                navigationModifier.region.unitId,
                "navigation modifier anchor unit",
            );
            indexId(
                navigationModifiersByAnchor,
                navigationModifier.region.unitId,
                navigationModifier.id,
            );
        }
    }

    return { navigationModifiersBySource, navigationModifiersByAnchor };
}

export function projectNavigationModifierCoverage(
    map: BattlefieldMap,
    units: ReadonlyMap<UnitId, Unit>,
    mechanisms: ReadonlyMap<MechanismId, Mechanism>,
    navigationModifiers: ReadonlyMap<NavigationModifierId, NavigationModifier>,
): Pick<BattlefieldSpatialView, "navigationModifiersByTile" | "navigationModifiers"> {
    const navigationModifiersByTile = new Map<number, Set<NavigationModifierId>>();
    const projected: ProjectedNavigationModifier[] = [];

    for (const navigationModifier of navigationModifiers.values()) {
        const sourceActive =
            navigationModifier.source.type === "UNIT"
                ? isSpatiallyPresent(units.get(navigationModifier.source.unitId)!)
                : mechanisms.get(navigationModifier.source.mechanismId)!.active;

        const region = navigationModifier.region;
        let origin: TilePosition;
        let anchorActive = true;

        if (region.type === "FIXED") {
            origin = region.position;
        } else {
            const anchor = units.get(region.unitId)!;
            anchorActive = isSpatiallyPresent(anchor);
            origin = World.toTile(anchor.position);
        }

        if (!navigationModifier.active || !sourceActive || !anchorActive) {
            continue;
        }

        const positions = RangeGrid.project(region.range, origin, region.direction).filter(
            (position) => BattlefieldMap.contains(map, position),
        );

        for (const position of positions) {
            indexId(
                navigationModifiersByTile,
                battlefieldTileKey(map, position)!,
                navigationModifier.id,
            );
        }

        projected.push({ definition: navigationModifier.definition, positions });
    }

    return { navigationModifiersByTile, navigationModifiers: projected };
}

export function projectBattlefieldSpatial(
    map: BattlefieldMap,
    units: ReadonlyMap<UnitId, Unit>,
    mechanisms: ReadonlyMap<MechanismId, Mechanism>,
    navigationModifiers: ReadonlyMap<NavigationModifierId, NavigationModifier>,
): BattlefieldSpatialView {
    return {
        ...projectUnitsByTile(map, units),
        ...projectOccupancyBySlot(map, units),
        ...projectNavigationModifierRelations(units, mechanisms, navigationModifiers),
        ...projectNavigationModifierCoverage(map, units, mechanisms, navigationModifiers),
    };
}
