import assert from "node:assert/strict";
import { test } from "node:test";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { getUnit, updateUnit } from "../../dist/core/tactical/battle/execution/context.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { effectTick } from "../../dist/core/tactical/unit/capability/effects/instance.js";
import { expireEffects, finishEffects } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { createSkillDefinition, createSkillState, initializeSkillState } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { activateSkill, advanceSkill, finishSkill } from "../../dist/core/tactical/unit/capability/skill/execution.js";
import { drainSkillSp, gainSkillSp, spendSkillSp } from "../../dist/core/tactical/unit/capability/skill/sp.js";
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
  const unit = getUnit(work, 1);
  const gained = gainSkillSp(unit.skill, definition, "EXTERNAL", amount);
  updateUnit(work, { ...unit, skill: gained.state });
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
  let work = f.work;
  advanceSkill(work, 1, 15, f.resources);
  assert.equal(getUnit(work, 1).skill.sp, 0);
  assert.equal(getUnit(work, 1).skill.spRecoveryProgressTicks, 15);
  setSp(work, f.definition, 2);
  advanceSkill(work, 1, 100, f.resources);
  assert.equal(getUnit(work, 1).skill.spRecoveryProgressTicks, 15);
  const full = getUnit(work, 1);
  updateUnit(work, { ...full, skill: spendSkillSp(full.skill, f.definition).state });
  advanceSkill(work, 1, 114, f.resources);
  assert.equal(getUnit(work, 1).skill.sp, 0);
  advanceSkill(work, 1, 115, f.resources);
  assert.equal(getUnit(work, 1).skill.sp, 1);
  assert.equal(getUnit(work, 1).skill.spRecoveryProgressTicks, 0);
});

test("active duration locks all SP sources and resumes the preserved clock after ending", () => {
  const f = fixture({ initialSp: 0, spCost: 1 });
  let work = f.work;
  advanceSkill(work, 1, 15, f.resources);
  setSp(work, f.definition, 1);
  const started = activateSkill(work, { unitId: 1, tick: 15 }, f.resources);
  assert.equal(started.result.type, "ACTIVATED");
  const active = getUnit(work, 1).skill;
  for (const source of ["TIME", "ATTACK", "HIT", "EXTERNAL"]) {
    assert.equal(gainSkillSp(active, f.definition, source).result.reason, "LOCKED");
  }
  advanceSkill(work, 1, 44, f.resources);
  assert.equal(getUnit(work, 1).skill.spRecoveryProgressTicks, 15);
  const ended = advanceSkill(work, 1, 45, f.resources);
  assert.equal(ended.signals[0].type, "SKILL_FINISHED");
  assert.equal(getUnit(work, 1).skill.active, null);
  advanceSkill(work, 1, 60, f.resources);
  assert.equal(getUnit(work, 1).skill.sp, 1);
});

test("manual activation returns normal refusal for insufficient SP, wrong trigger and content conditions", () => {
  const f = fixture({ initialSp: 0 });
  assert.equal(activateSkill(f.work, { unitId: 1, tick: 0 }, f.resources).result.reason, "INSUFFICIENT_SP");
  assert.equal(activateSkill(f.work, { unitId: 1, tick: 0, trigger: "AUTO" }, f.resources).result.reason, "WRONG_TRIGGER");
  const refused = fixture({}, { accepts: () => false, activate: () => assert.fail("must not run") });
  const result = activateSkill(refused.work, { unitId: 1, tick: 0 }, refused.resources);
  assert.equal(result.result.reason, "CONDITION");
  assert.equal(getUnit(refused.work, 1).skill.nextActivationId, 0);
});

test("instant AUTO activation happens once per advancement tick and spends one stored charge", () => {
  const f = fixture({ activation: "AUTO", durationTicks: 0, spCost: 1, initialSp: 2, maxCharges: 2 });
  const first = advanceSkill(f.work, 1, 0, f.resources);
  assert.deepEqual(first.signals.map((signal) => signal.type), ["SKILL_ACTIVATED", "SKILL_FINISHED"]);
  assert.equal(getUnit(f.work, 1).skill.sp, 1);
  const repeated = advanceSkill(f.work, 1, 0, f.resources);
  assert.equal(repeated.signals.length, 0);
  assert.equal(getUnit(f.work, 1).skill.nextActivationId, 1);
  const next = advanceSkill(f.work, 1, 1, f.resources);
  assert.equal(next.result.type, "ACTIVATED");
  assert.equal(getUnit(f.work, 1).skill.sp, 0);
});

