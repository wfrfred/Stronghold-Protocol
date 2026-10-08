import { hasSkill } from "../../unit/capability/skill/capability.js";
import { gainSkillSp, type SkillSpSource } from "../../unit/capability/skill/sp.js";
import { hasStatusFlag } from "../../unit/capability/status/capability.js";
import type { UnitId } from "../../unit/unit.js";
import { getCombatUnit, updateCombatUnit, type CombatWork } from "./work.js";

export function gainUnitSkillSp(
    work: CombatWork,
    unitId: UnitId,
    source: SkillSpSource,
    amount = 1,
): CombatWork {
    const unit = getCombatUnit(work, unitId);

    if (unit === undefined || !hasSkill(unit) || hasStatusFlag(unit, "SP_RECOVERY_BLOCKED")) {
        return work;
    }

    const gained = gainSkillSp(unit.skill, unit.definition.skill, source, amount);

    return gained.state === unit.skill
        ? work
        : updateCombatUnit(work, { ...unit, skill: gained.state });
}
