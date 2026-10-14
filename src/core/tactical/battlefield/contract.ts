import type { TilePosition, WorldPosition } from "../geometry/coordinate.js";
import type { NavigationFieldProvider } from "./navigation/cache.js";
import type { NavigationMaps, PathMotionMode } from "./navigation/map.js";
import type { Unit, Id } from "../unit/unit.js";
import type { OccupancySlot } from "../unit/capability/occupancy/capability.js";
import type { BattlefieldMap } from "./map/map.js";
import type { MechanismId, Mechanism, MechanismView } from "./mechanism.js";
import type {
    NavigationModifier,
    NavigationModifierId,
    NavigationModifierRegion,
    NavigationModifierSource,
} from "./navigation/modifier.js";
import type { BlockingRelation } from "./blocking/relations.js";
import type { SupportRelation } from "./support/relations.js";
import type { ProjectileView } from "./projectile/projectile.js";
import type { Index } from "./storage/effect-lifetimes.js";

export type BattlefieldRemovalReason = "DEATH" | "RETREAT" | "EXPIRED" | "SCRIPT";

export type BattlefieldChange<U extends Unit = Unit> =
    | { readonly type: "REGISTER_UNIT"; readonly unit: U }
    | { readonly type: "UPDATE_UNIT"; readonly unit: U }
    | {
          readonly type: "SET_BLOCKING_RELATIONS";
          readonly relations: readonly BlockingRelation[];
      }
    | { readonly type: "SET_SUPPORT_RELATIONS"; readonly relations: readonly SupportRelation[] }
    | { readonly type: "RELEASE_BLOCKING_RELATIONS"; readonly unitId: Id }
    | {
          readonly type: "SET_POSITION_AND_RELEASE_BLOCKING";
          readonly unitId: Id;
          readonly position: WorldPosition;
      }
    | {
          readonly type: "REMOVE_UNIT";
          readonly unitId: Id;
          readonly reason: BattlefieldRemovalReason;
      }
    | { readonly type: "REGISTER_MECHANISM"; readonly mechanism: Mechanism }
    | { readonly type: "UPDATE_MECHANISM"; readonly mechanism: Mechanism }
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
    readonly registeredUnitIds: readonly Id[];
    readonly removedUnits: readonly {
        readonly unitId: Id;
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
    readonly unitIds: readonly Id[];
    readonly effectLifetimes: Index;
    readonly navigationModifierIds: readonly NavigationModifierId[];
    readonly blockingRelations: readonly BlockingRelation[];
    readonly supportRelations: readonly SupportRelation[];
    getUnit(id: Id): U | undefined;
    getNavigationModifier(id: NavigationModifierId): NavigationModifier | undefined;
    unitsAt(position: TilePosition): readonly U[];
    blockerOf(unitId: Id): Id | undefined;
    blockedBy(unitId: Id): readonly Id[];
    blockingUsedCapacity(unitId: Id): number;
    occupancyAt(position: TilePosition, slot: OccupancySlot): readonly Id[];
    supportOf(unitId: Id): Id | undefined;
    supportedBy(unitId: Id): readonly Id[];
    navigationModifiersAt(position: TilePosition): readonly NavigationModifierId[];
    navigationModifiersFrom(source: NavigationModifierSource): readonly NavigationModifierId[];
    navigationModifiersFollowing(unitId: Id): readonly NavigationModifierId[];
}
