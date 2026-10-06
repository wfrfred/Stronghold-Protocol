import type { TilePosition, WorldPosition } from "../geometry/coordinate.js";
import type { BattlefieldMap } from "./map.js";
import { createNavigationFieldCache } from "../navigation/cache.js";
import type { NavigationFieldCache } from "../navigation/cache.js";
import type { NavigationMaps, PathMotionMode } from "../navigation/map.js";
import type { MechanismId, MechanismRuntime } from "./mechanism.js";
import type {
    NavigationSpatialEffect, SpatialEffectId, SpatialEffectRegion, SpatialEffectSource,
} from "./navigation-effect.js";
import { createNavigationSpatialEffect } from "./navigation-effect.js";
import { copyUnitSnapshot, reconcileUnitNavigation } from "../unit/snapshot.js";
import type { Unit, UnitId } from "../unit/unit.js";
import { projectNavigationMaps, projectStaticNavigationMap } from "./navigation-projection.js";
import type { WordTileCost } from "./navigation-projection.js";
import { battlefieldTileKey, projectBattlefieldSpatial, spatialEffectSourceKey } from "./spatial.js";
import type { BattlefieldSpatialView } from "./spatial.js";

export type BattlefieldRemovalReason = "DEATH" | "RETREAT" | "EXPIRED" | "SCRIPT";

export type BattlefieldChange<U extends Unit = Unit> =
    | { readonly type: "REGISTER_UNIT"; readonly unit: U; }
    | { readonly type: "UPDATE_UNIT"; readonly unit: U; }
    | { readonly type: "MOVE_UNIT"; readonly unitId: UnitId; readonly position: WorldPosition; }
    | { readonly type: "REMOVE_UNIT"; readonly unitId: UnitId; readonly reason: BattlefieldRemovalReason; }
    | { readonly type: "REGISTER_MECHANISM"; readonly mechanism: MechanismRuntime; }
    | { readonly type: "SET_MECHANISM_ACTIVE"; readonly mechanismId: MechanismId; readonly active: boolean; }
    | { readonly type: "REMOVE_MECHANISM"; readonly mechanismId: MechanismId; readonly reason: BattlefieldRemovalReason; }
    | { readonly type: "ADD_EFFECT"; readonly effect: NavigationSpatialEffect; }
    | { readonly type: "SET_EFFECT_ACTIVE"; readonly effectId: SpatialEffectId; readonly active: boolean; }
    | { readonly type: "SET_EFFECT_REGION"; readonly effectId: SpatialEffectId; readonly region: SpatialEffectRegion; }
    | { readonly type: "REMOVE_EFFECT"; readonly effectId: SpatialEffectId; }
    | { readonly type: "EXPIRE_EFFECTS"; readonly tick: number; };

export interface BattlefieldChangeResult {
    readonly changedNavigationModes: readonly PathMotionMode[];
    readonly removedUnits: readonly { readonly unitId: UnitId; readonly reason: BattlefieldRemovalReason; }[];
    readonly removedMechanisms: readonly { readonly mechanismId: MechanismId; readonly reason: BattlefieldRemovalReason; }[];
    readonly removedEffects: readonly SpatialEffectId[];
}

export interface BattlefieldRuntimeOptions {
    readonly map: BattlefieldMap;
    readonly wordTileCosts?: readonly WordTileCost[];
}

function requireEntry<K, V>(entries: ReadonlyMap<K, V>, id: K, name: string): V {
    const entry = entries.get(id);
    if (entry === undefined) throw new RangeError(`unknown ${name}: ${id}`);
    return entry;
}

function register<K extends number, V>(entries: Map<K, V>, id: K, value: V, name: string): void {
    if (entries.has(id)) throw new RangeError(`duplicate ${name}: ${id}`);
    entries.set(id, value);
}

export class BattlefieldRuntime<U extends Unit = Unit> {
    readonly #map: BattlefieldMap;
    readonly #baseline: NavigationMaps;
    readonly #fieldCache = createNavigationFieldCache();
    readonly #copyUnit: (unit: Readonly<U>) => U;
    #navigationMaps: NavigationMaps;
    #units = new Map<UnitId, U>();
    #mechanisms = new Map<MechanismId, MechanismRuntime>();
    #effects = new Map<SpatialEffectId, NavigationSpatialEffect>();
    #spatial: BattlefieldSpatialView;
    #pendingInvalidations: Set<NavigationMaps[PathMotionMode]> | null = null;

