import assert from "node:assert/strict";
import { test } from "node:test";
import { battlefieldView, createBattleState, getUnit } from "../../dist/core/tactical/battle/state.js";
import { removeUnitWithEffects } from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { createSkillDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { activateSkill } from "../../dist/core/tactical/unit/capability/skill/execution.js";
import { fixtureBattlefieldState as fixtureBattlefield } from "../helpers/battlefield.js";

const unit = (id, extra = {}) => initialize({ id, position: [0, id], definition: { id: `lifecycle-unit-${id}`, vitality: { maxHp: 100 }, ...extra } });

test("departure callbacks observe LEAVING while old snapshots remain PRESENT", () => {
  let state = createBattleState(fixtureBattlefield([unit(0)]));
  const original = state;
  const trace = [];
  const observe = (state, stage) => {
    const current = getUnit(state, 0);
    trace.push([stage, current.lifecycle]);
    const nested = removeUnitWithEffects(state, 0, "DEATH", resources, 0);
    assert.equal(nested, state);
    assert.equal(getUnit(nested, 0), current);
    return nested;
  };
  const resources = {
    stopSkillActivation(state) { return { state: observe(state, "stop skill"), value: null }; },
    notifySkillFinished() { assert.fail("no active skill"); },
  };
  state = effects.install(state, getUnit(state, 0), {
    id: "departure-observer", initialize: () => ({}),
    onDisable: state => observe(state, "disable effect"),
    onEnd: state => observe(state, "end effect"),
  }).state;
  const before = battlefieldView(state);
  state = removeUnitWithEffects(state, 0, "RETREAT", resources, 0);
  assert.deepEqual(trace, [["stop skill", "LEAVING"], ["disable effect", "LEAVING"], ["end effect", "LEAVING"]]);
  assert.equal(before.getUnit(0).lifecycle, "PRESENT");
  assert.equal(before.getUnit(0).effects.values()[0].status, "ACTIVE");
  assert.equal(getUnit(original, 0).lifecycle, "PRESENT");
  assert.equal(getUnit(state, 0), undefined);
  assert.deepEqual(state.removedUnits.map(({ unitId, reason }) => [unitId, reason]), [[0, "RETREAT"]]);
  assert.equal(state.closedLifetimes.has("UNIT:0"), false);
});

test("skill finish sees LEAVING and cannot install dependencies on its departing source", () => {
  const skill = createSkillDefinition({ id: "departing-skill", activation: "MANUAL", spRecovery: "NONE", spCost: 1, initialSp: 1, durationTicks: null });
  const resources = new CombatResources();
  let state = createBattleState(fixtureBattlefield([unit(0, { skill }), unit(1)]));
  const statuses = [];
  let installations = 0;
  resources.skills.register({ definition: skill,
    activate: state => ({ state, value: { type: "ACTIVATED" } }),
    finish(state, context) {
      statuses.push(context.facts.getUnit(0).lifecycle);
      state = removeUnitWithEffects(state, 0, "DEATH", resources, context.tick, context.call);
      const rejected = effects.install(state, getUnit(state, 1), { id: "late-dependency", initialize: () => ({}), onInstall(state) { installations++; return state; } }, { scopes: [{ type: "UNIT", unitId: 0 }] }, context.call);
      assert.equal(rejected.value, undefined);
      return rejected.state;
    },
  });
  state = activateSkill(state, { unitId: 0, tick: 0 }, resources).state;
  const before = battlefieldView(state);
  state = removeUnitWithEffects(state, 0, "SCRIPT", resources, 1);
  assert.deepEqual(statuses, ["LEAVING"]);
  assert.equal(installations, 0);
  assert.equal(getUnit(state, 1).effects.nextId, 0);
  assert.equal(before.getUnit(0).lifecycle, "PRESENT");
  assert.ok(before.getUnit(0).skill.active);
  assert.equal(getUnit(state, 0), undefined);
  assert.equal(state.events.filter(({ type }) => type === "SKILL_FINISHED").length, 1);
  assert.deepEqual(state.removedUnits.map(({ unitId, reason }) => [unitId, reason]), [[0, "SCRIPT"]]);
});

test("departure callbacks cannot start a new skill activation", () => {
  const skill = createSkillDefinition({ id: "closed-host-activation", activation: "MANUAL", spRecovery: "NONE", spCost: 0, initialSp: 0, durationTicks: null });
  const resources = new CombatResources();
  let activations = 0;
  let attempted;
  resources.skills.register({ definition: skill, activate(state) { activations++; return { state, value: { type: "ACTIVATED" } }; } });
  const original = createBattleState(fixtureBattlefield([unit(0, { skill })]));
  const installed = effects.install(original, getUnit(original, 0), {
    id: "activation-on-departure", initialize: () => ({}),
    onEnd(state, context) {
      attempted = activateSkill(state, { unitId: 0, tick: context.tick }, resources, context.call);
      assert.equal(attempted.state, state);
      assert.equal(getUnit(attempted.state, 0).skill.active, null);
      return attempted.state;
    },
  });
  const state = removeUnitWithEffects(installed.state, 0, "RETREAT", resources, 0);
  assert.deepEqual(attempted.value, { result: { type: "REJECTED", reason: "UNAVAILABLE" }, signals: [] });
  assert.equal(activations, 0);
  assert.equal(getUnit(state, 0), undefined);
  assert.equal(getUnit(original, 0).lifecycle, "PRESENT");
  assert.equal(getUnit(original, 0).skill.nextActivationId, 0);
});
