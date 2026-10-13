import { hasSkill } from "../../unit/capability/skill/capability.js";
import { gainSkillSp, drainSkillSp, type SkillSpSource } from "../../unit/capability/skill/sp.js";
import { hasStatusFlag } from "../../unit/capability/status/capability.js";
import type { Id } from "../../unit/unit.js";
import { getUnit, updateUnit, type BattleState, type Result } from "../state.js";

export function gainUnitSkillSp(
    state: BattleState,
    unitId: Id,
    source: SkillSpSource,
    amount = 1,
): BattleState {
    const unit = getUnit(state, unitId);

    if (unit === undefined || !hasSkill(unit) || hasStatusFlag(unit, "SP_RECOVERY_BLOCKED")) {
        return state;
    }

    const gained = gainSkillSp(unit.skill, unit.definition.skill, source, amount);

    if (gained.state !== unit.skill) {
        return updateUnit(state, { ...unit, skill: gained.state });
    }

    return state;
}

export function drainUnitSkillSp(state: BattleState, unitId: Id, amount: number): Result<number> {
    const unit = getUnit(state, unitId);

    if (unit === undefined || !hasSkill(unit)) {
        return { state, value: 0 };
    }

    const drained = drainSkillSp(unit.skill, amount);

    if (drained.state !== unit.skill) {
        state = updateUnit(state, { ...unit, skill: drained.state });
    }

    return { state, value: drained.result.amount };
}
