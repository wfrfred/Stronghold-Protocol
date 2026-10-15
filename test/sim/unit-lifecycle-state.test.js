import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceBattlefield, battlefieldView, createBattleState, getUnit, registerUnit, updateUnit,
} from "../../dist/core/tactical/battle/state.js";
import { enterUnits, removeUnitWithEffects } from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import { createDefinition as createEnemyDefinition } from "../../dist/core/tactical/unit/archetype/enemy.js";
import { createMechanism, createMechanismDefinition } from "../../dist/core/tactical/battlefield/mechanism.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { createDefinition as createSkillDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { activateSkill } from "../../dist/core/tactical/unit/capability/skill/execution.js";
import { fixtureBattlefieldState as fixtureBattlefield } from "../helpers/battlefield.js";

const unit = (id, extra = {}) => initialize({ id, position: [0, id], definition: { id: `lifecycle-unit-${id}`, vitality: { maxHp: 100 }, ...extra } });

test("departure callbacks observe LEAVING while old snapshots remain PRESENT", () => {
  const skill = createSkillDefinition({ id: "observe-departure", activation: "MANUAL", spRecovery: "NONE", spCost: 0, initialSp: 0, durationTicks: null });
  const resources = new CombatResources();
  let state = createBattleState(fixtureBattlefield([unit(0, { skill })]));
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
  resources.skills.register({
    definition: skill,
    activate: state => ({ state, value: { type: "ACTIVATED" } }),
    finish: state => observe(state, "finish skill"),
  });
  state = activateSkill(state, { unitId: 0, tick: 0 }, resources).state;
  state = effects.install(state, unitRef(getUnit(state, 0)), {
    id: "departure-observer", initialize: () => ({}),
    onDisable: state => observe(state, "disable effect"),
    onEnd: state => observe(state, "end effect"),
  }).state;
  const before = battlefieldView(state);
  state = removeUnitWithEffects(state, 0, "RETREAT", resources, 0);
  assert.deepEqual(trace, [["disable effect", "LEAVING"], ["end effect", "LEAVING"], ["finish skill", "LEAVING"]]);
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
      statuses.push(context.battlefield.getUnit(0).lifecycle);
      state = removeUnitWithEffects(state, 0, "DEATH", resources, context.tick, context.call);
      const rejected = effects.install(state, unitRef(getUnit(state, 1)), { id: "late-dependency", initialize: () => ({}), onInstall(state) { installations++; return state; } }, { scopes: [{ type: "UNIT", unitId: 0 }] }, context.call);
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
  const installed = effects.install(original, unitRef(getUnit(original, 0)), {
    id: "activation-on-departure", initialize: () => ({}),
    onEnd(state, context) {
      attempted = activateSkill(state, { unitId: 0, tick: context.tick }, resources, context.call);
      assert.equal(attempted.state, state);
      assert.equal(getUnit(attempted.state, 0).skill.active, null);
      return attempted.state;
    },
  });
  const state = removeUnitWithEffects(installed.state, 0, "RETREAT", resources, 0);
  assert.deepEqual(attempted.value, { type: "REJECTED", reason: "UNAVAILABLE" });
  assert.equal(activations, 0);
  assert.equal(getUnit(state, 0), undefined);
  assert.equal(getUnit(original, 0).lifecycle, "PRESENT");
  assert.equal(getUnit(original, 0).skill.nextActivationId, 0);
});

