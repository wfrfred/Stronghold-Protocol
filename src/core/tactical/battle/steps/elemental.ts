import { advance } from "../../unit/capability/elemental/operations.js";
import { hasElemental } from "../../unit/capability/elemental/capability.js";
import * as units from "../../unit/query.js";
import type { State as BattleState } from "../state.js";

export function advanceElements(battle: BattleState): BattleState {
    const candidates = units.filter(battle, hasElemental);

    for (const ref of candidates) {
        battle = advance(battle, ref);
    }

    return battle;
}
