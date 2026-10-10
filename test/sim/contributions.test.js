import { fixtureBattlefield } from "../helpers/battlefield.js";
import { attack, liveAttack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import { liveResistance } from "../../dist/core/tactical/unit/capability/defense/contributions.js";
import { installFixtureEffect } from "../helpers/effects.js";
import { updateEffectState } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import * as modifier from "../../dist/core/tactical/modifier/value.js";
import * as contribution from "../../dist/core/tactical/modifier/contribution.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { copyUnitSnapshot } from "../../dist/core/tactical/unit/snapshot.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import {
  updateAttackContributions,
  resolveOffenseAttack,
} from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import {
  createDefenseDefinition,
  updateResistanceContributions,
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

test("contributions: ownership isolates nested inputs and snapshots share frozen entries", () => {
  const owner = { unitId: 1, instanceId: 2 };
  const group = { id: "attack", strength: 3 };
  const sample = { addition: 0, multiplier: 0, finalAddition: 10, finalScaler: 1 };
  const values = [sample];
  const input = { id: "sample", sequence: 0, kind: "SAMPLED", participating: true, owner, group, values };
  const entries = [input];
  const state = contribution.create(entries);
  const entry = state.entries[0];
  owner.unitId = 9;
  group.strength = 90;
  sample.finalAddition = 100;
  values.push(value(1000));
  input.participating = false;
  entries.length = 0;
  assert.deepEqual(entry.owner, { unitId: 1, instanceId: 2 });
  assert.deepEqual(entry.group, { id: "attack", strength: 3 });
  assert.deepEqual(entry.values, [value(10)]);
  assert.equal(entry.kind, "SAMPLED");
  assert.equal(Object.hasOwn(entry, "evaluator"), false);
  assert.equal(entry.participating, true);
  for (const owned of [state, state.entries, entry, entry.owner, entry.group, entry.values, entry.values[0]]) {
    assert.equal(Object.isFrozen(owned), true);
  }
  const snapshot = contribution.copy(state);
  assert.equal(snapshot.entries, state.entries);
  assert.equal(Object.isFrozen(snapshot), true);
});

test("contributions: participation changes share existing owner, group, and samples", () => {
  const state = contribution.create([
    {
      id: "sample",
      sequence: 0,
      kind: "SAMPLED",
      participating: true,
      owner: { unitId: 1, instanceId: 2 },
      group: { id: "attack", strength: 3 },
      values: [value(10)],
    },
    { id: "provider", sequence: 1, kind: "LIVE", participating: true, evaluator: "live" },
  ]);
  const initial = state.entries[0];
  const paused = contribution.setParticipation(state, "sample", false);
  const entry = paused.entries[0];
  assert.notEqual(entry, initial);
  assert.equal(entry.owner, initial.owner);
  assert.equal(entry.group, initial.group);
  assert.equal(entry.values, initial.values);
  assert.equal(paused.entries[1], state.entries[1]);
  assert.equal(initial.participating, true);
  assert.equal(entry.participating, false);
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(Object.isFrozen(paused.entries), true);
  assert.equal(contribution.setParticipation(paused, "sample", false), paused);
  assert.equal(contribution.setParticipation(paused, "missing", false), paused);
  const providerPaused = contribution.setParticipation(paused, "provider", false);
  assert.equal(providerPaused.entries[1].evaluator, "live");
  assert.equal(providerPaused.entries[0], entry);
});

test("contributions: callback updates own new payloads and share untouched payloads", () => {
  const state = contribution.create([
    {
      id: "sample",
      sequence: 0,
      kind: "SAMPLED",
      participating: true,
      owner: { unitId: 1, instanceId: 2 },
      group: { id: "attack", strength: 3 },
      values: [value(10)],
    },
  ]);
  const reordered = contribution.update(state, "sample", (entry) => ({ ...entry, sequence: 1 }));
  assert.equal(reordered.entries[0].owner, state.entries[0].owner);
  assert.equal(reordered.entries[0].group, state.entries[0].group);
  assert.equal(reordered.entries[0].values, state.entries[0].values);
  const owner = { unitId: 3, instanceId: 4 };
  const group = { id: "replacement", strength: 5 };
  const sample = { addition: 0, multiplier: 0, finalAddition: 20, finalScaler: 1 };
  const values = [sample];
  const updated = contribution.update(reordered, "sample", (entry) => ({
    ...entry, owner, group, values,
  }));
  owner.instanceId = 100;
  group.id = "mutated";
  sample.finalAddition = 200;
  values.length = 0;
  assert.deepEqual(updated.entries[0].owner, { unitId: 3, instanceId: 4 });
  assert.deepEqual(updated.entries[0].group, { id: "replacement", strength: 5 });
  assert.deepEqual(updated.entries[0].values, [value(20)]);
  assert.deepEqual(state.entries[0].values, [value(10)]);
  for (const owned of [updated.entries[0], updated.entries[0].owner, updated.entries[0].group,
    updated.entries[0].values, updated.entries[0].values[0]]) {
    assert.equal(Object.isFrozen(owned), true);
  }
  assert.throws(
    () => contribution.update(updated, "sample", (entry) => ({ ...entry, id: "replacement" })),
    /cannot replace its identity/,
  );
});

test("contributions: registration preserves unique identities and removal preserves remaining entries", () => {
  const entry = {
    id: "first", sequence: 0, kind: "SAMPLED", participating: true,
    owner: { unitId: 1, instanceId: 2 }, values: [value(10)],
  };
  const state = contribution.create([entry]);
  assert.throws(() => contribution.create([entry, entry]), /duplicate numeric contribution/);
  assert.throws(() => contribution.register(state, entry), /duplicate numeric contribution/);
  const registered = contribution.register(state, {
    id: "second", sequence: 1, kind: "SAMPLED", participating: true,
    owner: { unitId: 3, instanceId: 4 }, values: [value(20)],
  });
  assert.equal(registered.entries[0], state.entries[0]);
  for (const remaining of [contribution.remove(registered, "first"),
    contribution.removeOwnedBy(registered, { unitId: 1, instanceId: 2 })]) {
    assert.equal(remaining.entries[0], registered.entries[1]);
    assert.equal(Object.isFrozen(remaining), true);
    assert.equal(Object.isFrozen(remaining.entries), true);
    assert.equal(contribution.copy(remaining).entries, remaining.entries);
  }
  assert.equal(contribution.remove(registered, "missing"), registered);
  assert.equal(contribution.removeOwnedBy(registered, { unitId: 9, instanceId: 9 }), registered);
});

test("contributions: new payloads retain nonempty identities, dense arrays, and numeric constraints", () => {
  const entry = { id: "sample", sequence: 0, kind: "SAMPLED", participating: true, values: [value(10)] };
  const state = contribution.create([entry]);
  for (const patch of [
    { sequence: -1 },
    { owner: { unitId: 1, instanceId: 0.5 } },
    { group: { id: "", strength: 1 } },
    { group: { id: "group", strength: Infinity } },
    { values: [value(10), , value(20)] },
    { values: [{ ...value(10), addition: NaN }] },
  ]) {
    assert.throws(() => contribution.update(state, "sample", (current) => ({ ...current, ...patch })));
  }
  assert.throws(() => contribution.register(state, { ...entry, id: "" }), /identity must be nonempty/);
  assert.throws(() => contribution.create([entry, , entry]), /entries must be dense/);
  assert.throws(() => contribution.register(state, {
    id: "provider", sequence: 0, kind: "LIVE", participating: true, evaluator: "",
  }), /provider identity must be nonempty/);
});

test("contributions: samples retain one owner and survive participation changes and copies", () => {
  const resources = new CombatResources();
  const initial = unit(1);
  const sampled = updateAttackContributions(initial, (state) =>
    contribution.register(state, {
      id: "inspiration",
      sequence: 0,
      kind: "SAMPLED",
      participating: true,
      values: [value(150)],
    }),
  );
  const work = workFor(sampled);
  assert.equal(resolveAttackPower(1, battlefieldView(work)), 250);

  transitionUnit(work, 1, (current) =>
    updateAttackContributions(current, (state) =>
      contribution.setParticipation(state, "inspiration", false),
    ));
  assert.equal(resolveAttackPower(1, battlefieldView(work), resources.computations), 100);

  transitionUnit(work, 1, (current) =>
    updateAttackContributions(current, (state) =>
      contribution.setParticipation(state, "inspiration", true),
    ));
  assert.equal(resolveAttackPower(1, battlefieldView(work), resources.computations), 250);
  const copied = copyUnitSnapshot(getUnit(work, 1));
  assert.equal(copied.offense.attack.entries, getUnit(work, 1).offense.attack.entries);
  assert.equal(resolveAttackPower(1, battlefieldView(workFor(copied)), resources.computations), 250);
  const resumedSnapshot = work.battlefield.snapshot("draft");
  transitionUnit(work, 1, (current) =>
    updateAttackContributions(current, (state) =>
      contribution.update(state, "inspiration", (entry) => ({
        ...entry,
        values: [value(200)],
      })),
    ),
  );
  assert.equal(resolveAttackPower(1, battlefieldView(work), resources.computations), 300);
  assert.equal(resolveAttackPower(1, resumedSnapshot, resources.computations), 250);
});

test("contributions: private stack transitions publish maintained projections immediately", () => {
  const resources = new CombatResources();
  const program = createEffectProgram({
    id: "stacks",
    initialize: () => ({ layers: 2, remaining: 20 }),
    ownState: (value) => ({ ...value }),
  });
  resources.registerEffect(program, {
    contributions: [attack((instance) => [value(instance.state.layers * 10)])],
  });
  const installed = installFixtureEffect(
    unit(1),
    resources.effects.create(program.ref, metadata()),
    resources,
  );
  const initial = workFor(installed);
  const original = initial.battlefield.snapshot("draft");

  updateEffectState(initial, 1, 0, program.ref, (current) => ({ ...current, remaining: 10 }), resources, 0);

  updateEffectState(initial, 1, 0, program.ref, (current) => ({ ...current, layers: current.layers + 1 }), resources, 0);
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
        resources.effects.restore(program.ref, {
          ...getUnit(initial, 1).effects.instances[0],
          scopes: [{ type: "TICK", tick: 1 }],
        }),
      ],
    },
  };
  const expiredState = workFor(expiring);

  prepareCombatEffects(expiredState, 1, resources);
  assert.equal(resolveAttackPower(1, battlefieldView(expiredState), resources.computations), 100);
  assert.deepEqual(getUnit(expiredState, 1).offense.attack.entries, []);
});

