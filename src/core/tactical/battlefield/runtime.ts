import {
    createWorldPosition,
    type TilePosition,
    type WorldPosition,
} from "../geometry/coordinate.js";
import type { BattlefieldMap } from "./map.js";
import { createNavigationFieldCache, type NavigationFieldCache } from "../navigation/cache.js";
import type { NavigationMaps, PathMotionMode } from "../navigation/map.js";
import type { MechanismId, MechanismRuntime } from "./mechanism.js";
import {
    copyNavigationSpatialEffect,
    createNavigationSpatialEffect,
    createSpatialEffectRegion,
    type NavigationSpatialEffect,
    type SpatialEffectId,
    type SpatialEffectRegion,
    type SpatialEffectSource,
} from "./navigation-effect.js";
import { copyUnitSnapshot, reconcileUnitNavigation } from "../unit/snapshot.js";
import { assertUnitCapabilityConsistency } from "../unit/capability/catalog.js";
import type { Unit, UnitId } from "../unit/unit.js";
import type { OccupancySlot } from "../unit/capability/occupancy.js";
import {
    getLostSupports,
    reconcileSupportRelations,
    validateSupportRelations,
    type SupportRelation,
} from "./support.js";
import {
    blockingUsedCapacity,
    reconcileBlockingRelations,
    releaseBlockingRelations,
    type BlockingRelation,
} from "./blocking.js";
import { projectNavigationMaps, projectStaticNavigationMap } from "./navigation-projection.js";
import {
    battlefieldTileKey,
    battlefieldOccupancyKey,
    projectBattlefieldSpatial,
    spatialEffectSourceKey,
    type BattlefieldSpatialView,
} from "./spatial.js";

export type BattlefieldRemovalReason = "DEATH" | "RETREAT" | "EXPIRED" | "SCRIPT";

export type BattlefieldChange<U extends Unit = Unit> =
    | { readonly type: "REGISTER_UNIT"; readonly unit: U }
    | { readonly type: "UPDATE_UNIT"; readonly unit: U }
    | {
          readonly type: "SET_BLOCKING_RELATIONS";
          readonly relations: readonly BlockingRelation[];
      }
    | { readonly type: "SET_SUPPORT_RELATIONS"; readonly relations: readonly SupportRelation[] }
    | { readonly type: "RELEASE_BLOCKING_RELATIONS"; readonly unitId: UnitId }
    | { readonly type: "MOVE_UNIT"; readonly unitId: UnitId; readonly position: WorldPosition }
    | {
          readonly type: "REMOVE_UNIT";
          readonly unitId: UnitId;
          readonly reason: BattlefieldRemovalReason;
      }
    | { readonly type: "REGISTER_MECHANISM"; readonly mechanism: MechanismRuntime }
    | {
          readonly type: "SET_MECHANISM_ACTIVE";
          readonly mechanismId: MechanismId;
          readonly active: boolean;
      }
    | {
          readonly type: "REMOVE_MECHANISM";
          readonly mechanismId: MechanismId;
          readonly reason: BattlefieldRemovalReason;
      }
    | { readonly type: "ADD_EFFECT"; readonly effect: NavigationSpatialEffect }
    | {
          readonly type: "SET_EFFECT_ACTIVE";
          readonly effectId: SpatialEffectId;
          readonly active: boolean;
      }
    | {
          readonly type: "SET_EFFECT_REGION";
          readonly effectId: SpatialEffectId;
          readonly region: SpatialEffectRegion;
      }
    | { readonly type: "REMOVE_EFFECT"; readonly effectId: SpatialEffectId }
    | { readonly type: "EXPIRE_EFFECTS"; readonly tick: number };

export interface BattlefieldChangeResult {
    readonly changedNavigationModes: readonly PathMotionMode[];
    readonly removedUnits: readonly {
        readonly unitId: UnitId;
        readonly reason: BattlefieldRemovalReason;
    }[];
    readonly removedMechanisms: readonly {
        readonly mechanismId: MechanismId;
        readonly reason: BattlefieldRemovalReason;
    }[];
    readonly removedEffects: readonly SpatialEffectId[];
    readonly lostSupports: readonly SupportRelation[];
}

export interface BattlefieldRuntimeOptions {
    readonly map: BattlefieldMap;
}

