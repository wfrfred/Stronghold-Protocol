import assert from "node:assert/strict";
import { test } from "node:test";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { getCombatUnit, updateCombatUnit } from "../../dist/core/tactical/battle/execution/work.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { createSkillDefinition, createSkillState, initializeSkillState } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { activateSkill, advanceSkill, finishSkill } from "../../dist/core/tactical/unit/capability/skill/execution.js";
import { gainSkillSp, spendSkillSp } from "../../dist/core/tactical/unit/capability/skill/sp.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { effectFixtureWork } from "../helpers/effects.js";

function fixture(options = {}, content = {}) {
  const resources = new CombatResources();
  const definition = createSkillDefinition({
    id: "skill-domain-fixture",
    activation: "MANUAL",
    spRecovery: "TIME",
    spCost: 2,
    initialSp: 2,
    durationTicks: 30,
    ...options,
  });
  resources.skills.register({ definition, activate: () => ({ type: "ACTIVATED" }), ...content });
  const unit = initializeUnit({ id: 1, position: [0, 0], definition: { id: "skilled-unit", skill: definition } });
  return { resources, definition, unit, work: effectFixtureWork(unit) };
}

function setSp(work, definition, amount) {
  const unit = getCombatUnit(work, 1);
  const gained = gainSkillSp(unit.skill, definition, "EXTERNAL", amount);
  return updateCombatUnit(work, { ...unit, skill: gained.state });
}

test("skill definitions retain owned identity through unit initialization and initial SP is deployment-only", () => {
  const f = fixture({ initialSp: 1, maxCharges: 2 });
  assert.equal(f.unit.definition.skill, f.definition);
  assert.equal(createSkillDefinition(f.definition), f.definition);
  assert.equal(initializeSkillState(f.definition, { tick: 90 }).sp, 1);
  assert.equal(initializeSkillState(f.definition, { tick: 90 }).lastAdvancedTick, 90);
  const spent = spendSkillSp(f.unit.skill, f.definition, 1);
  assert.equal(spent.state.sp, 0);
  assert.throws(() => createSkillDefinition({ ...f.definition, initialSp: 5 }), /capacity/);
  assert.throws(() => createSkillState({ ...f.unit.skill, sp: 0.5 }), /integer/);
});

for (const source of ["TIME", "ATTACK", "HIT"]) {
  test(`${source} SP recovery accepts only its base source and preserves charge capacity`, () => {
    const f = fixture({ spRecovery: source, spCost: 3, initialSp: 0, maxCharges: 2 });
    let state = gainSkillSp(f.unit.skill, f.definition, source, 5).state;
    assert.equal(state.sp, 5);
    const capped = gainSkillSp(state, f.definition, source, 10);
    assert.deepEqual(capped.result, { type: "APPLIED", amount: 1 });
    assert.equal(capped.state.sp, 6);
    assert.equal(gainSkillSp(capped.state, f.definition, source).result.reason, "FULL");
    const other = source === "ATTACK" ? "HIT" : "ATTACK";
    assert.equal(gainSkillSp(state, f.definition, other).result.reason, "WRONG_SOURCE");
    assert.equal(spendSkillSp(state, f.definition).state.sp, 2);
    assert.equal(spendSkillSp({ ...state, sp: 2 }, f.definition).result.reason, "INSUFFICIENT_SP");
    assert.throws(() => gainSkillSp(state, f.definition, source, 0.5), /integer/);
  });
}

test("automatic SP is integer-valued and its partial clock pauses while full", () => {
  const f = fixture({ initialSp: 0 });
  let work = advanceSkill(f.work, 1, 15, f.resources).work;
  assert.equal(getCombatUnit(work, 1).skill.sp, 0);
  assert.equal(getCombatUnit(work, 1).skill.spRecoveryProgressTicks, 15);
  work = setSp(work, f.definition, 2);
  work = advanceSkill(work, 1, 100, f.resources).work;
  assert.equal(getCombatUnit(work, 1).skill.spRecoveryProgressTicks, 15);
  const full = getCombatUnit(work, 1);
  work = updateCombatUnit(work, { ...full, skill: spendSkillSp(full.skill, f.definition).state });
  work = advanceSkill(work, 1, 114, f.resources).work;
  assert.equal(getCombatUnit(work, 1).skill.sp, 0);
  work = advanceSkill(work, 1, 115, f.resources).work;
  assert.equal(getCombatUnit(work, 1).skill.sp, 1);
  assert.equal(getCombatUnit(work, 1).skill.spRecoveryProgressTicks, 0);
});