test("contributions: live evaluation reads latest working facts without changing contribution entries", () => {
  const resources = new CombatResources();
  const program = createEffectProgram({ id: "live", initialize: () => ({}), ownState: () => ({}) });
  resources.registerEffect(program, {
    contributions: [liveAttack(({ unit }) => [value(unit.vitality.hp < 50 ? 100 : 0)])],
  });
  const installed = installFixtureEffect(
    unit(1),
    resources.effects.create(program.ref, metadata()),
    resources,
  );
  const initial = workFor(installed);
  const original = initial.battlefield.snapshot("draft");

  assert.equal(installed.offense.attack.entries[0].kind, "LIVE");
  assert.equal(Object.hasOwn(installed.offense.attack.entries[0], "values"), false);
  transitionUnit(initial, 1, (current) => ({
    ...current,
    vitality: { ...current.vitality, hp: 30 },
  }));
  assert.equal(resolveAttackPower(1, battlefieldView(initial), resources.computations), 200);
  assert.equal(resolveAttackPower(1, original, resources.computations), 100);
  assert.equal(getUnit(initial, 1).offense.attack.entries, installed.offense.attack.entries);
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
        defended = updateResistanceContributions(initial, (state) =>
          contribution.register(state, {
            id: "resistance",
            sequence: 0,
            kind: "SAMPLED",
            participating: true,
            values: [value(amount)],
          }),
        );
      } else {
        const program = resources.registerEffect(
          createEffectProgram({
            id: "resistance-provider",
            initialize: () => ({}),
            ownState: () => ({}),
          }),
          { contributions: [liveResistance(() => [value(amount)])] },
        );
        defended = installFixtureEffect(
          initial,
          resources.effects.create(program.ref, metadata()),
          resources,
        );
      }

      const facts = battlefieldView(workFor(defended));
      const state = defended.defense.resistance;
      const entries = state.entries;
      const numeric = contribution.resolve(
        state,
        resources.computations.bind({ unit: defended, battlefield: facts }),
      );

      assert.equal(modifier.apply(30, numeric), 30 + amount);
      assert.deepEqual(resolveDefense(1, facts, resources.computations), {
        defense: 200,
        resistance: expected,
      });
      assert.equal(defended.definition.defense.resistance, 30);
      assert.equal(defended.defense.resistance, state);
      assert.equal(state.entries, entries);
    }
  }
});

