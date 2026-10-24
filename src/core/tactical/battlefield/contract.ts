import type { TilePosition } from "../geometry/coordinate.js";
import type { State as NavigationState } from "./navigation/state.js";
import type { Unit, Id } from "../unit/unit.js";
import type { OccupancySlot } from "../unit/capability/occupancy/capability.js";
import type { BattlefieldMap } from "./map/map.js";
import type { SupportRelation } from "./support/relations.js";
import type { ProjectileView } from "./projectile/projectile.js";
import type { Index } from "./storage/effect-lifetimes.js";

export type BattlefieldRemovalReason = "DEATH" | "RETREAT" | "EXPIRED" | "SCRIPT";

export interface BattlefieldRuntimeOptions {
    readonly map: BattlefieldMap;
}

export interface BlockingRelation {
    readonly blockerUnitId: Id;
    readonly blockedUnitId: Id;
}

export interface BattlefieldView<U extends Unit = Unit> extends ProjectileView {
    readonly map: BattlefieldMap;
    readonly navigation: NavigationState;
    readonly unitIds: readonly Id[];
    readonly effectLifetimes: Index;
    readonly blockingRelations: readonly BlockingRelation[];
    readonly supportRelations: readonly SupportRelation[];
    getUnit(id: Id): U | undefined;
    unitsAt(position: TilePosition): readonly U[];
    blockerOf(unitId: Id): Id | undefined;
    blockedBy(unitId: Id): readonly Id[];
    blockingUsedCapacity(unitId: Id): number;
    occupancyAt(position: TilePosition, slot: OccupancySlot): readonly Id[];
    supportOf(unitId: Id): Id | undefined;
    supportedBy(unitId: Id): readonly Id[];
}