test("active duration locks all SP sources and resumes the preserved clock after ending", () => {
  const f = fixture({ initialSp: 0, spCost: 1 });
  let work = advanceSkill(f.work, 1, 15, f.resources).work;
  work = setSp(work, f.definition, 1);
  const started = activateSkill(work, { unitId: 1, tick: 15 }, f.resources);
  assert.equal(started.result.type, "ACTIVATED");
  const active = getCombatUnit(started.work, 1).skill;
  for (const source of ["TIME", "ATTACK", "HIT", "EXTERNAL"]) {
    assert.equal(gainSkillSp(active, f.definition, source).result.reason, "LOCKED");
  }
  work = advanceSkill(started.work, 1, 44, f.resources).work;
  assert.equal(getCombatUnit(work, 1).skill.spRecoveryProgressTicks, 15);
  const ended = advanceSkill(work, 1, 45, f.resources);
  assert.equal(ended.signals[0].type, "SKILL_FINISHED");
  assert.equal(getCombatUnit(ended.work, 1).skill.active, null);
  work = advanceSkill(ended.work, 1, 60, f.resources).work;
  assert.equal(getCombatUnit(work, 1).skill.sp, 1);
});

test("manual activation returns normal refusal for insufficient SP, wrong trigger and content conditions", () => {
  const f = fixture({ initialSp: 0 });
  assert.equal(activateSkill(f.work, { unitId: 1, tick: 0 }, f.resources).result.reason, "INSUFFICIENT_SP");
  assert.equal(activateSkill(f.work, { unitId: 1, tick: 0, trigger: "AUTO" }, f.resources).result.reason, "WRONG_TRIGGER");
  const refused = fixture({}, { accepts: () => false, activate: () => assert.fail("must not run") });
  const result = activateSkill(refused.work, { unitId: 1, tick: 0 }, refused.resources);
  assert.equal(result.result.reason, "CONDITION");
  assert.equal(result.work, refused.work);
  assert.equal(getCombatUnit(result.work, 1).skill.nextActivationId, 0);
});

test("instant AUTO activation happens once per advancement tick and spends one stored charge", () => {
  const f = fixture({ activation: "AUTO", durationTicks: 0, spCost: 1, initialSp: 2, maxCharges: 2 });
  const first = advanceSkill(f.work, 1, 0, f.resources);
  assert.deepEqual(first.signals.map((signal) => signal.type), ["SKILL_ACTIVATED", "SKILL_FINISHED"]);
  assert.equal(getCombatUnit(first.work, 1).skill.sp, 1);
  const repeated = advanceSkill(first.work, 1, 0, f.resources);
  assert.equal(repeated.signals.length, 0);
  assert.equal(getCombatUnit(repeated.work, 1).skill.nextActivationId, 1);
  const next = advanceSkill(repeated.work, 1, 1, f.resources);
  assert.equal(next.result.type, "ACTIVATED");
  assert.equal(getCombatUnit(next.work, 1).skill.sp, 0);
});

test("a passive skill activates once and an unlimited skill ends only explicitly", () => {
  const passive = fixture({ activation: "PASSIVE", spRecovery: "NONE", spCost: 0, initialSp: 0, durationTicks: 0 });
  const started = advanceSkill(passive.work, 1, 0, passive.resources);
  const later = advanceSkill(started.work, 1, 30, passive.resources);
  assert.equal(later.signals.length, 0);
  assert.equal(getCombatUnit(later.work, 1).skill.nextActivationId, 1);
  const unlimited = fixture({ durationTicks: null });
  const infinite = activateSkill(unlimited.work, { unitId: 1, tick: 0 }, unlimited.resources);
  const advanced = advanceSkill(infinite.work, 1, 1000, unlimited.resources);
  assert.equal(getCombatUnit(advanced.work, 1).skill.active.endsAtTick, null);
  assert.equal(finishSkill(advanced.work, 1, 1000, unlimited.resources).result.type, "FINISHED");
});

