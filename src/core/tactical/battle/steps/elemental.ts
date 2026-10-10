import {
    advanceElementalInWork,
    type ElementalExecutionResources,
} from "../../unit/capability/elemental/execution.js";
import { battlefieldView, type BattleState } from "../execution/context.js";

export function advanceElements(
    state: BattleState,
    tick: number,
    resources: ElementalExecutionResources,
): void {
    for (const id of battlefieldView(state).unitIds) {
        advanceElementalInWork(state, id, tick, resources);
    }
}
