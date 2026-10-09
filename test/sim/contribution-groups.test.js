import assert from "node:assert/strict";
import { test } from "node:test";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import {
  combatWorkView,
  getCombatUnit,
  transitionCombatUnit,
} from "../../dist/core/tactical/battle/execution/work.js";
import * as contribution from "../../dist/core/tactical/modifier/contribution.js";
import * as modifier from "../../dist/core/tactical/modifier/value.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { attack, computedAttack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import { defense } from "../../dist/core/tactical/unit/capability/defense/contributions.js";
import { resolveDefense } from "../../dist/core/tactical/unit/capability/defense/query.js";
import { updateAttackContributions } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
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
const program = (id) => createEffectProgram({
  id,
  initialize: () => ({ coefficient: 0, amount: 0, defense: 0, grouped: true }),
  ownState: (state) => ({ ...state }),
});
const install = (work, resources, program, id, state, source = null) => {
  const result = installEffect(work, 1, resources.effects.create(program.ref, {
    id, source, scopes: [],
  acquiredSequence: id,
  }, state), resources, 0);
  assert.equal(result.result.type, "INSTALLED");
  return result.work;
};
const attackPower = (work, resources) =>
  resolveAttackPower(1, combatWorkView(work), resources.computations);
const entries = (work) => getCombatUnit(work, 1).offense.attack.entries;
const slot = (instance) => instance.state.grouped
  ? { id: "inspiration/attack", strength: instance.state.coefficient }
  : undefined;

test("contribution groups: the ATK coefficient wins, while other facets participate and removal restores the stored loser", () => {
  const resources = new CombatResources();
  const effect = program("stored-inspiration");
  let samples = 0;
  resources.registerEffect(effect, { contributions: [
    attack((instance) => {
      samples += 1;
      return [value(instance.state.amount)];
    }, { group: slot }),
    defense((instance) => [value(instance.state.defense)]),
  ] });
  let work = install(effectFixtureWork(unit(1)), resources, effect, 0,
    { coefficient: 0.3, amount: 300, defense: 10, grouped: true });
  work = install(work, resources, effect, 1,
    { coefficient: 0.6, amount: 60, defense: 20, grouped: true });

  assert.equal(attackPower(work, resources), 160);
  assert.equal(resolveDefense(1, combatWorkView(work)).defense, 30);
  assert.equal(samples, 2);
  assert.deepEqual(entries(work).map((entry) => entry.participating), [true, true]);
  assert.deepEqual(getCombatUnit(work, 1).effects.instances.map((instance) => instance.participating), [true, true]);
  const loserValues = entries(work)[0].values;

  work = removeEffect(work, { type: "EFFECT", unitId: 1, effectId: 1 }, resources, 0);
  assert.equal(attackPower(work, resources), 400);
  assert.equal(resolveDefense(1, combatWorkView(work)).defense, 10);
  assert.equal(entries(work)[0].values, loserValues);
  assert.equal(samples, 2);
});

test("contribution groups: explicit stored state updates refresh strength, samples, and optional group membership", () => {
  const resources = new CombatResources();
  const effect = program("updated-inspiration");
  let samples = 0;
  resources.registerEffect(effect, { contributions: [attack((instance) => {
    samples += 1;
    return [value(instance.state.amount)];
  }, { group: slot })] });
  let work = install(effectFixtureWork(unit(1)), resources, effect, 0,
    { coefficient: 0.3, amount: 300, grouped: true });
  work = install(work, resources, effect, 1,
    { coefficient: 0.6, amount: 60, grouped: true });
  const original = work;

  work = updateEffectState(work, 1, 0, effect.ref,
    (state) => ({ ...state, coefficient: 0.7, amount: 70 }), resources, 0);
  assert.equal(entries(work)[0].group.strength, 0.7);
  assert.equal(attackPower(work, resources), 170);
  assert.equal(attackPower(original, resources), 160);
  assert.equal(samples, 3);

  work = updateEffectState(work, 1, 0, effect.ref,
    (state) => ({ ...state, grouped: false }), resources, 0);
  assert.equal(Object.hasOwn(entries(work)[0], "group"), false);
  assert.equal(attackPower(work, resources), 230);
  assert.equal(samples, 4);
});

