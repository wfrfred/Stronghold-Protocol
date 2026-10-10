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
import type { EffectLifetimeProjection } from "../unit/capability/effects/lifetime-index.js";

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
    #draft: BattlefieldState<StableUnit<U>>;
    #transactionActive = false;

    private constructor(
        resources: BattlefieldResources<U>,
        state: BattlefieldState<StableUnit<U>>,
    ) {
        this.#resources = resources;
        this.#state = state;
        this.#draft = state;
        this.#view = this.#createView(() => this.#draft);
    }

    #createView(readState: () => BattlefieldState<StableUnit<U>>): BattlefieldView<StableUnit<U>> {
        const runtime = this;

        return {
            get map() {
                return runtime.map;
            },
            get navigationMaps() {
                return readState().navigationMaps;
            },
            get fieldCache() {
                return runtime.fieldCache;
            },
            get unitIds() {
                return [...readState().units.keys()];
            },
            get effectLifetimes() {
                return readState().effectLifetimes;
            },
            get projectileIds() {
                return [...readState().projectiles.keys()];
            },
            getProjectile: (id) => readState().projectiles.get(id),
            get mechanismIds() {
                return [...readState().mechanisms.keys()];
            },
            getMechanism: (id) => readState().mechanisms.get(id),
            get blockingRelations() {
                return readState().blockingRelations;
            },
            get supportRelations() {
                return readState().supportRelations;
            },
            getUnit: (id) => readState().units.get(id),
            unitsAt: (position) => runtime.#unitsAt(position, readState()),
            blockerOf: (id) =>
                readState().blockingRelations.find((relation) => relation.blockedUnitId === id)
                    ?.blockerUnitId,
            blockedBy: (id) =>
                readState()
                    .blockingRelations.filter((relation) => relation.blockerUnitId === id)
                    .map((relation) => relation.blockedUnitId),
            blockingUsedCapacity: (id) => {
                const state = readState();

                return blockingUsedCapacity(state.units, state.blockingRelations, id);
            },
            occupancyAt: (position, slot) => {
                const key = battlefieldOccupancyKey(runtime.map, position, slot);

                return key === undefined
                    ? []
                    : [...(readState().spatial.occupancyBySlot.get(key) ?? [])];
            },
            supportOf: (id) =>
                readState().supportRelations.find((relation) => relation.supportedUnitId === id)
                    ?.supportUnitId,
            supportedBy: (id) =>
                readState()
                    .supportRelations.filter((relation) => relation.supportUnitId === id)
                    .map((relation) => relation.supportedUnitId),
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
        return new BattlefieldRuntime(this.#resources, this.#draft);
    }

    snapshot(version: "state" | "draft" = "state"): BattlefieldView<StableUnit<U>> {
        const state = version === "state" ? this.#state : this.#draft;

        return this.#createView(() => state);
    }

    get map(): BattlefieldMap {
        return this.#resources.map;
    }

    get view(): BattlefieldView<StableUnit<U>> {
        return this.#view;
    }

    get navigationMaps(): NavigationMaps {
        return this.#draft.navigationMaps;
    }

    get effectLifetimes(): EffectLifetimeProjection {
        return this.#draft.effectLifetimes;
    }

    get fieldCache(): NavigationFieldCache {
        return this.#resources.fieldCache;
    }

    get unitIds(): readonly UnitId[] {
        return [...this.#draft.units.keys()];
    }

    get blockingRelations(): readonly BlockingRelation[] {
        return this.#draft.blockingRelations.map((relation) => ({ ...relation }));
    }

    get supportRelations(): readonly SupportRelation[] {
        return this.#draft.supportRelations.map((relation) => ({ ...relation }));
    }

    occupancyAt(position: TilePosition, slot: OccupancySlot): readonly UnitId[] {
        const key = battlefieldOccupancyKey(this.map, position, slot);

        return key === undefined ? [] : [...(this.#draft.spatial.occupancyBySlot.get(key) ?? [])];
    }

    supportOf(unitId: UnitId): UnitId | undefined {
        return this.#draft.supportRelations.find((relation) => relation.supportedUnitId === unitId)
            ?.supportUnitId;
    }

    supportedBy(unitId: UnitId): readonly UnitId[] {
        return this.#draft.supportRelations
            .filter((relation) => relation.supportUnitId === unitId)
            .map((relation) => relation.supportedUnitId);
    }

    blockerOf(unitId: UnitId): UnitId | undefined {
        return this.#draft.blockingRelations.find((relation) => relation.blockedUnitId === unitId)
            ?.blockerUnitId;
    }

    blockedBy(unitId: UnitId): readonly UnitId[] {
        return this.#draft.blockingRelations
            .filter((relation) => relation.blockerUnitId === unitId)
            .map((relation) => relation.blockedUnitId);
    }

    blockingUsedCapacity(unitId: UnitId): number {
        return blockingUsedCapacity(this.#draft.units, this.#draft.blockingRelations, unitId);
    }

    get projectileIds(): readonly ProjectileId[] {
        return [...this.#draft.projectiles.keys()];
    }

    getProjectile(id: ProjectileId): ProjectileInstance | undefined {
        return this.#draft.projectiles.get(id);
    }

    get mechanismIds(): readonly MechanismId[] {
        return [...this.#draft.mechanisms.keys()];
    }

    get navigationModifierIds(): readonly NavigationModifierId[] {
        return [...this.#draft.navigationModifiers.keys()];
    }

    getUnit(id: UnitId): StableUnit<U> | undefined {
        const unit = this.#draft.units.get(id);

        return unit === undefined ? undefined : this.#resources.copyUnit(unit);
    }

    getMechanism(id: MechanismId): MechanismRuntime | undefined {
        const mechanism = this.#draft.mechanisms.get(id);

        return mechanism === undefined ? undefined : { ...mechanism };
    }

    getNavigationModifier(id: NavigationModifierId): NavigationModifier | undefined {
        const navigationModifier = this.#draft.navigationModifiers.get(id);

        return navigationModifier === undefined
            ? undefined
            : copyNavigationModifier(navigationModifier);
    }

    unitsAt(position: TilePosition): readonly StableUnit<U>[] {
        return this.#unitsAt(position).map((unit) => this.#resources.copyUnit(unit));
    }

    #unitsAt(position: TilePosition, state = this.#draft): readonly StableUnit<U>[] {
        const key = battlefieldTileKey(this.map, position);
        const ids = key === undefined ? undefined : state.spatial.unitsByTile.get(key);

        return ids === undefined ? [] : [...ids].map((id) => state.units.get(id)!);
    }

    navigationModifiersAt(position: TilePosition): readonly NavigationModifierId[] {
        const key = battlefieldTileKey(this.map, position);

        return key === undefined
            ? []
            : [...(this.#draft.spatial.navigationModifiersByTile.get(key) ?? [])];
    }

    navigationModifiersFrom(source: NavigationModifierSource): readonly NavigationModifierId[] {
        return [
            ...(this.#draft.spatial.navigationModifiersBySource.get(
                navigationModifierSourceKey(source),
            ) ?? []),
        ];
    }

    navigationModifiersFollowing(unitId: UnitId): readonly NavigationModifierId[] {
        return [...(this.#draft.spatial.navigationModifiersByAnchor.get(unitId) ?? [])];
    }

    transact(operation: (battlefield: BattlefieldRuntime<U>) => undefined): undefined;
    transact<T>(operation: (battlefield: BattlefieldRuntime<U>) => SynchronousResult<T>): T;
    transact<T>(operation: (battlefield: BattlefieldRuntime<U>) => SynchronousResult<T>): T {
        if (this.#transactionActive) {
            throw new Error("battlefield transaction is already active");
        }

        const previousState = this.#state;
        const previousDraft = this.#draft;
        this.#transactionActive = true;

        try {
            return operation(this);
        } catch (error) {
            this.#state = previousState;
            this.#draft = previousDraft;
            throw error;
        } finally {
            this.#transactionActive = false;
        }
    }

    advance(
        changes: readonly BattlefieldChange<StableUnit<U>>[],
    ): BattlefieldChangeResult<StableUnit<U>> {
        const applied = applyBattlefieldChanges<U>(this.#draft, changes);
        const settled = settleBattlefieldState<U>(
            this.map,
            this.#resources.baseline,
            this.#draft,
            applied.content,
            applied.dependencies,
        );

        const result = { ...applied.facts, ...settled.facts };
        this.#draft = settled.state;

        return result;
    }

    apply(): void {
        this.#state = this.#draft;
    }

    drop(): void {
        this.#draft = this.#state;
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
