import { hasSkill } from "../../unit/capability/skill/capability.js";
import { gainSkillSp, drainSkillSp, type SkillSpSource } from "../../unit/capability/skill/sp.js";
import { hasStatusFlag } from "../../unit/capability/status/capability.js";
import type { UnitId } from "../../unit/unit.js";
import { getUnit, updateUnit, type BattleState } from "./context.js";

export function gainUnitSkillSp(
    work: BattleState,
    unitId: UnitId,
    source: SkillSpSource,
    amount = 1,
): BattleState {
    const unit = getUnit(work, unitId);

    if (unit === undefined || !hasSkill(unit) || hasStatusFlag(unit, "SP_RECOVERY_BLOCKED")) {
        return work;
    }

    const gained = gainSkillSp(unit.skill, unit.definition.skill, source, amount);

    return gained.state === unit.skill ? work : updateUnit(work, { ...unit, skill: gained.state });
}

export function drainUnitSkillSp(
    work: BattleState,
    unitId: UnitId,
    amount: number,
): { readonly work: BattleState; readonly amount: number } {
    const unit = getUnit(work, unitId);

    if (unit === undefined || !hasSkill(unit)) {
        return { work, amount: 0 };
    }

    const drained = drainSkillSp(unit.skill, amount);

    return {
        work:
            drained.state === unit.skill
                ? work
                : updateUnit(work, { ...unit, skill: drained.state }),
        amount: drained.result.amount,
    };
}
