import assert from "node:assert/strict";
import { test } from "node:test";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { combatWorkView, getCombatUnit, updateCombatUnit } from "../../dist/core/tactical/battle/execution/work.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { activateSkill, advanceSkill } from "../../dist/core/tactical/unit/capability/skill/execution.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { compileArknightsAttackBuffSkill } from "../../dist/data/arknights/skill-buff.js";
import { parseArknightsSkillLevel } from "../../dist/data/arknights/skill-definition.js";
import { createSkillDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { gainSkillSp } from "../../dist/core/tactical/unit/capability/skill/sp.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { effectFixtureWork } from "../helpers/effects.js";

const attackBuff = {
  skillId: "skcom_atk_up[1]",
  levels: [{
    name: "攻击力强化·α型",
    skillType: "MANUAL",
    durationType: "NONE",
    spData: { spType: "INCREASE_WITH_TIME", maxChargeTime: 1, spCost: 50, initSp: 0, increment: 1 },
    duration: 20,
    blackboard: [{ key: "atk", value: 0.1, valueStr: null }],
  }],
};

test("native Attack Enhancement Alpha level 1 charges, buffs attack for 20 seconds, ends, and charges again", () => {
  const resources = new CombatResources();
  const compiled = resources.skills.register(compileArknightsAttackBuffSkill(attackBuff, 1, resources));
  resources.seal();
  const unit = initializeUnit({
    id: 1, position: [0, 0],
    definition: { id: "real-skill-fixture", skill: compiled.definition, offense: { attack: 100 } },
  });
  let work = effectFixtureWork(unit);
  assert.equal(activateSkill(work, { unitId: 1, tick: 0 }, resources).result.reason, "INSUFFICIENT_SP");
  work = advanceSkill(work, 1, 1500, resources).work;
  assert.equal(getCombatUnit(work, 1).skill.sp, 50);
  const active = activateSkill(work, { unitId: 1, tick: 1500 }, resources);
  assert.equal(active.result.type, "ACTIVATED");
  work = active.work;
  assert.equal(getCombatUnit(work, 1).skill.active.endsAtTick, 2100);
  assert.equal(Math.round(resolveAttackPower(1, combatWorkView(work), resources.computations)), 110);
  work = advanceSkill(work, 1, 2099, resources).work;
  assert.equal(getCombatUnit(work, 1).skill.sp, 0);
  work = advanceSkill(work, 1, 2100, resources).work;
  assert.equal(resolveAttackPower(1, combatWorkView(work), resources.computations), 100);
  assert.equal(getCombatUnit(work, 1).skill.active, null);
  work = advanceSkill(work, 1, 2130, resources).work;
  assert.equal(getCombatUnit(work, 1).skill.sp, 1);
});

test("native SP enums and timing values decode without interpreting unrelated terrain skill blackboards", () => {
  const records = [
    ["skchr_chen_1", "AUTO", "INCREASE_WHEN_ATTACK", 7, 0, 0, "ATTACK"],
    ["skchr_mudrok_2", "AUTO", "INCREASE_WHEN_TAKEN_DAMAGE", 6, 0, 0, "HIT"],
    ["skchr_angel_2", "MANUAL", "INCREASE_WITH_TIME", 45, 15, 15, "TIME"],
    ["skchr_huang_2", "AUTO", "INCREASE_WITH_TIME", 90, 0, -1, "TIME"],
  ];
  for (const [id, type, spType, cost, initial, duration, expected] of records) {
    const parsed = parseArknightsSkillLevel({
      skillId: id,
      levels: [{ skillType: type, duration, spData: { spType, spCost: cost, initSp: initial, maxChargeTime: 1, increment: 1 }, blackboard: [] }],
    });
    assert.equal(parsed.definition.spRecovery, expected);
    assert.equal(parsed.definition.initialSp, initial);
    assert.equal(parsed.definition.durationTicks, duration === -1 ? null : duration * 30);
  }
  const passive = parseArknightsSkillLevel({
    skillId: "skchr_brownb_1",
    levels: [{ skillType: "PASSIVE", duration: 0, spData: { spType: 8, spCost: 0, initSp: 0, maxChargeTime: 0, increment: 0 }, blackboard: [] }],
  });
  assert.equal(passive.definition.spRecovery, "NONE");
  assert.equal(passive.definition.maxCharges, 0);
  assert.throws(() => parseArknightsSkillLevel(attackBuff, 2), /unknown skill level/);
  assert.throws(() => parseArknightsSkillLevel({ ...attackBuff, levels: [{ ...attackBuff.levels[0], durationType: "AMMO", duration: -1 }] }), /unsupported skill duration mode/);
  assert.throws(() => parseArknightsSkillLevel({ ...attackBuff, levels: [{ ...attackBuff.levels[0], spData: { ...attackBuff.levels[0].spData, spType: "unrecognized" } }] }), /unsupported skill SP/);
});

const unsheathe = {
  skillId: "skchr_chen_2",
  levels: [{
    skillType: "MANUAL", duration: 0,
    spData: { spType: "INCREASE_WHEN_ATTACK", spCost: 27, initSp: 10, maxChargeTime: 1, increment: 1 },
    blackboard: [{ key: "atk_scale", value: 3.3, valueStr: null }, { key: "max_target", value: 4, valueStr: null }],
  }],
};

function instantDamageFixture(automatic = false, withTarget = true) {
  const resources = new CombatResources();
  const parsed = parseArknightsSkillLevel(unsheathe);
  const definition = automatic ? createSkillDefinition({ ...parsed.definition, activation: "AUTO" }) : parsed.definition;
  const target = (context) => context.facts.getUnit(2);
  let reports = [];
  resources.skills.register({
    definition,
    accepts: (context) => {
      const receiver = target(context);
      return receiver !== undefined && receiver.vitality.hp > 0;
    },
    activate: (context) => {
      assert.deepEqual(context.facts.blockedBy(1), []);
      assert.equal(context.facts.blockerOf(2), undefined);
      for (const damageType of ["PHYSICAL", "ARTS"]) {
        reports.push(context.damage({ sourceUnitId: 1, targetUnitId: 2, damageType, operands: createDamageOperands(330) }));
      }
      return { type: "ACTIVATED" };
    },
  });
  const unit = initializeUnit({ id: 1, position: [0, 0], definition: { id: "instant-caster", skill: definition } });
  const enemy = initializeUnit({ id: 2, position: [1, 0], definition: { id: "instant-target", vitality: { maxHp: 1000 } } });
  let work = effectFixtureWork(unit, ...(withTarget ? [enemy] : []));
  work = updateCombatUnit(work, { ...unit, skill: gainSkillSp(unit.skill, definition, "EXTERNAL", 17).state });
  return { resources, work, reports };
}

test("native Unsheathe level 1 metadata supports synchronous physical and arts damage through a one-target content fixture", () => {
  const f = instantDamageFixture();
  const activated = activateSkill(f.work, { unitId: 1, tick: 0 }, f.resources);
  assert.equal(activated.result.type, "ACTIVATED");
  assert.equal(getCombatUnit(activated.work, 2).vitality.hp, 340);
  assert.equal(getCombatUnit(activated.work, 1).skill.active, null);
  assert.equal(f.reports.length, 2);
  assert.ok(f.reports.every((report) => report.request.tick === 0));
});

test("AUTO instant content keeps full SP when its required target is absent", () => {
  const f = instantDamageFixture(true, false);
  const advanced = advanceSkill(f.work, 1, 1, f.resources);
  assert.equal(advanced.signals.length, 0);
  assert.equal(getCombatUnit(advanced.work, 1).skill.sp, 27);
  assert.equal(f.reports.length, 0);
});

test("instant healing uses the current activation tick and returns the settled healing report", () => {
  const resources = new CombatResources();
  const definition = createSkillDefinition({ id: "instant-heal-port", activation: "MANUAL", spRecovery: "TIME", spCost: 0, initialSp: 0, durationTicks: 0 });
  let report;
  resources.skills.register({ definition, activate: (context) => {
    report = context.heal({ sourceUnitId: 1, targetUnitId: 1, power: 30, ignoreHealFree: false });
    return { type: "ACTIVATED" };
  } });
  const unit = initializeUnit({ id: 1, position: [0, 0], definition: { id: "heal-caster", skill: definition, vitality: { maxHp: 100 } }, states: { vitality: { hp: 50, maxHp: { entries: [] } } } });
  const activated = activateSkill(effectFixtureWork(unit), { unitId: 1, tick: 3 }, resources);
  assert.equal(getCombatUnit(activated.work, 1).vitality.hp, 80);
  assert.equal(report.amount, 30);
});