test("a passive skill activates once and an unlimited skill ends only explicitly", () => {
  const passive = fixture({ activation: "PASSIVE", spRecovery: "NONE", spCost: 0, initialSp: 0, durationTicks: 0 });
  advanceSkill(passive.work, 1, 0, passive.resources);
  const later = advanceSkill(passive.work, 1, 30, passive.resources);
  assert.equal(later.signals.length, 0);
  assert.equal(getUnit(passive.work, 1).skill.nextActivationId, 1);
  const unlimited = fixture({ durationTicks: null });
  activateSkill(unlimited.work, { unitId: 1, tick: 0 }, unlimited.resources);
  advanceSkill(unlimited.work, 1, 1000, unlimited.resources);
  assert.equal(getUnit(unlimited.work, 1).skill.active.endsAtTick, null);
  assert.equal(finishSkill(unlimited.work, 1, 1000, unlimited.resources).result.type, "FINISHED");
});

test("content refusal retains effect prefix and allocated identities while refunding SP", () => {
  let ref;
  const f = fixture({}, {
    activate: (context) => {
      assert.equal(context.effects.install(context.unitId, ref, { source: 1, scopes: [] }).type, "INSTALLED");
      return { type: "REJECTED", reason: "later prerequisite unavailable" };
    },
  });
  ref = f.resources.registerEffect(createEffectProgram({ id: "skill-rejected-prefix", initialize: () => ({}) })).ref;
  const rejected = activateSkill(f.work, { unitId: 1, tick: 0 }, f.resources);
  assert.equal(rejected.result.reason, "CONTENT_REJECTED");
  const unit = getUnit(f.work, 1);
  assert.equal(unit.effects.instances.length, 1);
  assert.equal(unit.effects.nextInstanceId, 1);
  assert.equal(unit.skill.sp, 2);
  assert.equal(unit.skill.nextActivationId, 1);
  assert.equal(unit.skill.active, null);
});

test("content refusal closes activation scopes while independent effects survive", () => {
  let ref;
  const f = fixture({}, {
    activate: (context) => {
      for (const scopes of [
        [{ type: "SKILL", unitId: context.unitId, activationId: context.activationId }],
        [],
      ]) {
        assert.equal(context.effects.install(context.unitId, ref, { source: 1, scopes }).type, "INSTALLED");
      }
      return { type: "REJECTED", reason: "content prerequisite" };
    },
  });
  ref = f.resources.registerEffect(createEffectProgram({
    id: "activation-refusal-scopes", initialize: () => ({}),
  })).ref;
  const refused = activateSkill(f.work, { unitId: 1, tick: 0 }, f.resources);
  const unit = getUnit(f.work, 1);
  assert.equal(refused.result.type, "REJECTED");
  assert.equal(unit.skill.active, null);
  assert.equal(unit.skill.sp, 2);
  assert.deepEqual(unit.effects.instances.map(({ finished, participating }) => ({ finished, participating })), [
    { finished: true, participating: false },
    { finished: false, participating: true },
  ]);
});

test("zero-duration activation closes its scope before skill finish content", () => {
  let ref;
  const observed = [];
  const f = fixture({ durationTicks: 0 }, {
    activate: (context) => {
      assert.equal(context.effects.install(context.unitId, ref, {
        source: context.unitId,
        scopes: [{ type: "SKILL", unitId: context.unitId, activationId: context.activationId }],
      }).type, "INSTALLED");
      return { type: "ACTIVATED" };
    },
    finish: (context) => {
      const instance = context.facts.getUnit(context.unitId).effects.instances[0];
      observed.push({ active: context.facts.getUnit(context.unitId).skill.active, finished: instance.finished });
      assert.equal(context.effects.install(context.unitId, ref, {
        source: context.unitId,
        scopes: [{ type: "SKILL", unitId: context.unitId, activationId: context.activationId }],
      }).type, "REJECTED");
    },
  });
  ref = f.resources.registerEffect(createEffectProgram({
    id: "zero-duration-scope", initialize: () => ({}),
  })).ref;
  const activated = activateSkill(f.work, { unitId: 1, tick: 0 }, f.resources);
  assert.deepEqual(activated.signals.map(({ type }) => type), ["SKILL_ACTIVATED", "SKILL_FINISHED"]);
  assert.deepEqual(observed, [{ active: null, finished: true }]);
  assert.equal(getUnit(f.work, 1).effects.nextInstanceId, 1);
});