export interface BattlefieldView<U extends Unit = Unit> {
    readonly map: BattlefieldMap;
    readonly navigationMaps: NavigationMaps;
    readonly fieldCache: NavigationFieldCache;
    readonly unitIds: readonly UnitId[];
    readonly blockingRelations: readonly BlockingRelation[];
    readonly supportRelations: readonly SupportRelation[];
    getUnit(id: UnitId): U | undefined;
    unitsAt(position: TilePosition): readonly U[];
    blockerOf(unitId: UnitId): UnitId | undefined;
    blockedBy(unitId: UnitId): readonly UnitId[];
    blockingUsedCapacity(unitId: UnitId): number;
    occupancyAt(position: TilePosition, slot: OccupancySlot): readonly UnitId[];
    supportOf(unitId: UnitId): UnitId | undefined;
    supportedBy(unitId: UnitId): readonly UnitId[];
}

export interface Battlefield<U extends Unit = Unit> extends BattlefieldView<U> {
    readonly mechanismIds: readonly MechanismId[];
    readonly effectIds: readonly SpatialEffectId[];
    getMechanism(id: MechanismId): MechanismRuntime | undefined;
    getEffect(id: SpatialEffectId): NavigationSpatialEffect | undefined;
    effectsAt(position: TilePosition): readonly SpatialEffectId[];
    effectsFrom(source: SpatialEffectSource): readonly SpatialEffectId[];
    effectsFollowing(unitId: UnitId): readonly SpatialEffectId[];
    fork(): Battlefield<U>;
    transact<T>(operation: (battlefield: Battlefield<U>) => T): T;
    apply(changes: readonly BattlefieldChange<U>[]): BattlefieldChangeResult;
}

interface BattlefieldResources<U extends Unit> {
    readonly map: BattlefieldMap;
    readonly baseline: NavigationMaps;
    readonly fieldCache: NavigationFieldCache;
    readonly copyUnit: (unit: Readonly<U>) => U;
}

interface BattlefieldState<U extends Unit> {
    readonly navigationMaps: NavigationMaps;
    readonly units: ReadonlyMap<UnitId, U>;
    readonly blockingRelations: readonly BlockingRelation[];
    readonly supportRelations: readonly SupportRelation[];
    readonly mechanisms: ReadonlyMap<MechanismId, MechanismRuntime>;
    readonly effects: ReadonlyMap<SpatialEffectId, NavigationSpatialEffect>;
    readonly spatial: BattlefieldSpatialView;
}

function requireEntry<K extends number, V>(entries: ReadonlyMap<K, V>, id: K, name: string): V {
    const entry = entries.get(id);

    if (entry === undefined) {
        throw new RangeError(`unknown ${name}: ${id}`);
    }

    return entry;
}

function register<K extends number, V>(entries: Map<K, V>, id: K, value: V, name: string): void {
    if (entries.has(id)) {
        throw new RangeError(`duplicate ${name}: ${id}`);
    }

    entries.set(id, value);
}

export class BattlefieldRuntime<U extends Unit = Unit> {
    readonly #resources: BattlefieldResources<U>;
    readonly #view: BattlefieldView<U>;
    #state: BattlefieldState<U>;
    #pendingInvalidations: Set<NavigationMaps[PathMotionMode]> | null = null;

