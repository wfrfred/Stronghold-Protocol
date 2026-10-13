import assert from "node:assert/strict";
import { test } from "node:test";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { battlefieldView, getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { definition as effectDefinition, effectFixtureWork } from "../helpers/effects.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { deadline, setDeadline, setData } from "../../dist/core/tactical/unit/effect/effect.js";
import { get } from "../../dist/core/tactical/unit/effect/operations.js";
import { createSkillDefinition, validateSkillState, initializeSkillState } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { activateSkill, advanceSkill, finishSkill } from "../../dist/core/tactical/unit/capability/skill/execution.js";
import { drainSkillSp, gainSkillSp, spendSkillSp } from "../../dist/core/tactical/unit/capability/skill/sp.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";

function fixture(options = {}, content = {}) {
  const resources = new CombatResources();
  const definition = createSkillDefinition({ id: "skill-domain-fixture", activation: "MANUAL", spRecovery: "TIME", spCost: 2, initialSp: 2, durationTicks: 30, ...options });
  resources.skills.register({ definition, activate: state => ({ state, value: { type: "ACTIVATED" } }), ...content });
  const unit = initialize({ id: 1, position: [0, 0], definition: { id: "skilled-unit", skill: definition } });
  return { resources, definition, unit, state: effectFixtureWork(unit) };
}
function setSp(state, definition, amount) {
  const unit = getUnit(state, 1);
  return updateUnit(state, { ...unit, skill: gainSkillSp(unit.skill, definition, "EXTERNAL", amount).state });
}

test("skill definitions retain identity and initial SP is deployment-only", () => {
  const f = fixture({ initialSp: 1, maxCharges: 2 });
  assert.equal(f.unit.definition.skill, f.definition);
  assert.equal(createSkillDefinition(f.definition), f.definition);
  assert.equal(initializeSkillState(f.definition, { tick: 90 }).sp, 1);
  assert.equal(initializeSkillState(f.definition, { tick: 90 }).lastAdvancedTick, 90);
  assert.equal(spendSkillSp(f.unit.skill, f.definition, 1).state.sp, 0);
  assert.throws(() => createSkillDefinition({ ...f.definition, initialSp: 5 }), /capacity/);
  assert.equal(validateSkillState(f.unit.skill), undefined);
  assert.throws(() => validateSkillState({ ...f.unit.skill, sp: 0.5 }), /integer/);
  assert.throws(() => initializeSkillState({ ...f.definition, initialSp: 0.5 }), /integer/);
});
for (const source of ["TIME", "ATTACK", "HIT"]) {
  test(`${source} SP accepts its base source and preserves charge capacity`, () => {
    const f = fixture({ spRecovery: source, spCost: 3, initialSp: 0, maxCharges: 2 });
    const gained = gainSkillSp(f.unit.skill, f.definition, source, 5);
    const capped = gainSkillSp(gained.state, f.definition, source, 10);
    assert.equal(gained.state.sp, 5);
    assert.deepEqual(capped.result, { type: "APPLIED", amount: 1 });
    assert.equal(capped.state.sp, 6);
    assert.equal(gainSkillSp(capped.state, f.definition, source).result.reason, "FULL");
    assert.equal(gainSkillSp(gained.state, f.definition, source === "ATTACK" ? "HIT" : "ATTACK").result.reason, "WRONG_SOURCE");
    assert.equal(spendSkillSp(gained.state, f.definition).state.sp, 2);
    assert.equal(spendSkillSp({ ...gained.state, sp: 2 }, f.definition).result.reason, "INSUFFICIENT_SP");
    assert.throws(() => gainSkillSp(gained.state, f.definition, source, 0.5), /integer/);
  });
}

test("time SP preserves partial progress while full and returns a new state", () => {
  const f = fixture({ initialSp: 0 });
  const before = battlefieldView(f.state);
  let state = advanceSkill(f.state, 1, 15, f.resources);
  assert.equal(getUnit(state, 1).skill.spRecoveryProgressTicks, 15);
  state = setSp(state, f.definition, 2);
  state = advanceSkill(state, 1, 100, f.resources);
  assert.equal(getUnit(state, 1).skill.spRecoveryProgressTicks, 15);
  const full = getUnit(state, 1);
  state = updateUnit(state, { ...full, skill: spendSkillSp(full.skill, f.definition).state });
  state = advanceSkill(state, 1, 114, f.resources);
  assert.equal(getUnit(state, 1).skill.sp, 0);
  state = advanceSkill(state, 1, 115, f.resources);
  assert.equal(getUnit(state, 1).skill.sp, 1);
  assert.equal(getUnit(state, 1).skill.spRecoveryProgressTicks, 0);
  assert.equal(before.getUnit(1).skill.spRecoveryProgressTicks, 0);
});

test("active duration locks every SP source and resumes its preserved clock", () => {
  const f = fixture({ initialSp: 0, spCost: 1 });
  let state = advanceSkill(f.state, 1, 15, f.resources);
  state = setSp(state, f.definition, 1);
  const started = activateSkill(state, { unitId: 1, tick: 15 }, f.resources);
  state = started.state;
  assert.equal(started.value.type, "ACTIVATED");
  for (const source of ["TIME", "ATTACK", "HIT", "EXTERNAL"]) assert.equal(gainSkillSp(getUnit(state, 1).skill, f.definition, source).result.reason, "LOCKED");
  state = advanceSkill(state, 1, 44, f.resources);
  assert.equal(getUnit(state, 1).skill.spRecoveryProgressTicks, 15);
  const ended = advanceSkill(state, 1, 45, f.resources);
  state = ended;
  assert.equal(ended.events.at(-1).type, "SKILL_FINISHED");
  assert.equal(getUnit(state, 1).skill.active, null);
  state = advanceSkill(state, 1, 60, f.resources);
  assert.equal(getUnit(state, 1).skill.sp, 1);
});

test("normal refusals preserve the input version and allocate no activation", () => {
  const f = fixture({ initialSp: 0 });
  assert.equal(activateSkill(f.state, { unitId: 1, tick: 0 }, f.resources).value.reason, "INSUFFICIENT_SP");
  assert.equal(activateSkill(f.state, { unitId: 1, tick: 0, trigger: "AUTO" }, f.resources).value.reason, "WRONG_TRIGGER");
  const refused = fixture({}, { accepts: () => false, activate: () => assert.fail("must not run") });
  const result = activateSkill(refused.state, { unitId: 1, tick: 0 }, refused.resources);
  assert.equal(result.value.reason, "CONDITION");
  assert.equal(result.state, refused.state);
  assert.equal(getUnit(result.state, 1).skill.nextActivationId, 0);
});

test("instant AUTO activation occurs once per advancement tick", () => {
  const f = fixture({ activation: "AUTO", durationTicks: 0, spCost: 1, initialSp: 2, maxCharges: 2 });
  const first = advanceSkill(f.state, 1, 0, f.resources);
  assert.deepEqual(first.events.map(event => event.type), ["SKILL_ACTIVATED", "SKILL_FINISHED"]);
  assert.equal(getUnit(first, 1).skill.sp, 1);
  const repeated = advanceSkill(first, 1, 0, f.resources);
  assert.equal(repeated.events.length, first.events.length);
  assert.equal(getUnit(repeated, 1).skill.nextActivationId, 1);
  const next = advanceSkill(repeated, 1, 1, f.resources);
  assert.equal(next.events.at(-2).type, "SKILL_ACTIVATED");
  assert.equal(getUnit(next, 1).skill.sp, 0);
  assert.equal(getUnit(f.state, 1).skill.sp, 2);
});

test("passive skills activate once; unlimited skills require explicit ending", () => {
  const passive = fixture({ activation: "PASSIVE", spRecovery: "NONE", spCost: 0, initialSp: 0, durationTicks: 0 });
  const first = advanceSkill(passive.state, 1, 0, passive.resources);
  const later = advanceSkill(first, 1, 30, passive.resources);
  assert.equal(later.events.length, first.events.length);
  assert.equal(getUnit(later, 1).skill.nextActivationId, 1);
  const unlimited = fixture({ durationTicks: null });
  let state = activateSkill(unlimited.state, { unitId: 1, tick: 0 }, unlimited.resources).state;
  state = advanceSkill(state, 1, 1000, unlimited.resources);
  assert.equal(getUnit(state, 1).skill.active.endsAtTick, null);
  assert.equal(getUnit(finishSkill(state, 1, 1000, unlimited.resources), 1).skill.active, null);
});

for (const scoped of [false, true]) {
  test(`content refusal retains its prefix and identity allocation, refunds SP, closes scopes (${scoped})`, () => {
    const definition = effectDefinition("rejected-prefix");
    const f = fixture({}, { activate(state, context) {
      const installed = effects.install(state, getUnit(state, 1), definition, { source: 1, scopes: scoped ? [{ type: "SKILL", unitId: 1, activationId: context.activationId }] : [] }, context.call);
      assert.ok(installed.value);
      return { state: installed.state, value: { type: "REJECTED", reason: "content prerequisite" } };
    } });
    const rejected = activateSkill(f.state, { unitId: 1, tick: 0 }, f.resources);
    const unit = getUnit(rejected.state, 1);
    assert.equal(rejected.value.reason, "CONTENT_REJECTED");
    assert.equal(unit.effects.values().length, scoped ? 0 : 1);
    assert.equal(unit.effects.nextId, 1);
    assert.equal(unit.skill.sp, 2);
    assert.equal(unit.skill.nextActivationId, 1);
    assert.equal(unit.skill.active, null);
    assert.equal(getUnit(f.state, 1).effects.nextId, 0);
  });
}

test("zero-duration activation closes its scope before finish content; closed binding is refused", () => {
  const definition = effectDefinition("zero-duration");
  const observed = [];
  let independent;
  const f = fixture({ durationTicks: 0 }, {
    activate(state, context) {
      state = effects.install(state, getUnit(state, 1), definition, { scopes: [{ type: "SKILL", unitId: 1, activationId: context.activationId }] }, context.call).state;
      const installed = effects.install(state, getUnit(state, 1), definition, {}, context.call);
      independent = installed.value;
      return { state: installed.state, value: { type: "ACTIVATED" } };
    },
    finish(state, context) {
      const unit = getUnit(state, 1);
      observed.push({ active: unit.skill.active, effects: unit.effects.values().length });
      const rebound = effects.bindLifetime(state, independent, { type: "SKILL", unitId: 1, activationId: context.activationId });
      assert.equal(rebound.value, false);
      const rejected = effects.install(rebound.state, unit, definition, { scopes: [{ type: "SKILL", unitId: 1, activationId: context.activationId }] }, context.call);
      assert.equal(rejected.value, undefined);
      return rejected.state;
    },
  });
  const activated = activateSkill(f.state, { unitId: 1, tick: 0 }, f.resources);
  assert.deepEqual(activated.state.events.map(event => event.type), ["SKILL_ACTIVATED", "SKILL_FINISHED"]);
  assert.deepEqual(observed, [{ active: null, effects: 1 }]);
  assert.deepEqual(get(activated.state, independent).scopes, []);
  assert.equal(getUnit(activated.state, 1).effects.nextId, 2);
});

for (const trigger of ["SKILL", "EFFECT", "TICK"]) {
  test(`combined scopes: renewed time keeps other constraints until ${trigger} closes`, () => {
    const parent = effectDefinition(`parent-${trigger}`);
    let parentRef;
    let dependentRef;
    const ended = [];
    const dependent = effectDefinition(`dependent-${trigger}`, { renewed: false }, {
      onTick(state, context) {
        if (context.tick !== 5 || context.self.data.renewed) return state;
        const next = setDeadline(setData(context.self, { renewed: true }), 10);
        return effects.replaceEffect(state, { type: "EFFECT", unitId: 1, effectId: (next).id }, next);
      },
      onEnd(state, context) { ended.push(context.reason); return state; },
    });
    const f = fixture({}, { activate(state, context) {
      const installedParent = effects.install(state, getUnit(state, 1), parent, {}, context.call);
      state = installedParent.state;
      parentRef = installedParent.value;
      const installed = effects.install(state, getUnit(state, 1), dependent, { scopes: [{ type: "SKILL", unitId: 1, activationId: context.activationId }, parentRef, { type: "TICK", tick: 5 }] }, context.call);
      dependentRef = installed.value;
      return { state: installed.state, value: { type: "ACTIVATED" } };
    } });
    let state = activateSkill(f.state, { unitId: 1, tick: 0 }, f.resources).state;
    state = effects.advance({ ...state, tick: 5 });
    assert.equal(deadline(get(state, dependentRef)), 10);
    assert.deepEqual(get(state, dependentRef).scopes.filter(scope => scope.type !== "TICK"), [{ type: "SKILL", unitId: 1, activationId: 0 }, parentRef]);
    if (trigger === "SKILL") state = finishSkill(state, 1, 6, f.resources);
    else if (trigger === "EFFECT") state = effects.end(state, parentRef, "DISPELLED");
    else state = effects.advance({ ...state, tick: 10 });
    assert.equal(get(state, dependentRef), undefined);
    assert.equal(getUnit(state, 1).skill.active === null, trigger === "SKILL");
    assert.equal(get(state, parentRef) === undefined, trigger === "EFFECT");
    assert.deepEqual(ended, [trigger === "SKILL" ? "SKILL_FINISHED" : trigger === "EFFECT" ? "DISPELLED" : "EXPIRED"]);
    effects.advance({ ...state, tick: 100 });
    assert.equal(ended.length, 1);
  });
}

test("callback failure propagates without changing its input", () => {
  const failure = new Error("content failed");
  const f = fixture({}, { activate: () => { throw failure; } });
  const before = battlefieldView(f.state);
  assert.throws(() => activateSkill(f.state, { unitId: 1, tick: 0 }, f.resources), error => error === failure);
  assert.equal(before.getUnit(1).skill.sp, 2);
  assert.equal(getUnit(f.state, 1).skill.active, null);
});

test("dead or absent units do not activate or accumulate time SP", () => {
  const f = fixture({ initialSp: 0 });
  const unit = initialize({ id: 1, position: [0, 0], definition: { id: "dead-skilled", skill: f.definition, vitality: { maxHp: 100 } } });
  const state = effectFixtureWork({ ...unit, vitality: { ...unit.vitality, hp: 0 } });
  assert.equal(activateSkill(state, { unitId: 1, tick: 0 }, f.resources).value.reason, "UNAVAILABLE");
  assert.equal(getUnit(advanceSkill(state, 1, 300, f.resources), 1).skill.sp, 0);
  assert.equal(advanceSkill(state, 9, 0, f.resources), state);
});

test("SP drain applies during active skills and finish callbacks see the inactive skill", () => {
  let observed;
  const f = fixture({}, { finish(state, context) { observed = context.facts.getUnit(1).skill.active; return state; } });
  const started = activateSkill(f.state, { unitId: 1, tick: 0 }, f.resources);
  assert.equal(drainSkillSp({ ...getUnit(started.state, 1).skill, sp: 2 }, 5).result.amount, 2);
  const ended = finishSkill(started.state, 1, 30, f.resources);
  assert.equal(observed, null);
  assert.equal(finishSkill(ended, 1, 30, f.resources), ended);
});
