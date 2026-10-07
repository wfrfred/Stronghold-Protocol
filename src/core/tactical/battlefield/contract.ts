import type { TilePosition, WorldPosition } from "../geometry/coordinate.js";
import type { NavigationFieldCache, NavigationFieldProvider } from "./navigation/cache.js";
import type { NavigationMaps, PathMotionMode } from "./navigation/map.js";
import type { Unit, UnitId } from "../unit/unit.js";
import type { OccupancySlot } from "../unit/capability/occupancy.js";
import type { BattlefieldMap } from "./map/map.js";
import type { MechanismId, MechanismRuntime, MechanismView } from "./mechanism.js";
import type {
    NavigationSpatialEffect,
    SpatialEffectId,
    SpatialEffectRegion,
    SpatialEffectSource,
} from "./navigation/effect.js";
import type { BlockingRelation } from "./blocking/relations.js";
import type { SupportRelation } from "./support/relations.js";

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
    | {
          readonly type: "SET_POSITION_AND_RELEASE_BLOCKING";
          readonly unitId: UnitId;
          readonly position: WorldPosition;
      }
    | {
          readonly type: "REMOVE_UNIT";
          readonly unitId: UnitId;
          readonly reason: BattlefieldRemovalReason;
      }
    | { readonly type: "REGISTER_MECHANISM"; readonly mechanism: MechanismRuntime }
    | { readonly type: "UPDATE_MECHANISM"; readonly mechanism: MechanismRuntime }
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

export interface BattlefieldChangeResult<U extends Unit = Unit> {
    readonly changedNavigationModes: readonly PathMotionMode[];
    readonly registeredUnitIds: readonly UnitId[];
    readonly removedUnits: readonly {
        readonly unitId: UnitId;
        readonly reason: BattlefieldRemovalReason;
        readonly unit: U;
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

export interface BattlefieldView<U extends Unit = Unit> extends MechanismView {
    readonly map: BattlefieldMap;
    readonly navigationMaps: NavigationMaps;
    readonly fieldCache: NavigationFieldProvider;
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
    readonly fieldCache: NavigationFieldCache;
    readonly mechanismIds: readonly MechanismId[];
    readonly effectIds: readonly SpatialEffectId[];
    getMechanism(id: MechanismId): MechanismRuntime | undefined;
    getEffect(id: SpatialEffectId): NavigationSpatialEffect | undefined;
    effectsAt(position: TilePosition): readonly SpatialEffectId[];
    effectsFrom(source: SpatialEffectSource): readonly SpatialEffectId[];
    effectsFollowing(unitId: UnitId): readonly SpatialEffectId[];
    fork(): Battlefield<U>;
    transact<T>(operation: (battlefield: Battlefield<U>) => T): T;
    apply(changes: readonly BattlefieldChange<U>[]): BattlefieldChangeResult<U>;
}