    private constructor(resources: BattlefieldResources<U>, state: BattlefieldState<U>) {
        this.#resources = resources;
        this.#state = state;

        const runtime = this;
        this.#view = {
            get map() {
                return runtime.map;
            },
            get navigationMaps() {
                return runtime.navigationMaps;
            },
            get fieldCache() {
                return runtime.fieldCache;
            },
            get unitIds() {
                return runtime.unitIds;
            },
            get blockingRelations() {
                return runtime.#state.blockingRelations;
            },
            get supportRelations() {
                return runtime.#state.supportRelations;
            },
            getUnit: (id) => runtime.#state.units.get(id),
            unitsAt: (position) => runtime.#unitsAt(position),
            blockerOf: (id) => runtime.blockerOf(id),
            blockedBy: (id) => runtime.blockedBy(id),
            blockingUsedCapacity: (id) => runtime.blockingUsedCapacity(id),
            occupancyAt: (position, slot) => runtime.occupancyAt(position, slot),
            supportOf: (id) => runtime.supportOf(id),
            supportedBy: (id) => runtime.supportedBy(id),
        };
    }

    static create<U extends Unit>(
        options: BattlefieldRuntimeOptions,
        copyUnit: (unit: Readonly<U>) => U,
    ): BattlefieldRuntime<U> {
        const baseline = Object.freeze({
            WALK: projectStaticNavigationMap(options.map, "WALK", 0),
            FLY: projectStaticNavigationMap(options.map, "FLY", 0),
        });
        const units = new Map<UnitId, U>();
        const mechanisms = new Map<MechanismId, MechanismRuntime>();
        const effects = new Map<SpatialEffectId, NavigationSpatialEffect>();

        return new BattlefieldRuntime(
            { map: options.map, baseline, copyUnit, fieldCache: createNavigationFieldCache() },
            {
                navigationMaps: baseline,
                units,
                blockingRelations: [],
                supportRelations: [],
                mechanisms,
                effects,
                spatial: projectBattlefieldSpatial(options.map, units, mechanisms, effects),
            },
        );
    }

    fork(): BattlefieldRuntime<U> {
        return new BattlefieldRuntime(this.#resources, this.#state);
    }

    get map(): BattlefieldMap {
        return this.#resources.map;
    }

    get view(): BattlefieldView<U> {
        return this.#view;
    }

    get navigationMaps(): NavigationMaps {
        return this.#state.navigationMaps;
    }

    get fieldCache(): NavigationFieldCache {
        return this.#resources.fieldCache;
    }

    get unitIds(): readonly UnitId[] {
        return [...this.#state.units.keys()];
    }

    get blockingRelations(): readonly BlockingRelation[] {
        return this.#state.blockingRelations.map((relation) => ({ ...relation }));
    }

    get supportRelations(): readonly SupportRelation[] {
        return this.#state.supportRelations.map((relation) => ({ ...relation }));
    }

    occupancyAt(position: TilePosition, slot: OccupancySlot): readonly UnitId[] {
        const key = battlefieldOccupancyKey(this.map, position, slot);

        return key === undefined ? [] : [...(this.#state.spatial.occupancyBySlot.get(key) ?? [])];
    }

    supportOf(unitId: UnitId): UnitId | undefined {
        return this.#state.supportRelations.find((relation) => relation.supportedUnitId === unitId)
            ?.supportUnitId;
    }

    supportedBy(unitId: UnitId): readonly UnitId[] {
        return this.#state.supportRelations
            .filter((relation) => relation.supportUnitId === unitId)
            .map((relation) => relation.supportedUnitId);
    }

    blockerOf(unitId: UnitId): UnitId | undefined {
        return this.#state.blockingRelations.find((relation) => relation.blockedUnitId === unitId)
            ?.blockerUnitId;
    }

    blockedBy(unitId: UnitId): readonly UnitId[] {
        return this.#state.blockingRelations
            .filter((relation) => relation.blockerUnitId === unitId)
            .map((relation) => relation.blockedUnitId);
    }

    blockingUsedCapacity(unitId: UnitId): number {
        return blockingUsedCapacity(this.#state.units, this.#state.blockingRelations, unitId);
    }

    get mechanismIds(): readonly MechanismId[] {
        return [...this.#state.mechanisms.keys()];
    }

    get effectIds(): readonly SpatialEffectId[] {
        return [...this.#state.effects.keys()];
    }

    getUnit(id: UnitId): U | undefined {
        const unit = this.#state.units.get(id);

        return unit === undefined ? undefined : this.#resources.copyUnit(unit);
    }

    getMechanism(id: MechanismId): MechanismRuntime | undefined {
        const mechanism = this.#state.mechanisms.get(id);

        return mechanism === undefined ? undefined : { ...mechanism };
    }

    getEffect(id: SpatialEffectId): NavigationSpatialEffect | undefined {
        const effect = this.#state.effects.get(id);

        return effect === undefined ? undefined : copyNavigationSpatialEffect(effect);
    }

    unitsAt(position: TilePosition): readonly U[] {
        return this.#unitsAt(position).map((unit) => this.#resources.copyUnit(unit));
    }

    #unitsAt(position: TilePosition): readonly U[] {
        const key = battlefieldTileKey(this.map, position);
        const ids = key === undefined ? undefined : this.#state.spatial.unitsByTile.get(key);

        return ids === undefined ? [] : [...ids].map((id) => this.#state.units.get(id)!);
    }

    effectsAt(position: TilePosition): readonly SpatialEffectId[] {
        const key = battlefieldTileKey(this.map, position);

        return key === undefined ? [] : [...(this.#state.spatial.effectsByTile.get(key) ?? [])];
    }

    effectsFrom(source: SpatialEffectSource): readonly SpatialEffectId[] {
        return [...(this.#state.spatial.effectsBySource.get(spatialEffectSourceKey(source)) ?? [])];
    }

    effectsFollowing(unitId: UnitId): readonly SpatialEffectId[] {
        return [...(this.#state.spatial.effectsByAnchor.get(unitId) ?? [])];
    }

    transact<T>(operation: (battlefield: BattlefieldRuntime<U>) => T): T {
        if (this.#pendingInvalidations !== null) {
            throw new Error("battlefield transaction is already active");
        }

        const previous = this.#state;
        const invalidations = new Set<NavigationMaps[PathMotionMode]>();
        this.#pendingInvalidations = invalidations;

        try {
            const result = operation(this);

            for (const map of invalidations) {
                this.fieldCache.invalidate(map);
            }

            return result;
        } catch (error) {
            this.#state = previous;
            throw error;
        } finally {
            this.#pendingInvalidations = null;
        }
    }

    apply(changes: readonly BattlefieldChange<U>[]): BattlefieldChangeResult {
        const owned = changes.map((change): BattlefieldChange<U> => {
            switch (change.type) {
                case "REGISTER_UNIT":
                case "UPDATE_UNIT":
                    return { ...change, unit: this.#resources.copyUnit(change.unit) };

                case "SET_BLOCKING_RELATIONS":
                    return {
                        ...change,
                        relations: change.relations.map((relation) => ({ ...relation })),
                    };

                case "SET_SUPPORT_RELATIONS":
                    return {
                        ...change,
                        relations: change.relations.map((relation) => ({ ...relation })),
                    };

                case "REGISTER_MECHANISM":
                    return {
                        ...change,
                        mechanism: {
                            id: change.mechanism.id,
                            definition: change.mechanism.definition,
                            active: change.mechanism.active,
                        },
                    };

                case "ADD_EFFECT":
                    return { ...change, effect: createNavigationSpatialEffect(change.effect) };

                case "MOVE_UNIT":
                    return { ...change, position: createWorldPosition(...change.position) };

                case "SET_EFFECT_REGION":
                    return { ...change, region: createSpatialEffectRegion(change.region) };

                case "EXPIRE_EFFECTS":
                case "RELEASE_BLOCKING_RELATIONS":
                case "REMOVE_EFFECT":
                case "REMOVE_MECHANISM":
                case "REMOVE_UNIT":
                case "SET_EFFECT_ACTIVE":
                case "SET_MECHANISM_ACTIVE":
                default:
                    return change;
            }
        });

        const committed = this.commit(owned);

        return {
            ...committed,
            lostSupports: committed.lostSupports.map((relation) => ({ ...relation })),
        };
    }

    commit(changes: readonly BattlefieldChange<U>[]): BattlefieldChangeResult {
        const units = new Map(this.#state.units);
        let blockingRelations = this.#state.blockingRelations;
        let supportRelations = this.#state.supportRelations;
        const mechanisms = new Map(this.#state.mechanisms);
        const effects = new Map(this.#state.effects);
        const removedUnits: { unitId: UnitId; reason: BattlefieldRemovalReason }[] = [];
        const removedMechanisms: { mechanismId: MechanismId; reason: BattlefieldRemovalReason }[] =
            [];
        const removedEffects = new Set<SpatialEffectId>();

        const removeEffect = (id: SpatialEffectId): void => {
            effects.delete(id);
            removedEffects.add(id);
        };

        for (const change of changes) {
            switch (change.type) {
                case "REGISTER_UNIT":
                    if (!Number.isSafeInteger(change.unit.id) || change.unit.id < 0) {
                        throw new RangeError("invalid unit id");
                    }

                    register(units, change.unit.id, change.unit, "unit");
                    break;

                case "UPDATE_UNIT": {
                    const previous = requireEntry(units, change.unit.id, "unit");

                    if (previous.definition !== change.unit.definition) {
                        throw new RangeError("unit definition cannot change during update");
                    }

                    units.set(change.unit.id, change.unit);
                    break;
                }

                case "SET_BLOCKING_RELATIONS":
                    blockingRelations = change.relations;
                    break;

                case "SET_SUPPORT_RELATIONS":
                    validateSupportRelations(units, change.relations);
                    supportRelations = change.relations;
                    break;

                case "RELEASE_BLOCKING_RELATIONS":
                    blockingRelations = releaseBlockingRelations(blockingRelations, change.unitId);
                    break;

                case "MOVE_UNIT": {
                    const unit = requireEntry(units, change.unitId, "unit");
                    units.set(change.unitId, { ...unit, position: change.position });
                    blockingRelations = releaseBlockingRelations(blockingRelations, change.unitId);
                    break;
                }

                case "REMOVE_UNIT":
                    requireEntry(units, change.unitId, "unit");
                    units.delete(change.unitId);
                    removedUnits.push({ unitId: change.unitId, reason: change.reason });

                    for (const effect of effects.values()) {
                        const ownedOrAnchoredByUnit =
                            (effect.source.type === "UNIT" &&
                                effect.source.unitId === change.unitId) ||
                            (effect.region.type === "FOLLOW_UNIT" &&
                                effect.region.unitId === change.unitId);

                        if (ownedOrAnchoredByUnit) {
                            removeEffect(effect.id);
                        }
                    }

                    break;

                case "REGISTER_MECHANISM":
                    register(mechanisms, change.mechanism.id, change.mechanism, "mechanism");
                    break;

                case "SET_MECHANISM_ACTIVE":
                    mechanisms.set(change.mechanismId, {
                        ...requireEntry(mechanisms, change.mechanismId, "mechanism"),
                        active: change.active,
                    });
                    break;

                case "REMOVE_MECHANISM":
                    requireEntry(mechanisms, change.mechanismId, "mechanism");
                    mechanisms.delete(change.mechanismId);
                    removedMechanisms.push({
                        mechanismId: change.mechanismId,
                        reason: change.reason,
                    });

                    for (const effect of effects.values()) {
                        if (
                            effect.source.type === "MECHANISM" &&
                            effect.source.mechanismId === change.mechanismId
                        ) {
                            removeEffect(effect.id);
                        }
                    }

                    break;

                case "ADD_EFFECT":
                    register(effects, change.effect.id, change.effect, "effect");
                    break;

                case "SET_EFFECT_ACTIVE":
                    effects.set(change.effectId, {
                        ...requireEntry(effects, change.effectId, "effect"),
                        active: change.active,
                    });
                    break;

                case "SET_EFFECT_REGION":
                    effects.set(change.effectId, {
                        ...requireEntry(effects, change.effectId, "effect"),
                        region: change.region,
                    });
                    break;

                case "REMOVE_EFFECT":
                    requireEntry(effects, change.effectId, "effect");
                    removeEffect(change.effectId);
                    break;

                case "EXPIRE_EFFECTS":
                    if (!Number.isSafeInteger(change.tick) || change.tick < 0) {
                        throw new RangeError(
                            "effect expiry tick must be a nonnegative safe integer",
                        );
                    }

                    for (const effect of effects.values()) {
                        if (effect.expiresAtTick !== null && effect.expiresAtTick <= change.tick) {
                            removeEffect(effect.id);
                        }
                    }

                    break;
            }
        }

        supportRelations = reconcileSupportRelations(units, supportRelations);

        const lostSupports = getLostSupports(this.#state.supportRelations, supportRelations, units);
        const spatial = projectBattlefieldSpatial(this.map, units, mechanisms, effects);
        const projection = projectNavigationMaps(
            this.#resources.baseline,
            spatial.navigationEffects,
            this.#state.navigationMaps,
        );

        for (const [id, unit] of units) {
            units.set(id, reconcileUnitNavigation(unit, projection.maps));
        }

        const previousMaps = this.#state.navigationMaps;
        this.#state = {
            units,
            mechanisms,
            effects,
            spatial,
            navigationMaps: projection.maps,
            supportRelations,
            blockingRelations: reconcileBlockingRelations(
                units,
                blockingRelations,
                supportRelations,
            ),
        };

        for (const mode of projection.changedModes) {
            if (this.#pendingInvalidations === null) {
                this.fieldCache.invalidate(previousMaps[mode]);
            } else {
                this.#pendingInvalidations.add(previousMaps[mode]);
            }
        }

        return {
            changedNavigationModes: projection.changedModes,
            removedUnits,
            removedMechanisms,
            removedEffects: [...removedEffects],
            lostSupports,
        };
    }
}

export function createBattlefieldRuntime(options: BattlefieldRuntimeOptions): Battlefield;
export function createBattlefieldRuntime<U extends Unit>(
    options: BattlefieldRuntimeOptions,
    copyUnit: (unit: Readonly<U>) => U,
): Battlefield<U>;
export function createBattlefieldRuntime<U extends Unit>(
    options: BattlefieldRuntimeOptions,
    copyUnit?: (unit: Readonly<U>) => U,
): Battlefield | Battlefield<U> {
    return copyUnit === undefined
        ? BattlefieldRuntime.create<Unit>(options, copyUnitSnapshot)
        : BattlefieldRuntime.create<U>(options, (unit) => {
              assertUnitCapabilityConsistency(unit);

              return copyUnit(unit);
          });
}
