import type { NumericContributionProvider } from "../../modifier/providers.js";
import type { NumericProviderFacts } from "../../unit/capability/contribution.js";
import type {
    EffectLifecycleOperations,
    EffectTransitionResources,
} from "../../unit/capability/effects/contract.js";
import type {
    DamageReport,
    DamageRequest,
} from "../../unit/capability/vitality/damage/contract.js";
import type {
    HealingReport,
    HealingRequest,
} from "../../unit/capability/vitality/healing/contract.js";
import type { DamageOperation, HealingOperation } from "../../unit/capability/vitality/hook.js";
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
    damage(request: DamageRequest): DamageReport;
    heal(request: HealingRequest): HealingReport;
    updateState(transition: (current: S) => S): void;
    stopSelf(reason?: ProjectileStopReason): void;
}

export interface ProjectileStopContext<
    S extends object = object,
> extends ProjectileQueryContext<S> {
    readonly operations: ProjectileOperationsFor<S>;
    attackPower(): number;
}

export interface ProjectileContactContext<
    S extends object = object,
> extends ProjectileStopContext<S> {
    readonly targetUnitId: UnitId;
}

export interface ProjectileServices extends EffectTransitionResources {
    readonly projectiles: ProjectileResources;
    readonly offense: NumericContributionProvider<NumericProviderFacts>;
    readonly settleDamage: DamageOperation;
    readonly settleHealing: HealingOperation;
}
