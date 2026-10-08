import type { TilePosition } from "../geometry/coordinate.js";
import { assertSynchronousResult } from "../../common/synchronous.js";
import { createNavigationFieldCache, type NavigationFieldCache } from "./navigation/cache.js";
import type { NavigationMaps } from "./navigation/map.js";
import { assertUnitCapabilityConsistency } from "../unit/capability/catalog.js";
import type { OccupancySlot } from "../unit/capability/occupancy.js";
import { copyUnitSnapshot } from "../unit/snapshot.js";
import type { Unit, UnitId } from "../unit/unit.js";
import { blockingUsedCapacity, type BlockingRelation } from "./blocking/relations.js";
import { applyBattlefieldChanges, ownBattlefieldChanges } from "./storage/changes.js";
import type {
    Battlefield,
    BattlefieldChange,
    BattlefieldChangeResult,
    BattlefieldRuntimeOptions,
    BattlefieldView,
    SynchronousResult,
} from "./contract.js";
import type { BattlefieldMap } from "./map/map.js";
import type { MechanismId, MechanismRuntime } from "./mechanism.js";
import {
    copyNavigationSpatialEffect,
    type NavigationSpatialEffect,
    type SpatialEffectId,
    type SpatialEffectSource,
} from "./navigation/effect.js";
import { projectStaticNavigationMap } from "./navigation/projection.js";
import {
    battlefieldTileKey,
    battlefieldOccupancyKey,
    spatialEffectSourceKey,
} from "./storage/indexes.js";
import {
    createBattlefieldState,
    settleBattlefieldState,
    type BattlefieldState,
} from "./storage/state.js";
import type { SupportRelation } from "./support/relations.js";

interface BattlefieldResources<U extends Unit> {
    readonly map: BattlefieldMap;
    readonly baseline: NavigationMaps;
    readonly fieldCache: NavigationFieldCache;
    readonly copyUnit: (unit: Readonly<U>) => U;
}

export class BattlefieldRuntime<U extends Unit = Unit> {
    readonly #resources: BattlefieldResources<U>;
    readonly #view: BattlefieldView<U>;
    #state: BattlefieldState<U>;
    #transactionActive = false;

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
            get mechanismIds() {
                return runtime.mechanismIds;
            },
            getMechanism: (id) => runtime.#state.mechanisms.get(id),
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

        return new BattlefieldRuntime(
            { map: options.map, baseline, copyUnit, fieldCache: createNavigationFieldCache() },
            createBattlefieldState<U>(options.map, baseline),
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

    transact<T>(operation: (battlefield: BattlefieldRuntime<U>) => SynchronousResult<T>): T {
        if (this.#transactionActive) {
            throw new Error("battlefield transaction is already active");
        }

        const previous = this.#state;
        this.#transactionActive = true;

        try {
            const result = operation(this);

            assertSynchronousResult(result, "battlefield transactions");

            return result;
        } catch (error) {
            this.#state = previous;
            throw error;
        } finally {
            this.#transactionActive = false;
        }
    }

    apply(changes: readonly BattlefieldChange<U>[]): BattlefieldChangeResult<U> {
        const owned = ownBattlefieldChanges(changes, this.#resources.copyUnit);
        const prepared = this.#prepare(owned);
        const result: BattlefieldChangeResult<U> = {
            ...prepared.facts,
            removedUnits: prepared.facts.removedUnits.map((removed) => ({
                ...removed,
                unit: this.#resources.copyUnit(removed.unit),
            })),
            lostSupports: prepared.facts.lostSupports.map((relation) => ({ ...relation })),
        };

        this.#state = prepared.state;

        return result;
    }

    commit(changes: readonly BattlefieldChange<U>[]): BattlefieldChangeResult<U> {
        const prepared = this.#prepare(changes);
        this.#state = prepared.state;

        return prepared.facts;
    }

    #prepare(changes: readonly BattlefieldChange<U>[]) {
        const applied = applyBattlefieldChanges(this.#state, changes);
        const settled = settleBattlefieldState(
            this.map,
            this.#resources.baseline,
            this.#state,
            applied.content,
            applied.dependencies,
        );

        return { state: settled.state, facts: { ...applied.facts, ...settled.facts } };
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
