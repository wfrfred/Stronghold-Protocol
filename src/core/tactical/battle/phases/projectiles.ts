import { createProjectileState, type ProjectileState } from "../../battlefield/projectile/state.js";
import { stepProjectiles, stopProjectile } from "../../battlefield/projectile/settlement.js";
import { combatWorkChanges, createCombatWork } from "../execution/work.js";
import type { CombatResources } from "../resources.js";
import type { BattlePhase, BattleSystem } from "../system.js";

export function createProjectileSystem(
    resources: CombatResources,
): BattleSystem<ProjectileState> & {
    readonly step: BattlePhase<ProjectileState>;
} {
    const step: BattlePhase<ProjectileState> = (input, state) => {
        let work = createCombatWork(input.battlefield, input.execution, input.battlefield);

        for (const command of input.commands) {
            if (command.type === "STOP_PROJECTILE") {
                const stopped = stopProjectile(
                    work,
                    state,
                    command.projectileId,
                    resources,
                    input.tick,
                );
                work = stopped.work;
                state = stopped.state;
            }
        }

        const advanced = stepProjectiles(work, state, resources, input.tick);

        return {
            state: advanced.state,
            changes: combatWorkChanges(advanced.work),
            events: advanced.work.events,
            execution: advanced.work.execution,
        };
    };

    return { createState: createProjectileState, step };
}
