import { fixtureBattlefield } from "../helpers/battlefield.js";
import { attack, liveAttack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import { liveResistance } from "../../dist/core/tactical/unit/capability/defense/contributions.js";
import { installFixtureEffect } from "../helpers/effects.js";
import { updateEffectState } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEffectDefinition } from "../../dist/core/tactical/unit/capability/effects/definition.js";
import * as modifier from "../../dist/core/tactical/contribution/value.js";
import * as contribution from "../../dist/core/tactical/contribution/contribution.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { copyUnitSnapshot } from "../../dist/core/tactical/unit/snapshot.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import {
  setAttackContribution,
  removeAttackContribution,
  resolveOffenseAttack,
} from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import {
  createDefenseDefinition,
  setResistanceContribution,
} from "../../dist/core/tactical/unit/capability/defense/capability.js";
import { resolveDefense } from "../../dist/core/tactical/unit/capability/defense/query.js";
import {
  battlefieldView,
  createBattleState,
  getUnit,
  registerUnit,
  transitionUnit,
  removeUnit,
} from "../../dist/core/tactical/battle/execution/context.js";
import { prepareCombatEffects } from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";
import {
  installEffect,
  setEffectEnabled,
  finishEffects,
  finalizeEffect,
  bindEffectLifetime,
} from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";

const unit = (id, attack = 100) =>
  initializeUnit({
    id,
    definition: { id: `unit-${id}`, offense: { attack }, vitality: { maxHp: 100 } },
    position: [0, 0],
  });
const workFor = (...units) => {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  return createBattleState(fixtureBattlefield({
    unitIds: [...byId.keys()],
    getUnit: (id) => byId.get(id),
    blockerOf: () => undefined,
    blockedBy: () => [],
  }));
};
const value = (amount) => modifier.create({ finalAddition: amount });
const metadata = (id = 0) => ({
  id,
  source: null,
  scopes: [],
  acquiredSequence: id,
});

test("contributions: set and remove preserve immutable arrays and shared values", () => {
  const group = { id: "attack", priority: 3 };
  const values = [value(10)];
  const input = { id: "sample", value: values, group };
  const baseline = [];
  const entries = contribution.set(baseline, input);
  assert.deepEqual(baseline, []);
  assert.equal(entries[0], input);
  assert.equal(entries[0].group, group);
  assert.equal(entries[0].value, values);
  assert.equal(contribution.set(entries, input), entries);
  assert.equal(contribution.remove(entries, "missing"), entries);
  assert.deepEqual(contribution.remove(entries, "sample"), []);
  assert.equal(entries[0], input);
});

test("contributions: set replaces a matching identity and shares unrelated entries", () => {
  const first = { id: "first", value: [value(10)] };
  const second = { id: "second", value: [value(20)] };
  const baseline = contribution.set(contribution.set([], first), second);
  const replacement = { id: "first", value: [value(30)] };
  const updated = contribution.set(baseline, replacement);
  assert.equal(updated.length, 2);
  assert.equal(updated[0], replacement);
  assert.equal(updated[1], second);
  assert.equal(baseline[0], first);
  assert.equal(contribution.remove(updated, "first")[0], second);
});

test("contributions: group priority and ID ties are independent of insertion order", () => {
  const entries = [
    { id: "effect/2", group: { id: "shared", priority: 2 }, value: [value(20)] },
    { id: "effect/10", group: { id: "shared", priority: 2 }, value: [value(10)] },
    { id: "strong", group: { id: "shared", priority: 3 }, value: [value(30)] },
    { id: "independent", value: [value(5)] },
  ];
  assert.deepEqual(contribution.resolve(entries), [value(5), value(30)]);
  const fallback = contribution.remove(entries, "strong");
  assert.deepEqual(contribution.resolve(fallback), [value(10), value(5)]);
  assert.deepEqual(contribution.resolve([...fallback].reverse()), contribution.resolve(fallback));
  assert.equal(fallback.length, 3);
});

test("contributions: winners alone evaluate and effective modifiers follow ID order", () => {
  const calls = [];
  const context = { amount: 7 };
  const entries = [
    { id: "z", value: input => { calls.push(input); return [value(input.amount)]; } },
    { id: "loser", group: { id: "shared", priority: 0 }, value: () => { throw new Error("loser evaluated"); } },
    { id: "a", group: { id: "shared", priority: 1 }, value: [value(3)] },
  ];
  assert.deepEqual(contribution.resolve(entries, input => contribution.evaluate(input, context)), [value(3), value(7)]);
  assert.deepEqual(calls, [context]);
  assert.equal(contribution.evaluate(entries[2].value, context), entries[2].value);
});

