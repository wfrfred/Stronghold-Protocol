import { activate, advance, operate } from "../../unit/capability/skill/operations.js";
import { ref as activationRef } from "../../unit/capability/skill/activation.js";
import { hasSkill } from "../../unit/capability/skill/capability.js";
import * as units from "../../unit/query.js";
import type { Command } from "../contract.js";
import { getUnit, type State as BattleState } from "../state.js";

export function advanceSkills(state: BattleState, commands: readonly Command[]): BattleState {
    const candidates = units.all(state).filter(hasSkill).map(units.ref).toArray();

    for (const ref of candidates) {
        state = advance(state, ref);
    }

    for (const command of commands) {
        if (command.type !== "ACTIVATE_SKILL" && command.type !== "FINISH_SKILL") {
            continue;
        }

        const unit = getUnit(state, command.unitId);

        if (unit === undefined || !hasSkill(unit)) {
            continue;
        }

        if (command.type === "ACTIVATE_SKILL") {
            state = activate(state, units.ref(unit)).state;
        } else if (unit.skill.active !== null) {
            state = operate(state, activationRef(unit.skill.active), "STOP").state;
        }
    }

    return state;
}