test("skill finish rejects binding a surviving independent effect to its closed activation", () => {
  let program;
  let independent;
  const f = fixture({}, {
    activate: (context) => {
      const installed = context.effects.install(context.unitId, program, { source: 1, scopes: [] });
      assert.equal(installed.type, "INSTALLED");
      independent = installed.ref;
      return { type: "ACTIVATED" };
    },
    finish: (context) => {
      assert.equal(context.effects.bind(independent, {
        type: "SKILL", unitId: context.unitId, activationId: context.activationId,
      }).type, "LIFETIME_UNAVAILABLE");
    },
  });
  program = f.resources.registerEffect(createEffectProgram({
    id: "independent-skill-binding", initialize: () => ({}),
  })).ref;
  activateSkill(f.work, { unitId: 1, tick: 0 }, f.resources);
  finishSkill(f.work, 1, 30, f.resources);
  const instance = getUnit(f.work, 1).effects.instances[0];
  assert.deepEqual(instance.scopes, []);
  assert.equal(instance.finished, false);
  assert.equal(instance.participating, true);
});

for (const trigger of ["SKILL", "EFFECT", "TICK"]) {
  test(`combined scopes: renewal preserves Skill and Effect constraints until ${trigger} closes`, () => {
    let parent;
    let dependent;
    let parentRef;
    let dependentRef;
    const ended = [];
    let expirations = 0;
    const f = fixture({}, {
      activate: (context) => {
        const installedParent = context.effects.install(context.unitId, parent, { source: 1, scopes: [] });
        assert.equal(installedParent.type, "INSTALLED");
        parentRef = installedParent.ref;
        const installedDependent = context.effects.install(context.unitId, dependent, {
          source: 1,
          scopes: [
            { type: "SKILL", unitId: context.unitId, activationId: context.activationId },
            parentRef,
            { type: "TICK", tick: 5 },
          ],
        });
        assert.equal(installedDependent.type, "INSTALLED");
        dependentRef = installedDependent.ref;
        return { type: "ACTIVATED" };
      },
    });
    parent = f.resources.registerEffect(createEffectProgram({
      id: `combined-parent-${trigger}`, initialize: () => ({}),
    })).ref;
    dependent = f.resources.registerEffect(createEffectProgram({
      id: `combined-dependent-${trigger}`, initialize: () => ({}),
    }), {
      lifecycle: {
        expire: (context) => {
          expirations++;
          if (expirations === 1) context.effects.setTick(context.ref, 10);
          else context.effects.finish([context.ref], "EXPIRED");
        },
        finish: (context) => { ended.push(context.end); },
      },
    }).ref;
    let work = f.work;
    activateSkill(work, { unitId: 1, tick: 0 }, f.resources);
    expireEffects(work, 5, f.resources);
    const renewed = getUnit(work, 1).effects.instances.find(({ id }) => id === dependentRef.effectId);
    assert.equal(renewed.finished, false);
    assert.equal(effectTick(renewed), 10);
    assert.deepEqual(renewed.scopes.filter(({ type }) => type !== "TICK"), [
      { type: "SKILL", unitId: 1, activationId: 0 }, parentRef,
    ]);

    if (trigger === "SKILL") finishSkill(work, 1, 6, f.resources);
    else if (trigger === "EFFECT") finishEffects(work, [parentRef], f.resources, 6, "DISPELLED");
    else expireEffects(work, 10, f.resources);

    const unit = getUnit(work, 1);
    assert.equal(unit.effects.instances.find(({ id }) => id === dependentRef.effectId).finished, true);
    assert.equal(unit.skill.active === null, trigger === "SKILL");
    assert.equal(unit.effects.instances.find(({ id }) => id === parentRef.effectId).finished, trigger === "EFFECT");
    assert.deepEqual(ended, [{
      root: trigger === "SKILL" ? { type: "SKILL", unitId: 1, activationId: 0 }
        : trigger === "EFFECT" ? parentRef : dependentRef,
      reason: trigger === "SKILL" ? "SKILL_FINISHED" : trigger === "EFFECT" ? "DISPELLED" : "EXPIRED",
    }]);
    expireEffects(work, 100, f.resources);
    assert.equal(ended.length, 1);
  });
}

