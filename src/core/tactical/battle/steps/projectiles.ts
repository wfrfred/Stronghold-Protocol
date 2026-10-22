import type { Ref } from "../../../common/ref.js";
import { advance } from "../../battlefield/projectile/advance.js";
import { ref, stop } from "../../battlefield/projectile/operations.js";
import type { View } from "../../battlefield/projectile/projectile.js";
import type { State as BattleState } from "../state.js";
import type { Command } from "../contract.js";

export function advanceProjectiles(
    battle: BattleState,
    candidates: readonly Ref<View>[],
    commands: readonly Command[] = [],
): BattleState {
    for (const command of commands) {
        if (command.type !== "STOP_PROJECTILE") {
            continue;
        }

        const current = battle.battlefield.projectiles.get(command.projectileId);

        if (current !== undefined) {
            battle = stop(battle, ref(current));
        }
    }

    return advance(battle, candidates);
}
