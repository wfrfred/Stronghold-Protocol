import assert from "node:assert/strict";
import { test } from "node:test";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import {
  battlefieldView,
  getUnit,
  transitionUnit,
} from "../../dist/core/tactical/battle/execution/context.js";
import * as contribution from "../../dist/core/tactical/contribution/state.js";
import * as modifier from "../../dist/core/tactical/contribution/value.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { attack, liveAttack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import { defense } from "../../dist/core/tactical/unit/capability/defense/contributions.js";
import { resolveDefense } from "../../dist/core/tactical/unit/capability/defense/query.js";
import { updateAttackContributions } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { createEffectDefinition } from "../../dist/core/tactical/unit/capability/effects/definition.js";
import {
  installEffect,
  removeEffect,
  setEffectEnabled,
  updateEffectState,
} from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { effectFixtureWork } from "../helpers/effects.js";

const unit = (id, attack = 100) => initializeUnit({
  id,
  definition: {
    id: `unit-${id}`,
    offense: { attack },
    defense: { defense: 0, resistance: 0 },
  },
  position: [0, 0],
});
const value = (amount) => modifier.create({ finalAddition: amount });
const program = (id) => createEffectDefinition({
  id,
  initialize: () => ({ coefficient: 0, amount: 0, defense: 0, grouped: true }),
});
const install = (work, resources, program, id, state, source = null) => {
  const result = installEffect(work, 1, resources.effects.create(program, {
    id, source, scopes: [],
  acquiredSequence: id,
  }, state), resources, 0);
  assert.equal(result.type, "INSTALLED");
};
const attackPower = (work, resources) =>
  resolveAttackPower(1, battlefieldView(work), resources.computations);
const entries = (work) => getUnit(work, 1).offense.attack.entries;
const slot = (instance) => instance.state.grouped
  ? { id: "inspiration/attack", strength: instance.state.coefficient }
  : undefined;

test("contribution groups: the ATK coefficient wins, while other facets participate and removal restores the sampled loser", () => {
  const resources = new CombatResources();
  const effect = program("sampled-inspiration");
  let samples = 0;
  resources.registerEffect(effect, { contributions: [
    attack((instance) => {
      samples += 1;
      return [value(instance.state.amount)];
    }, { group: slot }),
    defense((instance) => [value(instance.state.defense)]),
  ] });
  const work = effectFixtureWork(unit(1));
  install(work, resources, effect, 0,
    { coefficient: 0.3, amount: 300, defense: 10, grouped: true });
  install(work, resources, effect, 1,
    { coefficient: 0.6, amount: 60, defense: 20, grouped: true });

  assert.equal(attackPower(work, resources), 160);
  assert.equal(resolveDefense(1, battlefieldView(work)).defense, 30);
  assert.equal(samples, 2);
  assert.deepEqual(entries(work).map((entry) => entry.participating), [true, true]);
  assert.deepEqual(getUnit(work, 1).effects.instances.map((instance) => instance.participating), [true, true]);
  const loserValues = entries(work)[0].values;

  removeEffect(work, { type: "EFFECT", unitId: 1, effectId: 1 }, resources, 0);
  assert.equal(attackPower(work, resources), 400);
  assert.equal(resolveDefense(1, battlefieldView(work)).defense, 10);
  assert.equal(entries(work)[0].values, loserValues);
  assert.equal(samples, 2);
});

test("contribution groups: explicit sampled state updates refresh strength, samples, and optional group membership", () => {
  const resources = new CombatResources();
  const effect = program("updated-inspiration");
  let samples = 0;
  resources.registerEffect(effect, { contributions: [attack((instance) => {
    samples += 1;
    return [value(instance.state.amount)];
  }, { group: slot })] });
  const work = effectFixtureWork(unit(1));
  install(work, resources, effect, 0,
    { coefficient: 0.3, amount: 300, grouped: true });
  install(work, resources, effect, 1,
    { coefficient: 0.6, amount: 60, grouped: true });
  const original = work.battlefield.snapshot("draft");

  updateEffectState(work, 1, 0, effect,
    (state) => ({ ...state, coefficient: 0.7, amount: 70 }), resources, 0);
  assert.equal(entries(work)[0].group.strength, 0.7);
  assert.equal(attackPower(work, resources), 170);
  assert.equal(resolveAttackPower(1, original, resources.computations), 160);
  assert.equal(samples, 3);

  updateEffectState(work, 1, 0, effect,
    (state) => ({ ...state, grouped: false }), resources, 0);
  assert.equal(Object.hasOwn(entries(work)[0], "group"), false);
  assert.equal(attackPower(work, resources), 230);
  assert.equal(samples, 4);
});

