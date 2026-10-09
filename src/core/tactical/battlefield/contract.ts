import type { TilePosition, WorldPosition } from "../geometry/coordinate.js";
import type { NavigationFieldCache, NavigationFieldProvider } from "./navigation/cache.js";
import type { NavigationMaps, PathMotionMode } from "./navigation/map.js";
import type { Unit, UnitId } from "../unit/unit.js";
import type { OccupancySlot } from "../unit/capability/occupancy.js";
import type { BattlefieldMap } from "./map/map.js";
import type { MechanismId, MechanismRuntime, MechanismView } from "./mechanism.js";
import type {
    NavigationModifier,
    NavigationModifierId,
    NavigationModifierRegion,
    NavigationModifierSource,
} from "./navigation/modifier.js";
import type { BlockingRelation } from "./blocking/relations.js";
import type { SupportRelation } from "./support/relations.js";
import type { ProjectileId, ProjectileInstance, ProjectileView } from "./projectile/state.js";
import type { SynchronousResult } from "../../common/synchronous.js";

export type { SynchronousResult } from "../../common/synchronous.js";

export type BattlefieldRemovalReason = "DEATH" | "RETREAT" | "EXPIRED" | "SCRIPT";

export type BattlefieldChange<U extends Unit = Unit> =
    | { readonly type: "REGISTER_PROJECTILE"; readonly projectile: ProjectileInstance }
    | { readonly type: "UPDATE_PROJECTILE"; readonly projectile: ProjectileInstance }
    | { readonly type: "REMOVE_PROJECTILE"; readonly projectileId: ProjectileId }
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
    | { readonly type: "ADD_NAVIGATION_MODIFIER"; readonly navigationModifier: NavigationModifier }
    | {
          readonly type: "SET_NAVIGATION_MODIFIER_ACTIVE";
          readonly navigationModifierId: NavigationModifierId;
          readonly active: boolean;
      }
    | {
          readonly type: "SET_NAVIGATION_MODIFIER_REGION";
          readonly navigationModifierId: NavigationModifierId;
          readonly region: NavigationModifierRegion;
      }
    | {
          readonly type: "REMOVE_NAVIGATION_MODIFIER";
          readonly navigationModifierId: NavigationModifierId;
      }
    | { readonly type: "EXPIRE_NAVIGATION_MODIFIERS"; readonly tick: number };

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
    readonly removedNavigationModifiers: readonly NavigationModifierId[];
    readonly lostSupports: readonly SupportRelation[];
}

export interface BattlefieldRuntimeOptions {
    readonly map: BattlefieldMap;
}

export interface BattlefieldView<U extends Unit = Unit> extends MechanismView, ProjectileView {
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
    readonly navigationModifierIds: readonly NavigationModifierId[];
    getMechanism(id: MechanismId): MechanismRuntime | undefined;
    getNavigationModifier(id: NavigationModifierId): NavigationModifier | undefined;
    navigationModifiersAt(position: TilePosition): readonly NavigationModifierId[];
    navigationModifiersFrom(source: NavigationModifierSource): readonly NavigationModifierId[];
    navigationModifiersFollowing(unitId: UnitId): readonly NavigationModifierId[];
    fork(): Battlefield<U>;
    transact(operation: (battlefield: Battlefield<U>) => undefined): undefined;
    transact<T>(operation: (battlefield: Battlefield<U>) => SynchronousResult<T>): T;
    /** Applies values directly; callers must not mutate submitted state or returned facts. */
    apply(changes: readonly BattlefieldChange<U>[]): BattlefieldChangeResult<U>;
}
