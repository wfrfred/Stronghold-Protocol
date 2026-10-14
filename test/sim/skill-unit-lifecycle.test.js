import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { definition as effectDefinition, effectFixtureWork, at } from "../helpers/effects.js";
import { battlefieldView, getUnit, transitionUnit } from "../../dist/core/tactical/battle/state.js";
import { setHook, removeHook } from "../../dist/core/tactical/unit/capability/vitality/damage/hook.js";

import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { removeUnitWithEffects } from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";
import { createDefinition as createSkillDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { activateSkill } from "../../dist/core/tactical/unit/capability/skill/execution.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";

function fixture(content = {}) {
  const resources = new CombatResources();
  const finished = [];
  const disabled = [];
  const owned = effectDefinition("skill-owned-on-receiver", {}, {
    onDisable(state, context) {
      disabled.push(context.ref.effectId);
      return content.disable?.(state, context) ?? state;
    },
  });
  const definition = createSkillDefinition({ id: "departing-skill", activation: "MANUAL", spRecovery: "NONE", spCost: 1, initialSp: 1, durationTicks: null });
  const installOwned = (state, context, expected = true) => {
    const refs = [];
    for (const additional of [[], [{ type: "UNIT", unitId: 1 }]]) {
      const installed = effects.install(state, unitRef(getUnit(state, 1)), owned, { source: context.unitId, scopes: [{ type: "SKILL", unitId: context.unitId, activationId: context.activationId }, ...additional] }, context.call);
      state = installed.state;
      assert.equal(installed.value !== undefined, expected);
      refs.push(installed.value);
    }
    return { state, value: refs };
  };
  resources.skills.register({
    definition,
    activate(state, context) {
      if (content.activate) return content.activate(state, context, installOwned, resources);
      return { state: installOwned(state, context).state, value: { type: "ACTIVATED" } };
    },
    finish(state, context) {
      const source = getUnit(state, context.unitId);
      finished.push({ sourcePresent: source !== undefined, active: source?.skill.active, tick: context.tick });
      return content.finish?.(state, context, resources) ?? state;
    },
  });
  const sourceDefinition = { id: "skill-source", vitality: { maxHp: 100 }, skill: definition };
  const receiverDefinition = { id: "skill-receiver", vitality: { maxHp: 100 } };
  const source = initialize({ id: 0, definition: sourceDefinition, position: [0, 0] });
  const receiver = initialize({ id: 1, definition: receiverDefinition, position: [1, 0] });
  return { resources, finished, disabled, sourceDefinition, receiverDefinition, work: effectFixtureWork(source, receiver) };
}
function sourceDamage(power = 100, tick = 1) {
  return { sourceUnitId: null, targetUnitId: 0, damageType: "TRUE", operands: createDamageOperands(power), tick };
}
function skillsFinished(state) { return state.events.filter(event => event.type === "SKILL_FINISHED"); }

for (const reason of ["DEATH", "RETREAT", "SCRIPT"]) {
  test(`${reason} closes skill-dependent effects before deleting the source and leaves old versions unchanged`, () => {
    const f = fixture();
    let state = activateSkill(f.work, { unitId: 0, tick: 0 }, f.resources).state;
    const before = battlefieldView(state);
    state = reason === "DEATH" ? f.resources.settleDamage(state, sourceDamage()).state : removeUnitWithEffects(state, 0, reason, f.resources, 1);
    assert.equal(getUnit(state, 0), undefined);
    assert.equal(state.removedUnits.find(value => value.unitId === 0).reason, reason);
    assert.deepEqual(getUnit(state, 1).effects.values(), []);
    assert.deepEqual(f.disabled, [0, 1]);
    assert.deepEqual(f.finished, [{ sourcePresent: true, active: null, tick: 1 }]);
    assert.equal(skillsFinished(state).length, 1);
    assert.equal(before.getUnit(0).skill.active.id, 0);
    assert.equal(before.getUnit(1).effects.values().every(instance => instance.status === "ACTIVE"), true);
    state = removeUnitWithEffects(state, 0, reason, f.resources, 1);
    state = effects.advance(at(state, 2));
    assert.equal(skillsFinished(state).length, 1);
    assert.equal(f.finished.length, 1);
    assert.deepEqual(getUnit(state, 1).effects.values(), []);
    assert.equal(getUnit(f.work, 0).vitality.hp, 100);
  });
}

test("skill finish can install a hook before nested damage", () => {
  const hits = [];
  const observer = effectDefinition("finish-installed-observer", {}, {
    onInstall(state, context) {
      const id = context.self.id;
      return transitionUnit(state, context.unit.id, unit => ({ ...unit, vitality: setHook(unit.vitality, {
        id: "skill-finish-observer", stage: "reception", priority: 0,
        enabled: context => context.unit.effects.get(id, observer)?.status === "ACTIVE",
        invoke(state, _context, value) { hits.push("observer"); return { state, value: { value } }; },
      }) }));
    },
    onEnd(state, context) { return transitionUnit(state, context.unit.id, unit => ({ ...unit, vitality: removeHook(unit.vitality, "skill-finish-observer") })); },
  });
  const f = fixture({ finish(state, context, resources) {
    const installed = effects.install(state, unitRef(getUnit(state, 1)), observer, {}, context.call);
    assert.ok(installed.value);
    return resources.settleDamage(installed.state, { sourceUnitId: 0, targetUnitId: 1, damageType: "TRUE", operands: createDamageOperands(1), tick: context.tick }, context.call).state;
  } });
  let state = activateSkill(f.work, { unitId: 0, tick: 0 }, f.resources).state;
  state = removeUnitWithEffects(state, 0, "SCRIPT", f.resources, 1);
  assert.deepEqual(hits, ["observer"]);
  assert.equal(getUnit(state, 1).vitality.hp, 99);
});

test("activation continues after self-death, but late dependencies are rejected before allocation", () => {
  const observed = [];
  const f = fixture({ activate(state, context, installOwned, resources) {
    state = installOwned(state, context).state;
    state = resources.settleDamage(state, sourceDamage(100, context.tick), context.call).state;
    assert.equal(getUnit(state, 0), undefined);
    observed.push("continued");
    state = installOwned(state, context, false).state;
    assert.deepEqual(getUnit(state, 1).effects.values(), []);
    assert.equal(getUnit(state, 1).effects.nextId, 2);
    return { state, value: { type: "ACTIVATED" } };
  } });
  const activated = activateSkill(f.work, { unitId: 0, tick: 0 }, f.resources);
  assert.equal(activated.value.type, "FINISHED");
  assert.equal(activated.state.events.some(event => event.type === "SKILL_ACTIVATED"), false);
  assert.deepEqual(observed, ["continued"]);
  assert.equal(getUnit(activated.state, 0), undefined);
  assert.deepEqual(f.finished, [{ sourcePresent: true, active: null, tick: 0 }]);
  assert.deepEqual(f.disabled, [0, 1]);
  assert.equal(skillsFinished(activated.state).length, 1);
  assert.equal(getUnit(f.work, 0).skill.active, null);
  assert.equal(getUnit(f.work, 0).vitality.hp, 100);
  assert.deepEqual(getUnit(f.work, 1).effects.values(), []);
});

test("refusal after self-death preserves independent remote effects", () => {
  const independent = effectDefinition("independent-after-refusal");
  const f = fixture({ activate(state, context, installOwned, resources) {
    state = resources.settleDamage(state, sourceDamage(100, context.tick), context.call).state;
    state = installOwned(state, context, false).state;
    const installed = effects.install(state, unitRef(getUnit(state, 1)), independent, { source: context.unitId, scopes: [] }, context.call);
    assert.ok(installed.value);
    return { state: installed.state, value: { type: "REJECTED", reason: "late prerequisite" } };
  } });
  const rejected = activateSkill(f.work, { unitId: 0, tick: 0 }, f.resources);
  assert.deepEqual(rejected.value, { type: "REJECTED", reason: "CONTENT_REJECTED", detail: "late prerequisite" });
  assert.equal(getUnit(rejected.state, 0), undefined);
  assert.equal(getUnit(rejected.state, 1).effects.values().every(instance => instance.status === "ACTIVE"), true);
  assert.equal(skillsFinished(rejected.state).length, 1);
});

function runtime(f) {
  const base = createLegacyCombatSpec({ rows: 1, columns: 3, operators: [], enemies: [], maxTicks: 20, seed: 7 });
  return new BattleRuntime({ ...base, initialUnits: [{ definition: f.sourceDefinition, position: [0, 0] }, { definition: f.receiverDefinition, position: [1, 0] }],
    schedule: { type: "TIMELINE", spawns: [{ definition: { id: "future", vitality: { maxHp: 1 }, locomotion: { moveSpeedPerTick: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 } } }, tick: 19,
      route: { pathMotionMode: "WALK", startPosition: [0, 2], endPosition: [0, 2], spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [], allowDiagonalMove: false, visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true }, timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true, notCountInTotal: false }] },
  }, { combat: f.resources });
}

