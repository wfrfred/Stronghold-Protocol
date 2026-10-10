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
): void {
    const unit = getUnit(work, unitId);

    if (unit === undefined || !hasSkill(unit) || hasStatusFlag(unit, "SP_RECOVERY_BLOCKED")) {
        return;
    }

    const gained = gainSkillSp(unit.skill, unit.definition.skill, source, amount);

    if (gained.state !== unit.skill) {
        updateUnit(work, { ...unit, skill: gained.state });
    }
}

export function drainUnitSkillSp(work: BattleState, unitId: UnitId, amount: number): number {
    const unit = getUnit(work, unitId);

    if (unit === undefined || !hasSkill(unit)) {
        return 0;
    }

    const drained = drainSkillSp(unit.skill, amount);

    if (drained.state !== unit.skill) {
        updateUnit(work, { ...unit, skill: drained.state });
    }

    return drained.result.amount;
}
