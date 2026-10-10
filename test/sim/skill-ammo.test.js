import assert from "node:assert/strict";
import { test } from "node:test";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { advanceBattlefield, battlefieldView, getUnit, updateUnit } from "../../dist/core/tactical/battle/execution/context.js";
import { createProjectileProgram } from "../../dist/core/tactical/battlefield/projectile/program.js";
import { withProjectileOperations } from "../../dist/core/tactical/battlefield/projectile/operations.js";
import { advanceProjectiles } from "../../dist/core/tactical/battlefield/projectile/settlement.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { attack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import * as modifier from "../../dist/core/tactical/modifier/value.js";
import { copySkillState, createSkillDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { activateSkill, advanceSkill, consumeSkillAmmo } from "../../dist/core/tactical/unit/capability/skill/execution.js";
import { spendSkillAmmo } from "../../dist/core/tactical/unit/capability/skill/ammo.js";
import { gainSkillSp } from "../../dist/core/tactical/unit/capability/skill/sp.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { parseArknightsSkillLevel } from "../../dist/data/arknights/skill-definition.js";
import { effectFixtureWork } from "../helpers/effects.js";

const ash = {
  skillId: "skchr_ash_2",
  levels: [{
    skillType: "MANUAL", durationType: "AMMO", duration: -1,
    spData: { spType: "INCREASE_WITH_TIME", spCost: 30, initSp: 0, maxChargeTime: 1, increment: 1 },
    blackboard: [{ key: "base_attack_time", value: -0.8, valueStr: null }, { key: "ash_s_2[atk_scale].atk_scale", value: 1.5, valueStr: null }],
  }],
};

function ammoFixture(ammo = 31, ammoPerAttack = 1) {
  const resources = new CombatResources();
  const definition = parseArknightsSkillLevel(ash, 1, ammo, ammoPerAttack).definition;
  const buff = resources.registerEffect(createEffectProgram({ id: "ammo-fixture-attack", initialize: () => ({}), ownState: (state) => state }), {
    contributions: [attack(() => [modifier.create({ multiplier: 1 })])],
  });
  resources.skills.register({ definition, activate: (context) => {
    const installed = context.effects.install(context.unitId, buff.ref, { source: 1, scopes: [{ type: "SKILL", unitId: context.unitId, activationId: context.activationId }] });
    assert.equal(installed.type, "INSTALLED");
    return { type: "ACTIVATED" };
  } });
  const unit = initializeUnit({ id: 1, position: [0, 0], definition: { id: "ammo-caster", skill: definition, offense: { attack: 100 } } });
  const enemy = initializeUnit({ id: 2, position: [1, 0], definition: { id: "ammo-target", vitality: { maxHp: 1000 }, hit: { geometry: { shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.2 }] } } } });
  let work = effectFixtureWork(unit, enemy);
  updateUnit(work, { ...unit, skill: gainSkillSp(unit.skill, definition, "EXTERNAL", 30).state });
  activateSkill(work, { unitId: 1, tick: 0 }, resources);
  return { resources, definition, work };
}

test("native AMMO duration values require explicit content counts and never become time deadlines", () => {
  const ashDefinition = parseArknightsSkillLevel(ash, 1, 31).definition;
  assert.equal(ashDefinition.ammo, 31);
  assert.equal(ashDefinition.ammoPerAttack, 1);
  assert.equal(ashDefinition.durationTicks, null);
  const aurora = { ...ash, skillId: "skchr_aurora_2", levels: [{ ...ash.levels[0], duration: 0, spData: { ...ash.levels[0].spData, spCost: 26, initSp: 8 }, blackboard: [{ key: "atk", value: 0.3, valueStr: null }] }] };
  assert.equal(parseArknightsSkillLevel(aurora, 1, 9).definition.durationTicks, null);
  const chen = { ...ash, skillId: "skchr_chen2_3", levels: [{ ...ash.levels[0], spData: { ...ash.levels[0].spData, spCost: 70, initSp: 15 }, blackboard: [{ key: "attack@trigger_time", value: 32, valueStr: null }] }] };
  const chenDefinition = parseArknightsSkillLevel(chen, 1, 32, 2).definition;
  assert.equal(chenDefinition.ammo, 32);
  assert.equal(chenDefinition.ammoPerAttack, 2);
  assert.throws(() => parseArknightsSkillLevel(ash), /explicit ammunition count/);
  assert.throws(() => parseArknightsSkillLevel(ash, 1, 0), /positive safe integer/);
  assert.throws(() => createSkillDefinition({ ...ashDefinition, durationTicks: 30 }), /end by ammunition/);
});

