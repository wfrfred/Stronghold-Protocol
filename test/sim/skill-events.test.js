import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { effectFixtureWork } from "../helpers/effects.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { createDefinition as createSkillDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { activateSkill, finishSkill } from "../../dist/core/tactical/unit/capability/skill/execution.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";

function fixture({ durationTicks = 0, reject = false, finishDuringActivation = false } = {}) {
  const resources = new CombatResources();
  const definition = createSkillDefinition({
    id: "event-order", activation: "MANUAL", spRecovery: "NONE",
    spCost: 1, initialSp: 1, durationTicks,
  });
  const damage = (state, tick, amount, call) => resolveDamage(state, {
    sourceUnitId: 1, targetUnitId: 2, tick, damageType: "TRUE",
    operands: createDamageOperands(amount),
  }, resources, call).state;
  const dependent = {
    id: "event-order-dependent", initialize: () => ({}),
    onEnd: (state, context) => damage(state, context.tick, 2, context.call),
  };
  resources.skills.register({
    definition,
    activate(state, context) {
      state = effects.install(state, unitRef(getUnit(state, 2)), dependent, {
        scopes: [{ type: "SKILL", unitId: 1, activationId: context.activationId }],
      }, context.call).state;
      state = damage(state, context.tick, 1, context.call);
      if (finishDuringActivation) {
        state = finishSkill(state, 1, context.tick, resources, context.call);
        state = damage(state, context.tick, 4, context.call);
      }
      return { state, value: reject
        ? { type: "REJECTED", reason: "content condition" }
        : { type: "ACTIVATED" } };
    },
    finish(state, context) {
      assert.equal(getUnit(state, 1).skill.active, null);
      assert.equal(getUnit(state, 2).effects.values().length, 0);
      return damage(state, context.tick, 3, context.call);
    },
  });
  const source = initialize({ id: 1, position: [0, 0], definition: {
    id: "event-source", vitality: { maxHp: 100 }, skill: definition,
  } });
  const target = initialize({ id: 2, position: [1, 0], definition: {
    id: "event-target", vitality: { maxHp: 100 },
  } });
  return { resources, state: effectFixtureWork(source, target) };
}

test("zero-duration skill records successful activation before its cleanup and finish content", () => {
  const f = fixture();
  const settled = activateSkill(f.state, { unitId: 1, tick: 0 }, f.resources);
  assert.deepEqual(settled.value, { type: "ACTIVATED" });
  assert.deepEqual(settled.state.events.map(event => event.type), [
    "DAMAGE", "SKILL_ACTIVATED", "DAMAGE", "DAMAGE", "SKILL_FINISHED",
  ]);
  assert.equal(getUnit(settled.state, 2).vitality.hp, 94);
  assert.equal(getUnit(f.state, 2).vitality.hp, 100);
  assert.deepEqual(f.state.events, []);
  assert.equal(finishSkill(settled.state, 1, 0, f.resources), settled.state);
});

test("content refusal records its completed prefix and cleanup without a successful activation event", () => {
  const f = fixture({ reject: true });
  const settled = activateSkill(f.state, { unitId: 1, tick: 0 }, f.resources);
  assert.deepEqual(settled.value, {
    type: "REJECTED", reason: "CONTENT_REJECTED", detail: "content condition",
  });
  assert.deepEqual(settled.state.events.map(event => event.type), ["DAMAGE", "DAMAGE"]);
  assert.equal(getUnit(settled.state, 1).skill.sp, 1);
  assert.equal(getUnit(settled.state, 2).vitality.hp, 97);
});

test("explicit finish owns its events and repeated finish does not repeat callbacks or damage", () => {
  const f = fixture({ durationTicks: null });
  const activated = activateSkill(f.state, { unitId: 1, tick: 0 }, f.resources).state;
  const finished = finishSkill(activated, 1, 1, f.resources);
  assert.deepEqual(finished.events.map(event => event.type), [
    "DAMAGE", "SKILL_ACTIVATED", "DAMAGE", "DAMAGE", "SKILL_FINISHED",
  ]);
  assert.equal(finishSkill(finished, 1, 1, f.resources), finished);
  assert.equal(getUnit(activated, 2).vitality.hp, 99);
});

test("ending during activation completes cleanup synchronously and entered content can continue", () => {
  const f = fixture({ durationTicks: null, finishDuringActivation: true });
  const settled = activateSkill(f.state, { unitId: 1, tick: 0 }, f.resources);
  assert.deepEqual(settled.value, { type: "FINISHED" });
  assert.deepEqual(settled.state.events.map(event => event.type), [
    "DAMAGE", "DAMAGE", "DAMAGE", "SKILL_FINISHED", "DAMAGE",
  ]);
  assert.equal(getUnit(settled.state, 2).vitality.hp, 90);
  assert.equal(getUnit(settled.state, 1).skill.active, null);
  assert.equal(finishSkill(settled.state, 1, 0, f.resources), settled.state);
});
