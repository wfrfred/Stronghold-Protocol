import type * as computation from "../../modifier/computation.js";
import type { ContributionFacts } from "../../unit/capability/contribution.js";
import type {
    EffectLifecycleOperations,
    EffectTransitionResources,
} from "../../unit/capability/effects/contract.js";
import type {
    DamageOperation,
    DamageReport,
    DamageRequest,
} from "../../unit/capability/vitality/damage/contract.js";
import type {
    HealingOperation,
    HealingReport,
    HealingRequest,
} from "../../unit/capability/vitality/healing/contract.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import type { ProjectileResources } from "./resources.js";
import type { ProjectileId, ProjectileInstance, ProjectileStopReason } from "./state.js";

export interface ProjectileFacts {
    readonly unitIds: readonly UnitId[];
    getUnit(id: UnitId): Unit | undefined;
    getProjectile(id: ProjectileId): ProjectileInstance | undefined;
}

export interface ProjectileQueryContext<S extends object = object> {
    readonly projectile: ProjectileInstance<S>;
    readonly tick: number;
    readonly facts: ProjectileFacts;
}

export interface ProjectileOperationsFor<S extends object> {
    readonly effects: EffectLifecycleOperations;
    damage(request: Omit<DamageRequest, "tick">): DamageReport;
    heal(request: Omit<HealingRequest, "tick">): HealingReport;
    updateState(transition: (current: S) => S): void;
    stopSelf(reason?: ProjectileStopReason): void;
}

export interface ProjectileCallbackContext<
    S extends object = object,
> extends ProjectileQueryContext<S> {
    readonly operations: ProjectileOperationsFor<S>;
    attackPower(): number;
}

export type ProjectileStopContext<S extends object = object> = ProjectileCallbackContext<S>;

export interface ProjectileContactContext<
    S extends object = object,
> extends ProjectileCallbackContext<S> {
    readonly targetUnitId: UnitId;
}

export interface ProjectileServices extends EffectTransitionResources {
    readonly projectiles: Pick<ProjectileResources, "ownState" | "withProgram">;
    readonly computations: computation.Computations<ContributionFacts>;
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
}