test("departure callback errors propagate without publishing their prefix", () => {
  const prefix = effectDefinition("finish-prefix");
  const f = fixture({ finish(state, context) {
    const installed = effects.install(state, unitRef(getUnit(state, 1)), prefix, { source: 0, scopes: [] }, context.call);
    assert.ok(installed.value);
    throw new Error("skill departure failed");
  } });
  const battle = runtime(f);
  battle.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  const before = battle.snapshot();
  assert.throws(() => battle.step([{ type: "RETREAT_UNIT", unitId: 0 }]), /skill departure failed/);
  assert.deepEqual(battle.snapshot(), before);
});

test("self-death during activation publishes one finish and no late start", () => {
  const f = fixture({ activate(state, context, installOwned, resources) {
    state = resources.settleDamage(state, sourceDamage(100, context.tick), context.call).state;
    state = installOwned(state, context, false).state;
    return { state, value: { type: "ACTIVATED" } };
  } });
  const battle = runtime(f);
  const step = battle.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  assert.deepEqual(step.events.filter(event => event.type.startsWith("SKILL_")).map(event => event.type), ["SKILL_FINISHED"]);
  assert.equal(battle.snapshot().units.some(unit => unit.id === 0), false);
  assert.deepEqual(battle.snapshot().units.find(unit => unit.id === 1).effects.values(), []);
  assert.equal(f.finished.length, 1);
});

test("failed departure cleanup does not publish self-death or allocated identities", () => {
  const f = fixture({ activate(state, context, installOwned, resources) {
    state = installOwned(state, context).state;
    state = resources.settleDamage(state, sourceDamage(100, context.tick), context.call).state;
    return { state: installOwned(state, context, false).state, value: { type: "ACTIVATED" } };
  }, disable() { throw new Error("late skill cleanup failed"); } });
  const battle = runtime(f);
  const before = battle.snapshot();
  assert.throws(() => battle.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]), /late skill cleanup failed/);
  assert.deepEqual(battle.snapshot(), before);
});