test("contribution groups: live values stay current without reranking, and explicit group updates never evaluate", () => {
  const resources = new CombatResources();
  const effect = program("live-inspiration");
  let computes = 0;
  let groupReads = 0;
  resources.registerEffect(effect, { contributions: [liveAttack(({ instance, battlefield }) => {
    computes += 1;
    return [value(resolveAttackPower(instance.source, battlefield) * instance.state.coefficient)];
  }, { group: (instance) => {
    groupReads += 1;
    return slot(instance);
  } })] });
  const work = effectFixtureWork(unit(1), unit(2, 1000), unit(3));
  install(work, resources, effect, 0,
    { coefficient: 0.3, grouped: true }, 2);
  install(work, resources, effect, 1,
    { coefficient: 0.6, grouped: true }, 3);
  assert.equal(computes, 0);
  assert.equal(groupReads, 2);
  assert.equal(attackPower(work, resources), 160);
  assert.equal(computes, 1);
  const originalEntries = entries(work);

  transitionUnit(work, 3, (provider) => updateAttackContributions(provider, (state) =>
    contribution.register(state, { id: "provider-buff", sequence: 0, kind: "SAMPLED", participating: true, values: [value(100)] })));
  assert.equal(attackPower(work, resources), 220);
  assert.equal(entries(work), originalEntries);
  assert.equal(groupReads, 2);
  assert.equal(computes, 2);

  const originalRef = entries(work)[0].evaluator;
  updateEffectState(work, 1, 0, effect,
    (state) => ({ ...state, coefficient: 0.7 }), resources, 0);
  assert.equal(computes, 2);
  assert.equal(groupReads, 3);
  assert.equal(entries(work)[0].group.strength, 0.7);
  assert.equal(entries(work)[0].evaluator, originalRef);
  assert.equal(attackPower(work, resources), 800);

  setEffectEnabled(work, { type: "EFFECT", unitId: 1, effectId: 0 }, false, resources, 0);
  const beforeUpdate = computes;
  updateEffectState(work, 1, 0, effect,
    (state) => ({ ...state, grouped: false }), resources, 0);
  assert.equal(computes, beforeUpdate);
  assert.equal(entries(work)[0].participating, false);
  assert.equal(entries(work)[0].evaluator, originalRef);
  assert.equal(Object.hasOwn(entries(work)[0], "group"), false);
  assert.equal(attackPower(work, resources), 220);
});

test("contribution groups: static groups are shared and dynamic updates retain previous snapshots", () => {
  for (const useLive of [false, true]) {
    const resources = new CombatResources();
    const effect = program(`shared-groups-${useLive}`);
    const fixed = { id: "fixed", strength: 1 };
    let returned;
    const factory = useLive
      ? (options) => liveAttack(() => [value(10)], options)
      : (options) => attack(() => [value(10)], options);
    resources.registerEffect(effect, { contributions: [
      factory({ id: "fixed", group: fixed }),
      factory({ id: "dynamic", group: (instance) => {
        returned = { id: "dynamic", strength: instance.state.coefficient };
        return returned;
      } }),
    ] });
    const work = effectFixtureWork(unit(1));
    install(work, resources, effect, 0,
      { coefficient: 2, grouped: true });
    const original = work.battlefield.snapshot("draft");
    const initialGroup = entries(work)[1].group;
    assert.equal(entries(work)[0].group, fixed);
    assert.equal(initialGroup, returned);
    assert.deepEqual(initialGroup, { id: "dynamic", strength: 2 });

    updateEffectState(work, 1, 0, effect,
      (state) => ({ ...state, coefficient: 3 }), resources, 0);
    const updatedGroup = entries(work)[1].group;
    assert.equal(entries(work)[0].group, fixed);
    assert.equal(updatedGroup, returned);
    assert.notEqual(updatedGroup, initialGroup);
    assert.deepEqual(updatedGroup, { id: "dynamic", strength: 3 });
    assert.equal(original.getUnit(1).offense.attack.entries[1].group, initialGroup);
    assert.deepEqual(initialGroup, { id: "dynamic", strength: 2 });
  }
});
