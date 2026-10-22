import type { Ref } from "../../../common/ref.js";
import type { State as BattleState } from "../../battle/state.js";
import type { View } from "./projectile.js";

export function advance(battle: BattleState, candidates: readonly Ref<View>[]): BattleState {
    for (const reference of candidates) {
        battle =
            battle.battlefield.projectiles.read(reference.id, (self) =>
                self.lifecycle === "ACTIVE"
                    ? (self.definition.onAdvance?.(battle, self) ?? battle)
                    : battle,
            ) ?? battle;
    }

    return battle;
}
