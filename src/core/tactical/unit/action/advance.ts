import type { Ref } from "../../../common/ref.js";
import type { State as BattleState } from "../../battle/state.js";
import { get as getUnit } from "../query.js";
import { isSpatiallyPresent } from "../capability/presence/capability.js";
import type { Actions } from "./actions.js";
import { end } from "./internal/end.js";

type StoredAction = ReturnType<Actions["values"]>[number];

export function advance(battle: BattleState, reference: Ref<StoredAction>): BattleState {
    return (
        battle.actions.read(reference.id, (self) => {
            if (self.status !== "RUNNING") {
                return battle;
            }

            const source = getUnit(battle, self.source);

            if (source?.lifecycle !== "PRESENT" || !isSpatiallyPresent(source)) {
                return end(battle, reference, { type: "CANCELLED", reason: "SOURCE_ABSENT" });
            }

            const advanced = self.definition.step(battle, self);

            return advanced.value
                ? end(advanced.state, reference, { type: "FINISHED" })
                : advanced.state;
        }) ?? battle
    );
}
