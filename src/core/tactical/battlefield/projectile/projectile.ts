import type { Definition } from "./definition.js";
import type { Projectiles } from "./projectiles.js";
import type { WorldPosition } from "../../geometry/coordinate.js";
import type { RangeGeometry } from "../../geometry/shape.js";
import type { Id } from "../../unit/unit.js";

export type ProjectileId = number;

export type ProjectileStopReason = "ARRIVED" | "EXPIRED" | "EXPLICIT";

export type ProjectileProgress =
    | { readonly type: "FLYING" }
    | { readonly type: "WAITING_TO_STOP"; readonly targetTick: number }
    | { readonly type: "STOPPED"; readonly reason: ProjectileStopReason };

export interface Projectile<S extends object = object> {
    readonly id: ProjectileId;
    readonly definition: Definition<S>;
    readonly source: Id | null;
    readonly traceTarget: Id | null;
    readonly position: WorldPosition;
    readonly destination: WorldPosition;
    readonly cachedAtk: number;
    readonly speedPerTick: number;
    readonly contactRange: RangeGeometry;
    readonly stopDelayTicks: number;
    readonly launchedAtTick: number;
    readonly lastAdvancedTick: number;
    readonly expiresAtTick: number | null;
    readonly progress: ProjectileProgress;
    readonly hitUnitIds: readonly Id[];
    readonly state: S;
}

export interface ProjectileView {
    readonly projectileIds: readonly ProjectileId[];
    getProjectile(id: ProjectileId): ReturnType<Projectiles["values"]>[number] | undefined;
}

/** Snapshot projection; live instances belong to Battlefield. */
export interface ProjectileState {
    readonly nextProjectileId: ProjectileId;
    readonly instances: ReturnType<Projectiles["values"]>;
}
