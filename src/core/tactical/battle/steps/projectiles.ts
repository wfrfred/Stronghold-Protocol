import { advanceProjectiles as advance } from "../../battlefield/projectile/settlement.js";
import type { State as BattleState } from "../state.js";
import type { Command } from "../contract.js";

export function advanceProjectiles(
    state: BattleState,
    tick: number,
    commands: readonly Command[],
): BattleState {
    const stopIds = commands
        .filter((command) => command.type === "STOP_PROJECTILE")
        .map((command) => command.projectileId);

    return advance(state, tick, stopIds);
}
