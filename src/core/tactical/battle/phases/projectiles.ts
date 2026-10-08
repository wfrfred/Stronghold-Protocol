import {
    createProjectileState,
    type ProjectileId,
    type ProjectileState,
} from "../../battlefield/projectile/state.js";
import { stepProjectiles } from "../../battlefield/projectile/settlement.js";
import type { ProjectileServices } from "../../battlefield/projectile/context.js";
import { combatWorkEvents, combatWorkChanges, createCombatWork } from "../execution/work.js";
import type { BattlePhase } from "../system.js";

export function createProjectileSystem(resources: ProjectileServices): {
    createState(): ProjectileState;
    readonly step: BattlePhase<ProjectileState>;
} {
    const step: BattlePhase<ProjectileState> = (input, state) => {
        const work = createCombatWork(input.battlefield, input.execution, input.battlefield);
        const stopIds: ProjectileId[] = [];

        for (const command of input.commands) {
            if (command.type === "STOP_PROJECTILE") {
                stopIds.push(command.projectileId);
            }
        }

        const advanced = stepProjectiles(work, state, resources, input.tick, stopIds);

        return {
            state: advanced.state,
            changes: combatWorkChanges(advanced.work),
            events: combatWorkEvents(advanced.work),
            execution: advanced.work.execution,
        };
    };

    return { createState: createProjectileState, step };
}