test("contributions: a sampled child retains its input until an explicit parent refresh", () => {
  const resources = new CombatResources();
  const parentProgram = resources.registerEffect(
    createEffectProgram({ id: "refresh-parent", initialize: () => ({}), ownState: () => ({}) }),
  );
  const childProgram = resources.registerEffect(
    createEffectProgram({
      id: "sampled-child",
      initialize: () => ({ sample: 0 }),
      ownState: (input) => ({ ...input }),
    }),
    {
      contributions: [attack((instance) => [value(instance.state.sample)])],
      lifecycle: {
        start: (context) => {
          const source = context.facts.getUnit(1);
          const sample = resolveOffenseAttack(source.definition.offense, source.offense) * 0.5;
          context.effects.update(context.ref, childProgram.ref, () => ({ sample }));
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
    resources.effects.create(parentProgram.ref, metadata(0)),
    resources,
    0,
  );
  installEffect(
    work,
    2,
    resources.effects.create(childProgram.ref, metadata(1)),
    resources,
    0,
  );
  bindEffectLifetime(work, first, parent);
  assert.equal(resolveAttackPower(2, battlefieldView(work)), 650);
  transitionUnit(work, 1, (current) =>
    updateAttackContributions(current, (state) =>
      contribution.register(state, {
        id: "source-change",
        sequence: 0,
        kind: "SAMPLED",
        participating: true,
        values: [value(100)],
      }),
    ),
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
    resources.effects.create(childProgram.ref, metadata(2)),
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
  assert.deepEqual(getUnit(work, 2).offense.attack.entries, []);
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