test("contribution groups: computed values stay live without reranking, and explicit group updates never compute", () => {
  const resources = new CombatResources();
  const effect = program("computed-inspiration");
  let computes = 0;
  let groupReads = 0;
  resources.registerEffect(effect, { contributions: [computedAttack(({ instance, battlefield }) => {
    computes += 1;
    return [value(resolveAttackPower(instance.source, battlefield) * instance.state.coefficient)];
  }, { group: (instance) => {
    groupReads += 1;
    return slot(instance);
  } })] });
  let work = install(effectFixtureWork(unit(1), unit(2, 1000), unit(3)), resources, effect, 0,
    { coefficient: 0.3, grouped: true }, 2);
  work = install(work, resources, effect, 1,
    { coefficient: 0.6, grouped: true }, 3);
  assert.equal(computes, 0);
  assert.equal(groupReads, 2);
  assert.equal(attackPower(work, resources), 160);
  assert.equal(computes, 1);
  const originalEntries = entries(work);

  work = transitionCombatUnit(work, 3, (provider) => updateAttackContributions(provider, (state) =>
    contribution.register(state, { id: "provider-buff", sequence: 0, participating: true, values: [value(100)] })));
  assert.equal(attackPower(work, resources), 220);
  assert.equal(entries(work), originalEntries);
  assert.equal(groupReads, 2);
  assert.equal(computes, 2);

  const originalRef = entries(work)[0].computeRef;
  work = updateEffectState(work, 1, 0, effect.ref,
    (state) => ({ ...state, coefficient: 0.7 }), resources, 0);
  assert.equal(computes, 2);
  assert.equal(groupReads, 3);
  assert.equal(entries(work)[0].group.strength, 0.7);
  assert.equal(entries(work)[0].computeRef, originalRef);
  assert.equal(attackPower(work, resources), 800);

  work = setEffectEnabled(work, { type: "EFFECT", unitId: 1, effectId: 0 }, false, resources, 0);
  const beforeUpdate = computes;
  work = updateEffectState(work, 1, 0, effect.ref,
    (state) => ({ ...state, grouped: false }), resources, 0);
  assert.equal(computes, beforeUpdate);
  assert.equal(entries(work)[0].participating, false);
  assert.equal(entries(work)[0].computeRef, originalRef);
  assert.equal(Object.hasOwn(entries(work)[0], "group"), false);
  assert.equal(attackPower(work, resources), 220);
});

test("contribution groups: static declarations and dynamic results have immutable ownership", () => {
  for (const computed of [false, true]) {
    const resources = new CombatResources();
    const effect = program(`owned-groups-${computed}`);
    const fixed = { id: "fixed", strength: 1 };
    let returned;
    const factory = computed
      ? (options) => computedAttack(() => [value(10)], options)
      : (options) => attack(() => [value(10)], options);
    resources.registerEffect(effect, { contributions: [
      factory({ id: "fixed", group: fixed }),
      factory({ id: "dynamic", group: (instance) => {
        returned = { id: "dynamic", strength: instance.state.coefficient };
        return returned;
      } }),
    ] });
    fixed.id = "caller-edit";
    fixed.strength = 99;
    let work = install(effectFixtureWork(unit(1)), resources, effect, 0,
      { coefficient: 2, grouped: true });
    const initialGroup = entries(work)[1].group;
    assert.deepEqual(entries(work)[0].group, { id: "fixed", strength: 1 });
    assert.deepEqual(initialGroup, { id: "dynamic", strength: 2 });
    assert.notEqual(initialGroup, returned);
    assert.equal(Object.isFrozen(initialGroup), true);
    returned.id = "caller-edit";
    returned.strength = 99;
    assert.deepEqual(initialGroup, { id: "dynamic", strength: 2 });

    work = updateEffectState(work, 1, 0, effect.ref,
      (state) => ({ ...state, coefficient: 3 }), resources, 0);
    const updatedGroup = entries(work)[1].group;
    returned.strength = 999;
    assert.deepEqual(entries(work)[0].group, { id: "fixed", strength: 1 });
    assert.deepEqual(updatedGroup, { id: "dynamic", strength: 3 });
    assert.deepEqual(initialGroup, { id: "dynamic", strength: 2 });
    assert.notEqual(updatedGroup, returned);
    assert.equal(Object.isFrozen(updatedGroup), true);
  }
});
