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
import type { MechanismId, MechanismRuntime } from "../mechanism.js";
import type {
    NavigationSpatialEffect,
    SpatialEffectId,
    SpatialEffectSource,
} from "../navigation/effect.js";
import type { ProjectedNavigationEffect } from "../navigation/projection.js";

export interface BattlefieldSpatialView {
    readonly unitsByTile: ReadonlyMap<number, ReadonlySet<UnitId>>;
    readonly occupancyBySlot: ReadonlyMap<string, ReadonlySet<UnitId>>;
    readonly effectsByTile: ReadonlyMap<number, ReadonlySet<SpatialEffectId>>;
    readonly effectsBySource: ReadonlyMap<string, ReadonlySet<SpatialEffectId>>;
    readonly effectsByAnchor: ReadonlyMap<UnitId, ReadonlySet<SpatialEffectId>>;
    readonly navigationEffects: readonly ProjectedNavigationEffect[];
}

export function battlefieldTileKey(
    map: BattlefieldMap,
    position: TilePosition,
): number | undefined {
    return BattlefieldMap.contains(map, position)
        ? position[0] * map.columns + position[1]
        : undefined;
}

export function spatialEffectSourceKey(source: SpatialEffectSource): string {
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

export function projectEffectRelations(
    units: ReadonlyMap<UnitId, Unit>,
    mechanisms: ReadonlyMap<MechanismId, MechanismRuntime>,
    effects: ReadonlyMap<SpatialEffectId, NavigationSpatialEffect>,
): Pick<BattlefieldSpatialView, "effectsBySource" | "effectsByAnchor"> {
    const effectsBySource = new Map<string, Set<SpatialEffectId>>();
    const effectsByAnchor = new Map<UnitId, Set<SpatialEffectId>>();

    for (const effect of effects.values()) {
        if (effect.source.type === "UNIT") {
            requireEntry(units, effect.source.unitId, "effect source unit");
        } else {
            requireEntry(mechanisms, effect.source.mechanismId, "effect source mechanism");
        }

        indexId(effectsBySource, spatialEffectSourceKey(effect.source), effect.id);

        if (effect.region.type === "FOLLOW_UNIT") {
            requireEntry(units, effect.region.unitId, "effect anchor unit");
            indexId(effectsByAnchor, effect.region.unitId, effect.id);
        }
    }

    return { effectsBySource, effectsByAnchor };
}

export function projectEffectCoverage(
    map: BattlefieldMap,
    units: ReadonlyMap<UnitId, Unit>,
    mechanisms: ReadonlyMap<MechanismId, MechanismRuntime>,
    effects: ReadonlyMap<SpatialEffectId, NavigationSpatialEffect>,
): Pick<BattlefieldSpatialView, "effectsByTile" | "navigationEffects"> {
    const effectsByTile = new Map<number, Set<SpatialEffectId>>();
    const navigationEffects: ProjectedNavigationEffect[] = [];

    for (const effect of effects.values()) {
        const sourceActive =
            effect.source.type === "UNIT"
                ? isSpatiallyPresent(units.get(effect.source.unitId)!)
                : mechanisms.get(effect.source.mechanismId)!.active;

        const region = effect.region;
        let origin: TilePosition;
        let anchorActive = true;

        if (region.type === "FIXED") {
            origin = region.position;
        } else {
            const anchor = units.get(region.unitId)!;
            anchorActive = isSpatiallyPresent(anchor);
            origin = World.toTile(anchor.position);
        }

        if (!effect.active || !sourceActive || !anchorActive) {
            continue;
        }

        const positions = RangeGrid.project(region.range, origin, region.direction).filter(
            (position) => BattlefieldMap.contains(map, position),
        );

        for (const position of positions) {
            indexId(effectsByTile, battlefieldTileKey(map, position)!, effect.id);
        }

        navigationEffects.push({ definition: effect.definition, positions });
    }

    return { effectsByTile, navigationEffects };
}

export function projectBattlefieldSpatial(
    map: BattlefieldMap,
    units: ReadonlyMap<UnitId, Unit>,
    mechanisms: ReadonlyMap<MechanismId, MechanismRuntime>,
    effects: ReadonlyMap<SpatialEffectId, NavigationSpatialEffect>,
): BattlefieldSpatialView {
    return {
        ...projectUnitsByTile(map, units),
        ...projectOccupancyBySlot(map, units),
        ...projectEffectRelations(units, mechanisms, effects),
        ...projectEffectCoverage(map, units, mechanisms, effects),
    };
}
