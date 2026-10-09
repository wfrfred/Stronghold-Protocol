import type { TilePosition } from "../geometry/coordinate.js";
import { createNavigationFieldCache, type NavigationFieldCache } from "./navigation/cache.js";
import type { NavigationMaps } from "./navigation/map.js";
import type { OccupancySlot } from "../unit/capability/occupancy.js";
import { copyUnitSnapshot } from "../unit/snapshot.js";
import type { StableUnit, Unit, UnitId } from "../unit/unit.js";
import { blockingUsedCapacity, type BlockingRelation } from "./blocking/relations.js";
import { applyBattlefieldChanges } from "./storage/changes.js";
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
    copyNavigationModifier,
    type NavigationModifier,
    type NavigationModifierId,
    type NavigationModifierSource,
} from "./navigation/modifier.js";
import { projectStaticNavigationMap } from "./navigation/projection.js";
import {
    battlefieldTileKey,
    battlefieldOccupancyKey,
    navigationModifierSourceKey,
} from "./storage/indexes.js";
import {
    createBattlefieldState,
    settleBattlefieldState,
    type BattlefieldState,
} from "./storage/state.js";
import type { ProjectileId, ProjectileInstance } from "./projectile/state.js";
import type { SupportRelation } from "./support/relations.js";

interface BattlefieldResources<U extends Unit> {
    readonly map: BattlefieldMap;
    readonly baseline: NavigationMaps;
    readonly fieldCache: NavigationFieldCache;
    readonly copyUnit: (unit: Readonly<StableUnit<U>>) => StableUnit<U>;
}

export class BattlefieldRuntime<U extends Unit = Unit> {
    readonly #resources: BattlefieldResources<U>;
    readonly #view: BattlefieldView<StableUnit<U>>;
    #state: BattlefieldState<StableUnit<U>>;
    #transactionActive = false;

    private constructor(
        resources: BattlefieldResources<U>,
        state: BattlefieldState<StableUnit<U>>,
    ) {
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
            get projectileIds() {
                return runtime.projectileIds;
            },
            getProjectile: (id) => runtime.#state.projectiles.get(id),
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
        copyUnit: (unit: Readonly<StableUnit<U>>) => StableUnit<U>,
    ): BattlefieldRuntime<U> {
        const baseline = Object.freeze({
            WALK: projectStaticNavigationMap(options.map, "WALK", 0),
            FLY: projectStaticNavigationMap(options.map, "FLY", 0),
        });

        return new BattlefieldRuntime<U>(
            { map: options.map, baseline, copyUnit, fieldCache: createNavigationFieldCache() },
            createBattlefieldState<StableUnit<U>>(options.map, baseline),
        );
    }

    fork(): BattlefieldRuntime<U> {
        return new BattlefieldRuntime(this.#resources, this.#state);
    }

    get map(): BattlefieldMap {
        return this.#resources.map;
    }

    get view(): BattlefieldView<StableUnit<U>> {
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

    get projectileIds(): readonly ProjectileId[] {
        return [...this.#state.projectiles.keys()];
    }

    getProjectile(id: ProjectileId): ProjectileInstance | undefined {
        return this.#state.projectiles.get(id);
    }

    get mechanismIds(): readonly MechanismId[] {
        return [...this.#state.mechanisms.keys()];
    }

    get navigationModifierIds(): readonly NavigationModifierId[] {
        return [...this.#state.navigationModifiers.keys()];
    }

    getUnit(id: UnitId): StableUnit<U> | undefined {
        const unit = this.#state.units.get(id);

        return unit === undefined ? undefined : this.#resources.copyUnit(unit);
    }

    getMechanism(id: MechanismId): MechanismRuntime | undefined {
        const mechanism = this.#state.mechanisms.get(id);

        return mechanism === undefined ? undefined : { ...mechanism };
    }

    getNavigationModifier(id: NavigationModifierId): NavigationModifier | undefined {
        const navigationModifier = this.#state.navigationModifiers.get(id);

        return navigationModifier === undefined
            ? undefined
            : copyNavigationModifier(navigationModifier);
    }

    unitsAt(position: TilePosition): readonly StableUnit<U>[] {
        return this.#unitsAt(position).map((unit) => this.#resources.copyUnit(unit));
    }

    #unitsAt(position: TilePosition): readonly StableUnit<U>[] {
        const key = battlefieldTileKey(this.map, position);
        const ids = key === undefined ? undefined : this.#state.spatial.unitsByTile.get(key);

        return ids === undefined ? [] : [...ids].map((id) => this.#state.units.get(id)!);
    }

    navigationModifiersAt(position: TilePosition): readonly NavigationModifierId[] {
        const key = battlefieldTileKey(this.map, position);

        return key === undefined
            ? []
            : [...(this.#state.spatial.navigationModifiersByTile.get(key) ?? [])];
    }

    navigationModifiersFrom(source: NavigationModifierSource): readonly NavigationModifierId[] {
        return [
            ...(this.#state.spatial.navigationModifiersBySource.get(
                navigationModifierSourceKey(source),
            ) ?? []),
        ];
    }

    navigationModifiersFollowing(unitId: UnitId): readonly NavigationModifierId[] {
        return [...(this.#state.spatial.navigationModifiersByAnchor.get(unitId) ?? [])];
    }

    transact(operation: (battlefield: BattlefieldRuntime<U>) => undefined): undefined;
    transact<T>(operation: (battlefield: BattlefieldRuntime<U>) => SynchronousResult<T>): T;
    transact<T>(operation: (battlefield: BattlefieldRuntime<U>) => SynchronousResult<T>): T {
        if (this.#transactionActive) {
            throw new Error("battlefield transaction is already active");
        }

        const previous = this.#state;
        this.#transactionActive = true;

        try {
            return operation(this);
        } catch (error) {
            this.#state = previous;
            throw error;
        } finally {
            this.#transactionActive = false;
        }
    }

    apply(
        changes: readonly BattlefieldChange<StableUnit<U>>[],
    ): BattlefieldChangeResult<StableUnit<U>> {
        const applied = applyBattlefieldChanges<U>(this.#state, changes);
        const settled = settleBattlefieldState<U>(
            this.map,
            this.#resources.baseline,
            this.#state,
            applied.content,
            applied.dependencies,
        );

        const result = { ...applied.facts, ...settled.facts };
        this.#state = settled.state;

        return result;
    }
}

export function createBattlefieldRuntime(options: BattlefieldRuntimeOptions): Battlefield;
export function createBattlefieldRuntime<U extends Unit>(
    options: BattlefieldRuntimeOptions,
    copyUnit: (unit: Readonly<StableUnit<U>>) => StableUnit<U>,
): Battlefield<StableUnit<U>>;
export function createBattlefieldRuntime<U extends Unit>(
    options: BattlefieldRuntimeOptions,
    copyUnit?: (unit: Readonly<StableUnit<U>>) => StableUnit<U>,
): Battlefield | Battlefield<StableUnit<U>> {
    return copyUnit === undefined
        ? BattlefieldRuntime.create<Unit>(options, copyUnitSnapshot)
        : BattlefieldRuntime.create<U>(options, copyUnit);
}
