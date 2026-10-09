import type { ProjectileId } from "../battlefield/projectile/state.js";
import { advanceProjectiles as advanceProjectileInstances } from "../battlefield/projectile/settlement.js";
import type { ProjectileServices } from "../battlefield/projectile/context.js";
import { combatWorkEvents, combatWorkChanges, createCombatWork } from "./execution/work.js";
import type { BattlefieldView } from "../battlefield/contract.js";
import type { BattleExecutionState } from "./execution/state.js";

export function advanceProjectiles(
    battlefield: Pick<
        BattlefieldView,
        | "unitIds"
        | "getUnit"
        | "blockerOf"
        | "blockedBy"
        | "mechanismIds"
        | "getMechanism"
        | "projectileIds"
        | "getProjectile"
    >,
    execution: BattleExecutionState,
    tick: number,
    stopIds: readonly ProjectileId[],
    resources: ProjectileServices,
) {
    const work = createCombatWork(battlefield, execution, battlefield);
    const advanced = advanceProjectileInstances(work, battlefield, resources, tick, stopIds);

    return {
        changes: [...combatWorkChanges(advanced.work), ...advanced.changes],
        events: combatWorkEvents(advanced.work),
        execution: advanced.work.execution,
    };
}