test("onLeave reads the pre-cleanup Unit after removal and passes its changes to mechanisms", () => {
  const resources = new CombatResources();
  const trace = [];
  const skill = createSkillDefinition({
    id: "leave-with-sp", activation: "MANUAL", spRecovery: "NONE",
    spCost: 1, initialSp: 3, maxCharges: 3, durationTicks: null,
  });
  resources.skills.register({
    definition: skill,
    activate: state => ({ state, value: { type: "ACTIVATED" } }),
    finish(state) {
      trace.push("skill finish");
      const current = getUnit(state, 0);
      assert.equal(current.lifecycle, "LEAVING");
      assert.deepEqual(current.effects.values(), []);
      return updateUnit(state, { ...current, skill: { ...current.skill, sp: 0 } });
    },
  });
  let departing;
  const child = unit(2, {
    onEnter(state, unitId) {
      trace.push("new unit enter");
      const current = getUnit(state, unitId);
      return updateUnit(state, { ...current, vitality: { ...current.vitality, hp: 55 } });
    },
  });
  const host = unit(0, {
    skill,
    onLeave(state, departure) {
      trace.push("unit leave");
      assert.equal(getUnit(state, 0), undefined);
      assert.equal(departure.unit, departing);
      assert.equal(departure.reason, "RETREAT");
      assert.equal(departure.unit.lifecycle, "PRESENT");
      assert.equal(departure.unit.skill.sp, 2);
      assert.equal(departure.unit.skill.active.id, 0);
      assert.equal(departure.unit.effects.values()[0].status, "ACTIVE");
      const other = getUnit(state, 1);
      state = updateUnit(state, { ...other, vitality: { ...other.vitality, hp: 77 } });
      return enterUnits(registerUnit(state, child), [child.id]);
    },
  });
  const mechanism = createMechanism({
    id: 4, active: true,
    definition: createMechanismDefinition({
      id: "observe-unit-leave",
      onUnitLeave(state, mechanismId, departure) {
        trace.push("mechanism leave");
        assert.equal(mechanismId, 4);
        assert.equal(departure.unit, departing);
        assert.equal(getUnit(state, 0), undefined);
        assert.equal(getUnit(state, 1).vitality.hp, 77);
        assert.equal(getUnit(state, 2).vitality.hp, 55);
        const other = getUnit(state, 1);
        return updateUnit(state, { ...other, vitality: { ...other.vitality, hp: 60 } });
      },
    }),
  });
  let state = createBattleState(fixtureBattlefield([host, unit(1)], {
    mechanismIds: [4], getMechanism: () => mechanism,
  }));
  state = activateSkill(state, { unitId: 0, tick: 0 }, resources).state;
  state = effects.install(state, unitRef(getUnit(state, 0)), {
    id: "leave-effect", initialize: () => ({}),
    onDisable(state) { trace.push("effect disable"); return state; },
    onEnd(state) { trace.push("effect end"); return state; },
  }).state;
  departing = getUnit(state, 0);
  const before = state;
  state = removeUnitWithEffects(state, 0, "RETREAT", resources, 1);
  assert.deepEqual(trace, ["effect disable", "effect end", "skill finish", "unit leave", "new unit enter", "mechanism leave"]);
  assert.equal(getUnit(state, 1).vitality.hp, 60);
  assert.equal(getUnit(state, 2).vitality.hp, 55);
  assert.equal(getUnit(before, 0), departing);
  assert.equal(getUnit(before, 1).vitality.hp, 100);
  assert.equal(getUnit(before, 2), undefined);
});

test("mechanism leave responses keep their candidate IDs and reread current registrations", () => {
  const resources = new CombatResources();
  const trace = [];
  const later = createMechanism({ id: 3, active: true, definition: {
    id: "registered-during-notification",
    onUnitLeave(state) { trace.push("new observer"); return state; },
  } });
  const mechanisms = [
    createMechanism({ id: 0, active: true, definition: {
      id: "first-observer",
      onUnitLeave(state) {
        trace.push("first");
        return advanceBattlefield(state, [
          { type: "REMOVE_MECHANISM", mechanismId: 1, reason: "SCRIPT" },
          { type: "SET_MECHANISM_ACTIVE", mechanismId: 2, active: true },
          { type: "REGISTER_MECHANISM", mechanism: later },
        ]);
      },
    } }),
    createMechanism({ id: 1, active: true, definition: {
      id: "removed-before-response",
      onUnitLeave(state) { trace.push("removed observer"); return state; },
    } }),
    createMechanism({ id: 2, active: false, definition: {
      id: "activated-before-response",
      onUnitLeave(state) { trace.push("activated observer"); return state; },
    } }),
  ];
  const original = createBattleState(fixtureBattlefield([unit(0)], {
    mechanismIds: [0, 1, 2], getMechanism: id => mechanisms[id],
  }));
  const state = removeUnitWithEffects(original, 0, "SCRIPT", resources, 0);
  assert.deepEqual(trace, ["first", "activated observer"]);
  assert.deepEqual(battlefieldView(state).mechanismIds, [0, 2, 3]);
  assert.deepEqual(battlefieldView(original).mechanismIds, [0, 1, 2]);
});

test("factory-created enemies retain onLeave and call it only for an actual departure", () => {
  const resources = new CombatResources();
  let notifications = 0;
  const onLeave = (state, departure) => {
    notifications++;
    assert.equal(getUnit(state, departure.unit.id), undefined);
    assert.equal(departure.reason, "DEATH");
    return state;
  };
  const definition = createEnemyDefinition({
    id: "enemy-with-leave", vitality: { maxHp: 100 },
    locomotion: { moveSpeedPerTick: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 } },
    onLeave,
  });
  assert.equal(definition.onLeave, onLeave);
  let state = createBattleState(fixtureBattlefield([
    initialize({ id: 0, position: [0, 0], definition }),
  ]));
  state = removeUnitWithEffects(state, 0, "DEATH", resources, 0);
  assert.equal(removeUnitWithEffects(state, 0, "DEATH", resources, 0), state);
  assert.equal(notifications, 1);
});