test("contributions: capability set, remove and replacement preserve prior snapshots", () => {
  const initial = unit(1);
  const sample = { id: "inspiration", value: [value(150)] };
  const sampled = setAttackContribution(initial, sample);
  const work = workFor(sampled);
  assert.equal(resolveAttackPower(1, battlefieldView(work)), 250);
  transitionUnit(work, 1, current => removeAttackContribution(current, "inspiration"));
  assert.equal(resolveAttackPower(1, battlefieldView(work)), 100);
  transitionUnit(work, 1, current => setAttackContribution(current, sample));
  assert.equal(resolveAttackPower(1, battlefieldView(work)), 250);
  const copied = copyUnitSnapshot(getUnit(work, 1));
  assert.equal(copied.offense.attack, getUnit(work, 1).offense.attack);
  const resumedSnapshot = work.battlefield.snapshot("draft");
  transitionUnit(work, 1, current => setAttackContribution(current, { id: "inspiration", value: [value(200)] }));
  assert.equal(resolveAttackPower(1, battlefieldView(work)), 300);
  assert.equal(resolveAttackPower(1, resumedSnapshot), 250);
});

test("contributions: direct capability closures read current facts and retain previous snapshots", () => {
  const initial = setAttackContribution(unit(1), {
    id: "dynamic", value: ({ unit }) => [value(unit.vitality.hp < 50 ? 100 : 0)],
  });
  const work = workFor(initial);
  const original = work.battlefield.snapshot("draft");
  assert.equal(resolveAttackPower(1, original), 100);
  transitionUnit(work, 1, current => ({ ...current, vitality: { ...current.vitality, hp: 30 } }));
  assert.equal(resolveAttackPower(1, battlefieldView(work)), 200);
  assert.equal(resolveAttackPower(1, original), 100);
  assert.equal(getUnit(work, 1).offense.attack, initial.offense.attack);
});

test("contributions: private stack transitions publish maintained projections immediately", () => {
  const resources = new CombatResources();
  const program = createEffectDefinition({
    id: "stacks",
    initialize: () => ({ layers: 2, remaining: 20 }),
  });
  resources.registerEffect(program, {
    contributions: [attack((instance) => [value(instance.state.layers * 10)])],
  });
  const installed = installFixtureEffect(
    unit(1),
    resources.effects.create(program, metadata()),
    resources,
  );
  const initial = workFor(installed);
  const original = initial.battlefield.snapshot("draft");

  updateEffectState(initial, 1, 0, program, (current) => ({ ...current, remaining: 10 }), resources, 0);

  updateEffectState(initial, 1, 0, program, (current) => ({ ...current, layers: current.layers + 1 }), resources, 0);
  assert.equal(resolveAttackPower(1, battlefieldView(initial)), 130);
  assert.deepEqual(getUnit(initial, 1).effects.instances[0].state, {
    layers: 3,
    remaining: 10,
  });
  assert.equal(resolveAttackPower(1, original), 120);
  const expiring = {
    ...getUnit(initial, 1),
    effects: {
      ...getUnit(initial, 1).effects,
      instances: [
        resources.effects.restore(program, {
          ...getUnit(initial, 1).effects.instances[0],
          scopes: [{ type: "TICK", tick: 1 }],
        }),
      ],
    },
  };
  const expiredState = workFor(expiring);

  prepareCombatEffects(expiredState, 1, resources);
  assert.equal(resolveAttackPower(1, battlefieldView(expiredState)), 100);
  assert.deepEqual(getUnit(expiredState, 1).offense.attack, []);
});

test("contributions: live evaluation reads latest working facts without changing contribution entries", () => {
  const resources = new CombatResources();
  const program = createEffectDefinition({ id: "live", initialize: () => ({}) });
  resources.registerEffect(program, {
    contributions: [liveAttack(({ unit }) => [value(unit.vitality.hp < 50 ? 100 : 0)])],
  });
  const installed = installFixtureEffect(
    unit(1),
    resources.effects.create(program, metadata()),
    resources,
  );
  const initial = workFor(installed);
  const original = initial.battlefield.snapshot("draft");

  assert.equal(typeof installed.offense.attack[0].value, "function");
  transitionUnit(initial, 1, (current) => ({
    ...current,
    vitality: { ...current.vitality, hp: 30 },
  }));
  assert.equal(resolveAttackPower(1, battlefieldView(initial)), 200);
  assert.equal(resolveAttackPower(1, original), 100);
  assert.equal(getUnit(initial, 1).offense.attack, installed.offense.attack);
});

