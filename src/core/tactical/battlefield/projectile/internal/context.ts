import { battlefieldView, getUnit, type BattleState } from "../../../battle/execution/context.js";
import { resolveAttackPower } from "../../../unit/capability/offense/query.js";
import { EffectDispatchScope } from "../../../unit/capability/effects/dispatch.js";
import { createEffectOperations } from "../../../unit/capability/effects/operations.js";
import type {
    ProjectileCallbackContext,
    ProjectileFacts,
    ProjectileQueryContext,
    ProjectileServices,
} from "../context.js";
import type { ProjectileId, Projectile, ProjectileStopReason } from "../projectile.js";
import { updateProjectile } from "./state.js";

export interface ProjectileContextAccess {
    readonly state: BattleState;
    getProjectile(id: ProjectileId): Projectile | undefined;
    lastKnown(id: ProjectileId): Projectile | undefined;
    save(instance: Projectile): void;
    stop(id: ProjectileId, reason: ProjectileStopReason): void;
}

function projectileFacts(
    readWork: () => BattleState,
    getProjectile: (id: ProjectileId) => Projectile | undefined,
): ProjectileFacts {
    return {
        get unitIds() {
            return battlefieldView(readWork()).unitIds;
        },
        getUnit: (id) => getUnit(readWork(), id),
        getProjectile: (id) => {
            readWork();

            return getProjectile(id);
        },
    };
}

export function withProjectileQuery<S extends object, R>(
    instance: Projectile<S>,
    access: ProjectileContextAccess,
    tick: number,
    run: (context: ProjectileQueryContext<S>) => R,
): R {
    let active = true;

    const readWork = (): BattleState => {
        if (!active) {
            throw new TypeError("projectile query context is no longer active");
        }

        return access.state;
    };

    const context: ProjectileQueryContext<S> = {
        get projectile() {
            readWork();

            return instance;
        },
        tick,
        facts: projectileFacts(readWork, (id) => access.getProjectile(id)),
    };

    try {
        return run(context);
    } finally {
        active = false;
    }
}

export function withProjectileContext<S extends object>(
    instance: Projectile<S>,
    services: ProjectileServices,
    access: ProjectileContextAccess,
    tick: number,
    run: (context: ProjectileCallbackContext<S>) => undefined,
): void {
    let active = true;
    const dispatch = new EffectDispatchScope();

    const readWork = (): BattleState => {
        if (!active) {
            throw new TypeError("projectile context is no longer active");
        }

        return access.state;
    };
    const readProjectile = (): Projectile<S> => {
        readWork();

        return (access.getProjectile(instance.id) ??
            access.lastKnown(instance.id) ??
            instance) as Projectile<S>;
    };

    const context: ProjectileCallbackContext<S> = {
        get projectile() {
            return readProjectile();
        },
        tick,
        facts: projectileFacts(readWork, (id) => access.getProjectile(id)),
        attackPower: () => {
            const projectile = readProjectile();
            const attack =
                projectile.source === null
                    ? undefined
                    : resolveAttackPower(
                          projectile.source,
                          battlefieldView(readWork()),
                          services.computations,
                      );

            return attack ?? projectile.cachedAtk;
        },
        operations: {
            effects: createEffectOperations(readWork, services, tick, dispatch),
            damage: (request) => services.settleDamage(readWork(), { ...request, tick }, dispatch),
            heal: (request) => services.settleHealing(readWork(), { ...request, tick }, dispatch),
            updateState: (transition) => {
                const current = readProjectile();
                const state = transition(current.state);
                const latest = readProjectile();
                access.save(updateProjectile(latest, { state }));
            },
            stopSelf: (reason) => {
                readWork();
                access.stop(instance.id, reason ?? "EXPLICIT");
            },
        },
    };

    try {
        run(context);
    } finally {
        active = false;
    }
}
