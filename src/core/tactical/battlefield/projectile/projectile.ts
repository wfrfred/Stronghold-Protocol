import type { Definition } from "./definition.js";
import type { Identified, Ref } from "../../../common/ref.js";
import type { WorldPosition } from "../../geometry/coordinate.js";

export type Id = number;

export type Lifecycle = "ACTIVE" | "ENDING";

export interface View extends Identified<{ readonly id: Id }> {
    readonly id: Id;
    readonly definition: Pick<Definition<object>, "id">;
    readonly lifecycle: Lifecycle;
    readonly position: WorldPosition;
}

export interface Projectile<S extends object> extends View {
    readonly definition: Definition<S>;
    readonly state: S;
}

export interface Snapshot extends View {
    readonly state: unknown;
}

export interface ProjectileView {
    readonly projectileIds: readonly Id[];
    getProjectile<P extends View>(reference: Ref<P>): P | undefined;
}

export interface ProjectileState {
    readonly nextProjectileId: Id;
    readonly instances: readonly Snapshot[];
}
