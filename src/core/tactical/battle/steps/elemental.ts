import {
    advanceElemental,
    type ElementalExecutionResources,
} from "../../unit/capability/elemental/execution.js";
import { battlefieldView, type BattleState } from "../state.js";

export function advanceElements(
    state: BattleState,
    tick: number,
    resources: ElementalExecutionResources,
): BattleState {
    for (const id of battlefieldView(state).unitIds) {
        state = advanceElemental(state, id, tick, resources);
    }

    return state;
}
