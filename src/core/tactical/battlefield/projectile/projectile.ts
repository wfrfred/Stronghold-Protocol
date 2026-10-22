import type { Definition } from "./definition.js";
import type { Identified, Ref } from "../../../common/ref.js";
import type { WorldPosition } from "../../geometry/coordinate.js";
import type { Range } from "../../geometry/range.js";
import type { Id } from "../../unit/unit.js";

export type ProjectileId = number;

export type ProjectileStopReason = "ARRIVED" | "EXPIRED" | "EXPLICIT";

export type ProjectileProgress =
    | { readonly type: "FLYING" }
    | { readonly type: "WAITING_TO_STOP"; readonly targetTick: number }
    | { readonly type: "STOPPED"; readonly reason: ProjectileStopReason };

export interface View extends Identified<{
    readonly id: ProjectileId;
}> {
    readonly id: ProjectileId;
    readonly definition: Pick<Definition<object>, "id">;
    readonly source: Id | null;
    readonly traceTarget: Id | null;
    readonly position: WorldPosition;
    readonly destination: WorldPosition;
    readonly cachedAtk: number;
    readonly speedPerTick: number;
    readonly contactRange: Range;
    readonly stopDelayTicks: number;
    readonly launchedAtTick: number;
    readonly lastAdvancedTick: number;
    readonly expiresAtTick: number | null;
    readonly progress: ProjectileProgress;
    readonly hitUnitIds: readonly Id[];
}

export interface Projectile<S extends object = object> extends View {
    readonly definition: Definition<S>;
    readonly state: S;
}

export interface Snapshot extends View {
    readonly state: unknown;
}

export interface ProjectileView {
    readonly projectileIds: readonly ProjectileId[];
    getProjectile<P extends View>(reference: Ref<P>): P | undefined;
}

/** Snapshot projection; live instances belong to Battlefield. */
export interface ProjectileState {
    readonly nextProjectileId: ProjectileId;
    readonly instances: readonly Snapshot[];
}