test("contributions: defense queries clamp resistance after sampled and live contributions without clipping numeric state", () => {
  for (const mode of ["sampled", "live"]) {
    for (const [amount, expected] of [[0, 30], [10, 40], [-10, 20], [-50, 0], [90, 100]]) {
      const resources = new CombatResources();
      const initial = initializeUnit({
        id: 1,
        definition: {
          id: "defended-unit",
          defense: createDefenseDefinition({ defense: 200, resistance: 30 }),
        },
        position: [0, 0],
      });
      let defended;

      if (mode === "sampled") {
        defended = setResistanceContribution(initial, { id: "resistance", value: [value(amount)] });
      } else {
        const program = resources.registerEffect(
          createEffectDefinition({
            id: "resistance-provider",
            initialize: () => ({}),
          }),
          { contributions: [liveResistance(() => [value(amount)])] },
        );
        defended = installFixtureEffect(
          initial,
          resources.effects.create(program, metadata()),
          resources,
        );
      }

      const facts = battlefieldView(workFor(defended));
      const state = defended.defense.resistance;
      const entries = state;
      const numeric = contribution.resolve(
        state,
        input => contribution.evaluate(input, { unit: defended, battlefield: facts }),
      );

      assert.equal(modifier.apply(30, numeric), 30 + amount);
      assert.deepEqual(resolveDefense(1, facts), {
        defense: 200,
        resistance: expected,
      });
      assert.equal(defended.definition.defense.resistance, 30);
      assert.equal(defended.defense.resistance, state);
      assert.equal(state, entries);
    }
  }
});

test("contributions: a sampled child retains its input until an explicit parent refresh", () => {
  const resources = new CombatResources();
  const parentProgram = resources.registerEffect(
    createEffectDefinition({ id: "refresh-parent", initialize: () => ({}) }),
  );
  const childProgram = resources.registerEffect(
    createEffectDefinition({
      id: "sampled-child",
      initialize: () => ({ sample: 0 }),
    }),
    {
      contributions: [attack((instance) => [value(instance.state.sample)])],
      lifecycle: {
        start: (context) => {
          const source = context.facts.getUnit(1);
          const sample = resolveOffenseAttack(source.definition.offense, source.offense, { unit: source, battlefield: context.facts }) * 0.5;
          context.effects.update(context.ref, childProgram, () => ({ sample }));
        },
      },
    },
  );

  const work = workFor(unit(1, 300), unit(2, 500));
  const parent = { type: "EFFECT", unitId: 2, effectId: 0 };
  const first = { type: "EFFECT", unitId: 2, effectId: 1 };
  installEffect(
    work,
    2,
    resources.effects.create(parentProgram, metadata(0)),
    resources,
    0,
  );
  installEffect(
    work,
    2,
    resources.effects.create(childProgram, metadata(1)),
    resources,
    0,
  );
  bindEffectLifetime(work, first, parent);
  assert.equal(resolveAttackPower(2, battlefieldView(work)), 650);
  transitionUnit(work, 1, (current) =>
    setAttackContribution(current, { id: "source-change", value: [value(100)] }),
  );
  assert.equal(resolveAttackPower(2, battlefieldView(work)), 650);

  setEffectEnabled(work, first, false, resources, 1);
  assert.equal(resolveAttackPower(2, battlefieldView(work)), 500);
  assert.deepEqual(getUnit(work, 2).effects.instances[1].state, { sample: 150 });
  setEffectEnabled(work, first, true, resources, 1);
  assert.equal(resolveAttackPower(2, battlefieldView(work)), 650);
  finishEffects(work, [first], resources, 2);
  assert.equal(resolveAttackPower(2, battlefieldView(work)), 500);
  const second = { type: "EFFECT", unitId: 2, effectId: 2 };
  installEffect(
    work,
    2,
    resources.effects.create(childProgram, metadata(2)),
    resources,
    2,
  );
  bindEffectLifetime(work, second, parent);
  assert.deepEqual(
    getUnit(work, 2).effects.instances.map((instance) => instance.id),
    [0, 2],
  );
  assert.equal(resolveAttackPower(2, battlefieldView(work)), 700);
  assert.deepEqual(getUnit(work, 2).effects.instances[1].state, { sample: 200 });
  const copied = copyUnitSnapshot(getUnit(work, 2));
  assert.equal(resolveAttackPower(2, battlefieldView(workFor(copied))), 700);
  finishEffects(work, [parent], resources, 3);
  assert.equal(resolveAttackPower(2, battlefieldView(work)), 500);
  finalizeEffect(work, second, resources, 3);
  assert.deepEqual(getUnit(work, 2).offense.attack, []);
});

test("battle state: registration and removal facts survive a draft with no final entities", () => {
  const initial = workFor();

  registerUnit(initial, unit(1));

  transitionUnit(initial, 1, (current) => ({ ...current, position: [1, 0] }));

  removeUnit(initial, 1, "SCRIPT");
  assert.deepEqual(initial.battlefield.snapshot("draft").unitIds, []);
  assert.deepEqual(initial.registeredUnitIds, [1]);
  assert.deepEqual(initial.removedUnits.map(result => [result.unitId, result.unit.position, result.reason]),
    [[1, [1, 0], "SCRIPT"]]);
  let called = false;
  transitionUnit(initial, 1, (current) => {
    called = true;
    return current;
  });
  assert.equal(called, false);
});
