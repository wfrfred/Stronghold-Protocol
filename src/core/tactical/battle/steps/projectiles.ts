import { advanceProjectiles as advanceProjectileInstances } from "../../battlefield/projectile/settlement.js";
import type { ProjectileServices } from "../../battlefield/projectile/context.js";
import { advanceBattlefield, battlefieldView, type BattleState } from "../execution/context.js";
import type { Command } from "../contract.js";

export function advanceProjectiles(
    state: BattleState,
    tick: number,
    commands: readonly Command[],
    resources: ProjectileServices,
): void {
    const stopIds = commands
        .filter((command) => command.type === "STOP_PROJECTILE")
        .map((command) => command.projectileId);
    const advanced = advanceProjectileInstances(
        state,
        battlefieldView(state),
        resources,
        tick,
        stopIds,
    );
    advanceBattlefield(state, advanced.changes);
}
