import { combatWorkView, getCombatUnit, type CombatWork } from "../../../battle/execution/work.js";
import { resolveAttackPower } from "../../../unit/capability/offense/query.js";
import { EffectDispatchScope } from "../../../unit/capability/effects/dispatch.js";
import { createEffectOperations } from "../../../unit/capability/effects/operations.js";
import type {
    ProjectileFacts,
    ProjectileQueryContext,
    ProjectileServices,
    ProjectileStopContext,
} from "../context.js";
import type { ProjectileProgram } from "../program.js";
import type { ProjectileId, ProjectileInstance, ProjectileStopReason } from "../state.js";
import { updateProjectileInstance } from "./state.js";

export interface ProjectileContextAccess {
    getWork(): CombatWork;
    setWork(work: CombatWork): void;
    getProjectile(id: ProjectileId): ProjectileInstance | undefined;
    lastKnown(id: ProjectileId): ProjectileInstance | undefined;
    save(instance: ProjectileInstance): void;
    stop(id: ProjectileId, reason: ProjectileStopReason): void;
}

function projectileFacts(
    readWork: () => CombatWork,
    getProjectile: (id: ProjectileId) => ProjectileInstance | undefined,
): ProjectileFacts {
    return {
        get unitIds() {
            return combatWorkView(readWork()).unitIds;
        },
        getUnit: (id) => getCombatUnit(readWork(), id),
        getProjectile: (id) => {
            readWork();

            return getProjectile(id);
        },
    };
}

export function withProjectileQuery<S extends object, R>(
    instance: ProjectileInstance<S>,
    access: ProjectileContextAccess,
    tick: number,
    run: (context: ProjectileQueryContext<S>) => R,
): R {
    let active = true;

    const readWork = (): CombatWork => {
        if (!active) {
            throw new TypeError("projectile query context is no longer active");
        }

        return access.getWork();
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
    instance: ProjectileInstance<S>,
    program: ProjectileProgram<S>,
    services: ProjectileServices,
    access: ProjectileContextAccess,
    tick: number,
    run: (context: ProjectileStopContext<S>) => unknown,
): void {
    let active = true;
    const dispatch = new EffectDispatchScope();

    const readWork = (): CombatWork => {
        if (!active) {
            throw new TypeError("projectile context is no longer active");
        }

        return access.getWork();
    };
    const readProjectile = (): ProjectileInstance<S> => {
        readWork();

        return (access.getProjectile(instance.id) ??
            access.lastKnown(instance.id) ??
            instance) as ProjectileInstance<S>;
    };

    const context: ProjectileStopContext<S> = {
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
                          combatWorkView(readWork()),
                          services.offense,
                      );

            return attack ?? projectile.cachedAtk;
        },
        operations: {
            effects: createEffectOperations(
                readWork,
                (work) => {
                    access.setWork(work);
                },
                services,
                tick,
                dispatch,
            ),
            damage: (request) => {
                const result = services.settleDamage(readWork(), request, dispatch);
                access.setWork(result.work);

                return result.report;
            },
            heal: (request) => {
                const result = services.settleHealing(readWork(), request, tick, dispatch);
                access.setWork(result.work);

                return result.report;
            },
            updateState: (transition) => {
                const current = readProjectile();
                const state = services.projectiles.ownState(program.ref, transition(current.state));
                const latest = readProjectile();
                access.save(updateProjectileInstance(latest, { state }));
            },
            stopSelf: (reason) => {
                readWork();
                access.stop(instance.id, reason ?? "EXPLICIT");
            },
        },
    };

    try {
        const result = run(context);

        if (result !== undefined) {
            throw new TypeError(
                "projectile content must complete synchronously without returning a value",
            );
        }
    } finally {
        active = false;
    }
}