test("callback errors propagate and escaped skill ports are closed even after errors", () => {
  let captured;
  const failure = new Error("content failed");
  const f = fixture({}, { activate: (context) => { captured = context; throw failure; } });
  assert.throws(() => activateSkill(f.work, { unitId: 1, tick: 0 }, f.resources), (error) => error === failure);
  assert.throws(() => captured.facts.getUnit(1), /no longer active/);
  assert.throws(() => captured.effects.finish([{ type: "EFFECT", unitId: 1, effectId: 0 }]), /no longer active/);
  assert.throws(() => captured.damage({ sourceUnitId: 1, targetUnitId: 1, damageType: "TRUE", operands: { power: 1 } }), /no longer active/);
  assert.throws(() => captured.heal({ sourceUnitId: 1, targetUnitId: 1, power: 1, ignoreHealFree: false }), /no longer active/);
  assert.equal(f.work.battlefield.snapshot("state").getUnit(1).skill.sp, 2);
  assert.equal(f.work.battlefield.snapshot("state").getUnit(1).skill.active, null);
  f.work.battlefield.drop();
});

test("a dead unit cannot activate or accumulate time SP before retirement", () => {
  const f = fixture({ initialSp: 0 });
  const unit = initializeUnit({ id: 1, position: [0, 0], definition: { id: "dead-skilled", skill: f.definition, vitality: { maxHp: 100 } } });
  const dead = { ...unit, vitality: { ...unit.vitality, hp: 0 } };
  const work = effectFixtureWork(dead);
  assert.equal(activateSkill(work, { unitId: 1, tick: 0 }, f.resources).result.reason, "UNAVAILABLE");
  advanceSkill(work, 1, 300, f.resources);
  assert.equal(getUnit(work, 1).skill.sp, 0);
});

test("external SP drain can remove retained charges during a skill while activation spending remains locked", () => {
  const f = fixture({ spCost: 2, initialSp: 4, maxCharges: 2 });
  activateSkill(f.work, { unitId: 1, tick: 0 }, f.resources);
  const state = getUnit(f.work, 1).skill;
  assert.equal(state.sp, 2);
  assert.equal(spendSkillSp(state, f.definition, 1).result.reason, "LOCKED");
  const drained = drainSkillSp(state, 5);
  assert.deepEqual(drained.result, { type: "APPLIED", amount: 2 });
  assert.equal(drained.state.sp, 0);
  assert.equal(drained.state.active, state.active);
  assert.equal(state.sp, 2);
  assert.deepEqual(drainSkillSp(drained.state, 5).result, { type: "APPLIED", amount: 0 });
  assert.equal(drainSkillSp(drained.state, 0).state, drained.state);
  assert.throws(() => drainSkillSp(state, 0.5), /integer/);
});

test("skill ending clears active state before finish content observes it", () => {
  let observed;
  const f = fixture({}, { finish: (context) => { observed = context.facts.getUnit(1).skill.active; } });
  activateSkill(f.work, { unitId: 1, tick: 0 }, f.resources);
  finishSkill(f.work, 1, 30, f.resources);
  assert.equal(observed, null);
  assert.equal(finishSkill(f.work, 1, 30, f.resources).result.type, "ABSENT");
});

test("SP recovery blockade pauses the clock without saving blocked time and stun or silence refuses activation", () => {
  const f = fixture({ initialSp: 0 });
  const blocked = initializeUnit({
    id: 1, position: [0, 0],
    definition: { id: "sp-blocked", skill: f.definition, status: { initialFlags: ["SP_RECOVERY_BLOCKED"] } },
  });
  const work = effectFixtureWork(blocked);
  advanceSkill(work, 1, 60, f.resources);
  assert.equal(getUnit(work, 1).skill.sp, 0);
  assert.equal(getUnit(work, 1).skill.spRecoveryProgressTicks, 0);
  const current = getUnit(work, 1);
  updateUnit(work, { ...current, status: { contributions: [] } });
  advanceSkill(work, 1, 89, f.resources);
  assert.equal(getUnit(work, 1).skill.sp, 0);
  advanceSkill(work, 1, 90, f.resources);
  assert.equal(getUnit(work, 1).skill.sp, 1);
  for (const flag of ["STUNNED", "SILENCED"]) {
    const controlled = initializeUnit({ id: 1, position: [0, 0], definition: { id: flag, skill: f.definition, status: { initialFlags: [flag] } } });
    assert.equal(activateSkill(effectFixtureWork(controlled), { unitId: 1, tick: 0 }, f.resources).result.reason, "UNAVAILABLE");
  }
});
