import type { Ref } from "../../../../common/ref.js";
import { closeLifetime } from "../../../battle/execution/lifetime.js";
import { appendEvents, type State as BattleState } from "../../../battle/state.js";
import { ref } from "../action.js";
import type { Actions } from "../actions.js";
import type { End } from "../definition.js";

type StoredAction = ReturnType<Actions["values"]>[number];

export function end(
    battle: BattleState,
    reference: Ref<StoredAction>,
    result: End,
    lifetimeReason = result.type === "FINISHED" ? "ACTION_FINISHED" : result.reason,
): BattleState {
    return (
        battle.actions.read(reference.id, (self) => {
            if (self.status === "ENDING") {
                return battle;
            }

            const ending = { ...self, status: "ENDING" as const };
            battle = { ...battle, actions: battle.actions.replace(ending) };
            battle = closeLifetime(battle, { type: "ACTION", ref: ref(ending) }, lifetimeReason);

            if (self.definition.onEnd !== undefined) {
                battle = self.definition.onEnd(
                    battle,
                    battle.actions.get(self.id, self.definition) ?? ending,
                    result,
                );
            }

            battle = { ...battle, actions: battle.actions.remove(self.id) };

            return appendEvents(battle, [
                {
                    executionId: self.id,
                    sourceUnitId: self.source.id,
                    tick: battle.tick,
                    ...(result.type === "FINISHED"
                        ? { type: "ACTION_FINISHED" as const }
                        : { type: "ACTION_CANCELLED" as const, reason: result.reason }),
                },
            ]);
        }) ?? battle
    );
}