    constructor(options: BattlefieldRuntimeOptions, copyUnit: (unit: Readonly<U>) => U) {
        this.#copyUnit = copyUnit;
        this.#map = options.map;
        this.#baseline = Object.freeze({
            WALK: projectStaticNavigationMap(options.map, "WALK", 0, options.wordTileCosts),
            FLY: projectStaticNavigationMap(options.map, "FLY", 0, options.wordTileCosts),
        });
        this.#navigationMaps = this.#baseline;
        this.#spatial = projectBattlefieldSpatial(this.#map, this.#units, this.#mechanisms, this.#effects);
    }

    get map(): BattlefieldMap { return this.#map; }
    get navigationMaps(): NavigationMaps { return this.#navigationMaps; }
    get fieldCache(): NavigationFieldCache { return this.#fieldCache; }
    get unitIds(): readonly UnitId[] { return [...this.#units.keys()]; }
    get mechanismIds(): readonly MechanismId[] { return [...this.#mechanisms.keys()]; }
    get effectIds(): readonly SpatialEffectId[] { return [...this.#effects.keys()]; }

    getUnit(id: UnitId): U | undefined {
        const unit = this.#units.get(id);
        return unit === undefined ? undefined : this.#copyUnit(unit);
    }

    getMechanism(id: MechanismId): MechanismRuntime | undefined {
        const mechanism = this.#mechanisms.get(id);
        return mechanism === undefined ? undefined : { ...mechanism };
    }

    getEffect(id: SpatialEffectId): NavigationSpatialEffect | undefined {
        const effect = this.#effects.get(id);
        return effect === undefined ? undefined : { ...effect };
    }

    unitsAt(position: TilePosition): readonly U[] {
        const key = battlefieldTileKey(this.#map, position);
        const ids = key === undefined ? undefined : this.#spatial.unitsByTile.get(key);
        return ids === undefined ? [] : [...ids].map(id => this.#copyUnit(this.#units.get(id)!));
    }

    effectsAt(position: TilePosition): readonly SpatialEffectId[] {
        const key = battlefieldTileKey(this.#map, position);
        return key === undefined ? [] : [...(this.#spatial.effectsByTile.get(key) ?? [])];
    }

    effectsFrom(source: SpatialEffectSource): readonly SpatialEffectId[] {
        return [...(this.#spatial.effectsBySource.get(spatialEffectSourceKey(source)) ?? [])];
    }

    effectsFollowing(unitId: UnitId): readonly SpatialEffectId[] {
        return [...(this.#spatial.effectsByAnchor.get(unitId) ?? [])];
    }

    transact<T>(operation: (battlefield: BattlefieldRuntime<U>) => T): T {
        if (this.#pendingInvalidations !== null) throw new Error("battlefield transaction is already active");
        const units = this.#units;
        const mechanisms = this.#mechanisms;
        const effects = this.#effects;
        const spatial = this.#spatial;
        const maps = this.#navigationMaps;
        const invalidations = new Set<NavigationMaps[PathMotionMode]>();
        this.#pendingInvalidations = invalidations;
        try {
            const result = operation(this);
            for (const map of invalidations) this.#fieldCache.invalidate(map);
            return result;
        } catch (error) {
            this.#units = units;
            this.#mechanisms = mechanisms;
            this.#effects = effects;
            this.#spatial = spatial;
            this.#navigationMaps = maps;
            throw error;
        } finally {
            this.#pendingInvalidations = null;
        }
    }

    apply(changes: readonly BattlefieldChange<U>[]): BattlefieldChangeResult {
        const units = new Map(this.#units);
        const mechanisms = new Map(this.#mechanisms);
        const effects = new Map(this.#effects);
        const removedUnits: { unitId: UnitId; reason: BattlefieldRemovalReason; }[] = [];
        const removedMechanisms: { mechanismId: MechanismId; reason: BattlefieldRemovalReason; }[] = [];
        const removedEffects = new Set<SpatialEffectId>();
        const removeEffect = (id: SpatialEffectId): void => {
            effects.delete(id);
            removedEffects.add(id);
        };
        for (const change of changes) {
            switch (change.type) {
                case "REGISTER_UNIT":
                    if (!Number.isSafeInteger(change.unit.id) || change.unit.id < 0) throw new RangeError("invalid unit id");
                    register(units, change.unit.id, this.#copyUnit(change.unit), "unit");
                    break;
                case "UPDATE_UNIT": {
                    const previous = requireEntry(units, change.unit.id, "unit");
                    if (previous.definition !== change.unit.definition) throw new RangeError("unit definition cannot change during update");
                    units.set(change.unit.id, this.#copyUnit(change.unit));
                    break;
                }
                case "MOVE_UNIT": {
                    const unit = requireEntry(units, change.unitId, "unit");
                    units.set(change.unitId, { ...unit, position: change.position });
                    break;
                }
                case "REMOVE_UNIT":
                    requireEntry(units, change.unitId, "unit");
                    units.delete(change.unitId);
                    removedUnits.push({ unitId: change.unitId, reason: change.reason });
                    for (const effect of effects.values()) {
                        if ((effect.source.type === "UNIT" && effect.source.unitId === change.unitId)
                            || (effect.region.type === "FOLLOW_UNIT" && effect.region.unitId === change.unitId)) {
                            removeEffect(effect.id);
                        }
                    }
                    break;
                case "REGISTER_MECHANISM":
                    register(mechanisms, change.mechanism.id, {
                        id: change.mechanism.id,
                        definition: change.mechanism.definition,
                        active: change.mechanism.active,
                    }, "mechanism");
                    break;
                case "SET_MECHANISM_ACTIVE":
                    mechanisms.set(change.mechanismId, { ...requireEntry(mechanisms, change.mechanismId, "mechanism"), active: change.active });
                    break;
                case "REMOVE_MECHANISM":
                    requireEntry(mechanisms, change.mechanismId, "mechanism");
                    mechanisms.delete(change.mechanismId);
                    removedMechanisms.push({ mechanismId: change.mechanismId, reason: change.reason });
                    for (const effect of effects.values()) {
                        if (effect.source.type === "MECHANISM" && effect.source.mechanismId === change.mechanismId) removeEffect(effect.id);
                    }
                    break;
                case "ADD_EFFECT":
                    register(effects, change.effect.id, createNavigationSpatialEffect(change.effect), "effect");
                    break;
                case "SET_EFFECT_ACTIVE":
                    effects.set(change.effectId, { ...requireEntry(effects, change.effectId, "effect"), active: change.active });
                    break;
                case "SET_EFFECT_REGION":
                    effects.set(change.effectId, { ...requireEntry(effects, change.effectId, "effect"), region: change.region });
                    break;
                case "REMOVE_EFFECT":
                    requireEntry(effects, change.effectId, "effect");
                    removeEffect(change.effectId);
                    break;
                case "EXPIRE_EFFECTS":
                    if (!Number.isSafeInteger(change.tick) || change.tick < 0) throw new RangeError("effect expiry tick must be a nonnegative safe integer");
                    for (const effect of effects.values()) {
                        if (effect.expiresAtTick !== null && effect.expiresAtTick <= change.tick) removeEffect(effect.id);
                    }
                    break;
            }
        }
        const spatial = projectBattlefieldSpatial(this.#map, units, mechanisms, effects);
        const projection = projectNavigationMaps(this.#baseline, spatial.navigationEffects, this.#navigationMaps);
        for (const [id, unit] of units) units.set(id, reconcileUnitNavigation(unit, projection.maps));
        const previousMaps = this.#navigationMaps;
        this.#units = units;
        this.#mechanisms = mechanisms;
        this.#effects = effects;
        this.#spatial = spatial;
        this.#navigationMaps = projection.maps;
        for (const mode of projection.changedModes) {
            if (this.#pendingInvalidations === null) this.#fieldCache.invalidate(previousMaps[mode]);
            else this.#pendingInvalidations.add(previousMaps[mode]);
        }
        return {
            changedNavigationModes: projection.changedModes,
            removedUnits, removedMechanisms, removedEffects: [...removedEffects],
        };
    }
}

export function createBattlefieldRuntime(options: BattlefieldRuntimeOptions): BattlefieldRuntime<Unit>;
export function createBattlefieldRuntime<U extends Unit>(
    options: BattlefieldRuntimeOptions,
    copyUnit: (unit: Readonly<U>) => U,
): BattlefieldRuntime<U>;
export function createBattlefieldRuntime<U extends Unit>(
    options: BattlefieldRuntimeOptions,
    copyUnit?: (unit: Readonly<U>) => U,
): BattlefieldRuntime<Unit> | BattlefieldRuntime<U> {
    return copyUnit === undefined
        ? new BattlefieldRuntime<Unit>(options, copyUnitSnapshot)
        : new BattlefieldRuntime<U>(options, copyUnit);
}
