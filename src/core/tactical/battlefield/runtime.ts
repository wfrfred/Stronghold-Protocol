import type { TilePosition } from "../geometry/coordinate.js";
import { createNavigationFieldCache, type NavigationFieldCache } from "./navigation/cache.js";
import type { NavigationMaps } from "./navigation/map.js";
import type { StableUnit, Unit } from "../unit/unit.js";
import { blockingUsedCapacity } from "./blocking/relations.js";
import { applyBattlefieldChanges } from "./storage/changes.js";
import type {
    Battlefield,
    BattlefieldChange,
    BattlefieldChangeResult,
    BattlefieldRuntimeOptions,
    BattlefieldView,
} from "./contract.js";
import type { BattlefieldMap } from "./map/map.js";
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

interface BattlefieldResources {
    readonly map: BattlefieldMap;
    readonly baseline: NavigationMaps;
    readonly fieldCache: NavigationFieldCache;
}

export class BattlefieldRuntime<U extends Unit = Unit> {
    readonly #resources: BattlefieldResources;
    readonly #views = new WeakMap<
        BattlefieldState<StableUnit<U>>,
        BattlefieldView<StableUnit<U>>
    >();

    #state: BattlefieldState<StableUnit<U>>;
    #draft: BattlefieldState<StableUnit<U>>;

    private constructor(resources: BattlefieldResources, state: BattlefieldState<StableUnit<U>>) {
        this.#resources = resources;
        this.#state = state;
        this.#draft = state;
    }

    #createView(state: BattlefieldState<StableUnit<U>>): BattlefieldView<StableUnit<U>> {
        const runtime = this;
        const map = this.#resources.map;

        return {
            map,
            navigationMaps: state.navigationMaps,
            fieldCache: this.#resources.fieldCache,
            effectLifetimes: state.effectLifetimes,
            blockingRelations: state.blockingRelations,
            supportRelations: state.supportRelations,
            get unitIds() {
                return [...state.units.keys()];
            },
            get projectileIds() {
                return [...state.projectiles.keys()];
            },
            getProjectile: (id) => state.projectiles.get(id),
            get mechanismIds() {
                return [...state.mechanisms.keys()];
            },
            getMechanism: (id) => state.mechanisms.get(id),
            get navigationModifierIds() {
                return [...state.navigationModifiers.keys()];
            },
            getNavigationModifier: (id) => state.navigationModifiers.get(id),
            getUnit: (id) => state.units.get(id),
            unitsAt: (position) => runtime.#unitsAt(position, state),
            blockerOf: (id) =>
                state.blockingRelations.find((relation) => relation.blockedUnitId === id)
                    ?.blockerUnitId,
            blockedBy: (id) =>
                state.blockingRelations
                    .filter((relation) => relation.blockerUnitId === id)
                    .map((relation) => relation.blockedUnitId),
            blockingUsedCapacity: (id) => {
                return blockingUsedCapacity(state.units, state.blockingRelations, id);
            },
            occupancyAt: (position, slot) => {
                const key = battlefieldOccupancyKey(map, position, slot);

                return key === undefined ? [] : [...(state.spatial.occupancyBySlot.get(key) ?? [])];
            },
            supportOf: (id) =>
                state.supportRelations.find((relation) => relation.supportedUnitId === id)
                    ?.supportUnitId,
            supportedBy: (id) =>
                state.supportRelations
                    .filter((relation) => relation.supportUnitId === id)
                    .map((relation) => relation.supportedUnitId),
            navigationModifiersAt: (position) => {
                const key = battlefieldTileKey(map, position);

                return key === undefined
                    ? []
                    : [...(state.spatial.navigationModifiersByTile.get(key) ?? [])];
            },
            navigationModifiersFrom: (source) => [
                ...(state.spatial.navigationModifiersBySource.get(
                    navigationModifierSourceKey(source),
                ) ?? []),
            ],
            navigationModifiersFollowing: (unitId) => [
                ...(state.spatial.navigationModifiersByAnchor.get(unitId) ?? []),
            ],
        };
    }

    static create<U extends Unit>(options: BattlefieldRuntimeOptions): BattlefieldRuntime<U> {
        const baseline = Object.freeze({
            WALK: projectStaticNavigationMap(options.map, "WALK", 0),
            FLY: projectStaticNavigationMap(options.map, "FLY", 0),
        });

        return new BattlefieldRuntime<U>(
            { map: options.map, baseline, fieldCache: createNavigationFieldCache() },
            createBattlefieldState<StableUnit<U>>(options.map, baseline),
        );
    }

    snapshot(version: "state" | "draft"): BattlefieldView<StableUnit<U>> {
        const state = version === "state" ? this.#state : this.#draft;
        let view = this.#views.get(state);

        if (view === undefined) {
            view = this.#createView(state);
            this.#views.set(state, view);
        }

        return view;
    }

    #unitsAt(
        position: TilePosition,
        state: BattlefieldState<StableUnit<U>>,
    ): readonly StableUnit<U>[] {
        const key = battlefieldTileKey(this.#resources.map, position);
        const ids = key === undefined ? undefined : state.spatial.unitsByTile.get(key);

        return ids === undefined ? [] : [...ids].map((id) => state.units.get(id)!);
    }

    advance(
        changes: readonly BattlefieldChange<StableUnit<U>>[],
    ): BattlefieldChangeResult<StableUnit<U>> {
        const applied = applyBattlefieldChanges<U>(this.#draft, changes);
        const settled = settleBattlefieldState<U>(
            this.#resources.map,
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

export function createBattlefieldRuntime<U extends Unit = Unit>(
    options: BattlefieldRuntimeOptions,
): Battlefield<StableUnit<U>> {
    return BattlefieldRuntime.create<U>(options);
}
