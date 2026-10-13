import type { CallContext } from "../../battle/execution/call.js";
import type { DamageOperation } from "../../unit/capability/vitality/damage/contract.js";
import type { HealingOperation } from "../../unit/capability/vitality/healing/contract.js";
import type { Unit, Id } from "../../unit/unit.js";
import type { ProjectileResources } from "./resources.js";
import type { ProjectileId, Projectile } from "./projectile.js";

export interface ProjectileFacts {
    readonly unitIds: readonly Id[];
    getUnit(id: Id): Unit | undefined;
    getProjectile(id: ProjectileId): Projectile | undefined;
}

export interface ProjectileQueryContext<S extends object = object> {
    readonly projectile: Projectile<S>;
    readonly tick: number;
    readonly facts: ProjectileFacts;
    readonly call: CallContext;
}

export type ProjectileCallbackContext<S extends object = object> = ProjectileQueryContext<S>;

export type ProjectileStopContext<S extends object = object> = ProjectileCallbackContext<S>;

export interface ProjectileContactContext<
    S extends object = object,
> extends ProjectileCallbackContext<S> {
    readonly targetUnitId: Id;
}

export interface ProjectileServices {
    readonly projectiles: ProjectileResources;
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
}