test("content refusal retains effect prefix and allocated identities while refunding SP", () => {
  let ref;
  const f = fixture({}, {
    activate: (context) => {
      assert.equal(context.effects.install(context.unitId, ref, { source: 1, scope: null, expiresAtTick: null }).type, "INSTALLED");
      return { type: "REJECTED", reason: "later prerequisite unavailable" };
    },
  });
  ref = f.resources.registerEffect(createEffectProgram({ id: "skill-rejected-prefix", initialize: () => ({}), ownState: (value) => value })).ref;
  const rejected = activateSkill(f.work, { unitId: 1, tick: 0 }, f.resources);
  assert.equal(rejected.result.reason, "CONTENT_REJECTED");
  const unit = getCombatUnit(rejected.work, 1);
  assert.equal(unit.effects.instances.length, 1);
  assert.equal(unit.effects.nextInstanceId, 1);
  assert.equal(unit.skill.sp, 2);
  assert.equal(unit.skill.nextActivationId, 1);
  assert.equal(unit.skill.active, null);
});

test("callback errors propagate and escaped skill ports are closed even after errors", () => {
  let captured;
  const failure = new Error("content failed");
  const f = fixture({}, { activate: (context) => { captured = context; throw failure; } });
  assert.throws(() => activateSkill(f.work, { unitId: 1, tick: 0 }, f.resources), (error) => error === failure);
  assert.throws(() => captured.facts.getUnit(1), /no longer active/);
  assert.throws(() => captured.effects.finish({ unitId: 1, instanceId: 0 }), /no longer active/);
  assert.throws(() => captured.damage({ sourceUnitId: 1, targetUnitId: 1, damageType: "TRUE", operands: { power: 1 } }), /no longer active/);
  assert.throws(() => captured.heal({ sourceUnitId: 1, targetUnitId: 1, power: 1, ignoreHealFree: false }), /no longer active/);
  assert.equal(getCombatUnit(f.work, 1).skill.sp, 2);
  assert.equal(getCombatUnit(f.work, 1).skill.active, null);
});

test("a dead unit cannot activate or accumulate time SP before retirement", () => {
  const f = fixture({ initialSp: 0 });
  const unit = initializeUnit({ id: 1, position: [0, 0], definition: { id: "dead-skilled", skill: f.definition, vitality: { maxHp: 100 } } });
  const dead = { ...unit, vitality: { ...unit.vitality, hp: 0 } };
  const work = effectFixtureWork(dead);
  assert.equal(activateSkill(work, { unitId: 1, tick: 0 }, f.resources).result.reason, "UNAVAILABLE");
  assert.equal(getCombatUnit(advanceSkill(work, 1, 300, f.resources).work, 1).skill.sp, 0);
});

test("skill ending clears active state before finish content observes it", () => {
  let observed;
  const f = fixture({}, { finish: (context) => { observed = context.facts.getUnit(1).skill.active; } });
  const active = activateSkill(f.work, { unitId: 1, tick: 0 }, f.resources);
  const finished = finishSkill(active.work, 1, 30, f.resources);
  assert.equal(observed, null);
  assert.equal(finishSkill(finished.work, 1, 30, f.resources).result.type, "ABSENT");
});

test("SP recovery blockade pauses the clock without saving blocked time and stun or silence refuses activation", () => {
  const f = fixture({ initialSp: 0 });
  const blocked = initializeUnit({
    id: 1, position: [0, 0],
    definition: { id: "sp-blocked", skill: f.definition, status: { initialFlags: ["SP_RECOVERY_BLOCKED"] } },
  });
  let work = advanceSkill(effectFixtureWork(blocked), 1, 60, f.resources).work;
  assert.equal(getCombatUnit(work, 1).skill.sp, 0);
  assert.equal(getCombatUnit(work, 1).skill.spRecoveryProgressTicks, 0);
  const current = getCombatUnit(work, 1);
  work = updateCombatUnit(work, { ...current, status: { contributions: [] } });
  work = advanceSkill(work, 1, 89, f.resources).work;
  assert.equal(getCombatUnit(work, 1).skill.sp, 0);
  work = advanceSkill(work, 1, 90, f.resources).work;
  assert.equal(getCombatUnit(work, 1).skill.sp, 1);
  for (const flag of ["STUNNED", "SILENCED"]) {
    const controlled = initializeUnit({ id: 1, position: [0, 0], definition: { id: flag, skill: f.definition, status: { initialFlags: [flag] } } });
    assert.equal(activateSkill(effectFixtureWork(controlled), { unitId: 1, tick: 0 }, f.resources).result.reason, "UNAVAILABLE");
  }
});