test("pure ammunition spending preserves snapshots and clamps the final consumption to what remains", () => {
  const f = ammoFixture(3);
  const initial = getUnit(f.work, 1).skill;
  const copied = copySkillState(initial);
  const first = spendSkillAmmo(copied, 2);
  assert.deepEqual(first.result, { type: "APPLIED", amount: 2, remainingAmmo: 1 });
  assert.equal(initial.active.remainingAmmo, 3);
  assert.equal(copied.active.remainingAmmo, 3);
  const final = spendSkillAmmo(first.state, 2);
  assert.deepEqual(final.result, { type: "APPLIED", amount: 1, remainingAmmo: 0 });
  assert.throws(() => spendSkillAmmo(initial, 0), /positive safe integer/);
  assert.equal(spendSkillAmmo({ ...initial, active: null }).result.reason, "INACTIVE");
  const { remainingAmmo, ...activeWithoutAmmo } = initial.active;
  assert.equal(remainingAmmo, 3);
  assert.equal(spendSkillAmmo({ ...initial, active: activeWithoutAmmo }).result.reason, "NO_AMMO");
});

test("Ash's 31-round profile remains active indefinitely without attacks and ends on its 31st consumption", () => {
  const f = ammoFixture();
  let work = f.work;
  advanceSkill(work, 1, 10000, f.resources);
  assert.equal(getUnit(work, 1).skill.active.remainingAmmo, 31);
  assert.equal(getUnit(work, 1).skill.sp, 0);
  for (let i = 1; i <= 30; i++) {
    const consumed = consumeSkillAmmo(work, 1, 10000 + i, f.resources);
    assert.equal(consumed.signals.length, 0);
  }
  assert.equal(getUnit(work, 1).skill.active.remainingAmmo, 1);
  const final = consumeSkillAmmo(work, 1, 10031, f.resources);
  assert.equal(final.result.amount, 1);
  assert.deepEqual(final.signals.map((signal) => signal.type), ["SKILL_FINISHED"]);
  assert.equal(getUnit(work, 1).skill.active, null);
  assert.equal(resolveAttackPower(1, battlefieldView(work), f.resources.computations), 100);
  assert.equal(consumeSkillAmmo(work, 1, 10031, f.resources).result.reason, "INACTIVE");
});

test("explicit two-round attack consumption ends a 32-round profile after sixteen attacks", () => {
  const f = ammoFixture(32, 2);
  let work = f.work;
  for (let i = 1; i <= 16; i++) {
    const consumed = consumeSkillAmmo(work, 1, i, f.resources);
    assert.equal(consumed.result.amount, 2);
  }
  assert.equal(getUnit(work, 1).skill.active, null);
});

test("the final shot is sampled with its buff before consumption and its projectile keeps that released sample", () => {
  const f = ammoFixture(1);
  const shell = f.resources.projectiles.register(createProjectileProgram({
    id: "ammo-cached-shell", initialize: () => ({}), ownState: (state) => state,
    acceptsContact: (_context, target) => target.id === 2,
    contact: (context) => { context.operations.damage({ sourceUnitId: 1, targetUnitId: 2, tick: context.tick, damageType: "TRUE", operands: createDamageOperands(context.projectile.cachedAtk) }); },
  }));
  const attackPower = resolveAttackPower(1, battlefieldView(f.work), f.resources.computations);
  assert.equal(attackPower, 200);
  const launched = withProjectileOperations({ projectileIds: [], getProjectile: () => undefined }, f.work.execution.nextProjectileId, f.resources.projectiles, 0, (operations) => operations.launch(shell.ref, {
    source: 1, traceTarget: 2, position: [0, 0], destination: [1, 0], cachedAtk: attackPower,
    speedPerTick: 1, contactRange: { type: "SHAPES", geometry: { shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.2 }] } }, stopDelayTicks: 0,
  }));
  f.work.execution = { ...f.work.execution, nextProjectileId: launched.nextProjectileId };
  consumeSkillAmmo(f.work, 1, 0, f.resources);
  assert.equal(resolveAttackPower(1, battlefieldView(f.work), f.resources.computations), 100);
  const projectile = launched.changes.find((change) => change.type === "REGISTER_PROJECTILE").projectile;
  assert.equal(projectile.cachedAtk, 200);
  advanceBattlefield(f.work, launched.changes);
  advanceProjectiles(f.work, f.resources, 1);
  assert.equal(getUnit(f.work, 2).vitality.hp, 800);
});
