import { World, type TilePosition } from "../geometry/coordinate.js";
import { RangeGrid } from "../geometry/range.js";
import type { Unit, UnitId } from "../unit/unit.js";
import { isSpatiallyPresent } from "../unit/capability/presence.js";
import { BattlefieldMap } from "./map.js";
import type { MechanismId, MechanismRuntime } from "./mechanism.js";
import type {
    NavigationSpatialEffect,
    SpatialEffectId,
    SpatialEffectSource,
} from "./navigation-effect.js";
import type { ProjectedNavigationEffect } from "./navigation-projection.js";

export interface BattlefieldSpatialView {
    readonly unitsByTile: ReadonlyMap<number, ReadonlySet<UnitId>>;
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

export function projectBattlefieldSpatial(
    map: BattlefieldMap,
    units: ReadonlyMap<UnitId, Unit>,
    mechanisms: ReadonlyMap<MechanismId, MechanismRuntime>,
    effects: ReadonlyMap<SpatialEffectId, NavigationSpatialEffect>,
): BattlefieldSpatialView {
    const unitsByTile = new Map<number, Set<UnitId>>();
    const effectsByTile = new Map<number, Set<SpatialEffectId>>();
    const effectsBySource = new Map<string, Set<SpatialEffectId>>();
    const effectsByAnchor = new Map<UnitId, Set<SpatialEffectId>>();
    const navigationEffects: ProjectedNavigationEffect[] = [];

    for (const unit of units.values()) {
        if (!isSpatiallyPresent(unit)) {
            continue;
        }

        const tileKey = battlefieldTileKey(map, World.toTile(unit.position));

        if (tileKey !== undefined) {
            indexId(unitsByTile, tileKey, unit.id);
        }
    }

    for (const effect of effects.values()) {
        indexId(effectsBySource, spatialEffectSourceKey(effect.source), effect.id);

        let sourceActive: boolean;

        if (effect.source.type === "UNIT") {
            sourceActive = isSpatiallyPresent(
                requireEntry(units, effect.source.unitId, "effect source unit"),
            );
        } else {
            sourceActive = requireEntry(
                mechanisms,
                effect.source.mechanismId,
                "effect source mechanism",
            ).active;
        }

        const region = effect.region;
        let origin: TilePosition;
        let anchorActive = true;

        if (region.type === "FIXED") {
            origin = region.position;
        } else {
            const anchor = requireEntry(units, region.unitId, "effect anchor unit");
            indexId(effectsByAnchor, region.unitId, effect.id);
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

    return { unitsByTile, effectsByTile, effectsBySource, effectsByAnchor, navigationEffects };
}
