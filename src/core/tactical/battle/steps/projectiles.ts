import { advanceProjectiles as advanceProjectileInstances } from "../../battlefield/projectile/settlement.js";
import type { ProjectileServices } from "../../battlefield/projectile/context.js";
import { combatWorkEvents, combatWorkChanges, createCombatWork } from "../execution/work.js";
import type { BattlefieldView } from "../../battlefield/contract.js";
import type { BattleExecutionState } from "../execution/state.js";
import type { Command } from "../contract.js";

export function advanceProjectiles(
    battlefield: BattlefieldView,
    execution: BattleExecutionState,
    tick: number,
    commands: readonly Command[],
    resources: ProjectileServices,
) {
    const work = createCombatWork(battlefield, execution, battlefield);
    const stopIds = commands
        .filter((command) => command.type === "STOP_PROJECTILE")
        .map((command) => command.projectileId);
    const advanced = advanceProjectileInstances(work, battlefield, resources, tick, stopIds);

    return {
        changes: [...combatWorkChanges(advanced.work), ...advanced.changes],
        events: combatWorkEvents(advanced.work),
        execution: advanced.work.execution,
    };
}
