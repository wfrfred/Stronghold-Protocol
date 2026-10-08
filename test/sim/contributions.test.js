import { installFixtureEffect } from "../helpers/effects.js";
import { updateEffectState } from "../../dist/core/tactical/unit/capability/effects/transition.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { createNumericContribution } from "../../dist/core/tactical/modifier/numeric.js";
import {
  createNumericContributionState,
  copyNumericContributionState,
  registerNumericContribution,
  updateNumericContribution,
  setNumericContributionParticipation,
  removeNumericContribution,
  removeNumericContributionsOwnedBy,
} from "../../dist/core/tactical/modifier/contribution.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { copyUnitSnapshot } from "../../dist/core/tactical/unit/snapshot.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import {
  offenseAttackContributions,
  resolveOffenseAttack,
} from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import {
  combatWorkView,
  createCombatWork,
  getCombatUnit,
  registerCombatUnit,
  transitionCombatUnit,
  removeCombatUnit,
  combatWorkChanges,
} from "../../dist/core/tactical/battle/execution/work.js";
import { prepareCombatEffects } from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";
import {
  installEffect,
  setEffectParticipation,
  finishEffect,
  finalizeEffect,
  attachEffectParent,
} from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";

const unit = (id, attack = 100) =>
  initializeUnit({
    id,
    definition: { id: `unit-${id}`, offense: { attack }, vitality: { maxHp: 100 } },
    position: [0, 0],
  });
const workFor = (...units) => {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  return createCombatWork({
    unitIds: [...byId.keys()],
    getUnit: (id) => byId.get(id),
    blockerOf: () => undefined,
    blockedBy: () => [],
  });
};
const value = (amount) => createNumericContribution({ finalAddition: amount });
const metadata = (id = 0) => ({
  id,
  source: null,
  scope: null,
  acquiredSequence: id,
  expiresAtTick: null,
});

test("contributions: ownership isolates nested inputs and snapshots share frozen entries", () => {
  const owner = { unitId: 1, instanceId: 2 };
  const group = { id: "attack", strength: 3 };
  const sample = { addition: 0, multiplier: 0, finalAddition: 10, finalScaler: 1 };
  const values = [sample];
  const input = { id: "sample", sequence: 0, participating: true, owner, group, values };
  const entries = [input];
  const state = createNumericContributionState(entries);
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
  assert.equal(entry.participating, true);
  for (const owned of [state, state.entries, entry, entry.owner, entry.group, entry.values, entry.values[0]]) {
    assert.equal(Object.isFrozen(owned), true);
  }
  const snapshot = copyNumericContributionState(state);
  assert.equal(snapshot.entries, state.entries);
  assert.equal(Object.isFrozen(snapshot), true);
});

test("contributions: participation changes share existing owner, group, and samples", () => {
  const state = createNumericContributionState([
    {
      id: "sample",
      sequence: 0,
      participating: true,
      owner: { unitId: 1, instanceId: 2 },
      group: { id: "attack", strength: 3 },
      values: [value(10)],
    },
    { id: "provider", sequence: 1, participating: true, providerRef: "live" },
  ]);
  const initial = state.entries[0];
  const paused = setNumericContributionParticipation(state, "sample", false);
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
  assert.equal(setNumericContributionParticipation(paused, "sample", false), paused);
  assert.equal(setNumericContributionParticipation(paused, "missing", false), paused);
  const providerPaused = setNumericContributionParticipation(paused, "provider", false);
  assert.equal(providerPaused.entries[1].providerRef, "live");
  assert.equal(providerPaused.entries[0], entry);
});

test("contributions: callback updates own new payloads and share untouched payloads", () => {
  const state = createNumericContributionState([
    {
      id: "sample",
      sequence: 0,
      participating: true,
      owner: { unitId: 1, instanceId: 2 },
      group: { id: "attack", strength: 3 },
      values: [value(10)],
    },
  ]);
  const reordered = updateNumericContribution(state, "sample", (entry) => ({ ...entry, sequence: 1 }));
  assert.equal(reordered.entries[0].owner, state.entries[0].owner);
  assert.equal(reordered.entries[0].group, state.entries[0].group);
  assert.equal(reordered.entries[0].values, state.entries[0].values);
  const owner = { unitId: 3, instanceId: 4 };
  const group = { id: "replacement", strength: 5 };
  const sample = { addition: 0, multiplier: 0, finalAddition: 20, finalScaler: 1 };
  const values = [sample];
  const updated = updateNumericContribution(reordered, "sample", (entry) => ({
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
    () => updateNumericContribution(updated, "sample", (entry) => ({ ...entry, id: "replacement" })),
    /cannot replace its identity/,
  );
});

test("contributions: registration preserves unique identities and removal preserves remaining entries", () => {
  const entry = {
    id: "first", sequence: 0, participating: true,
    owner: { unitId: 1, instanceId: 2 }, values: [value(10)],
  };
  const state = createNumericContributionState([entry]);
  assert.throws(() => createNumericContributionState([entry, entry]), /duplicate numeric contribution/);
  assert.throws(() => registerNumericContribution(state, entry), /duplicate numeric contribution/);
  const registered = registerNumericContribution(state, {
    id: "second", sequence: 1, participating: true,
    owner: { unitId: 3, instanceId: 4 }, values: [value(20)],
  });
  assert.equal(registered.entries[0], state.entries[0]);
  for (const remaining of [removeNumericContribution(registered, "first"),
    removeNumericContributionsOwnedBy(registered, { unitId: 1, instanceId: 2 })]) {
    assert.equal(remaining.entries[0], registered.entries[1]);
    assert.equal(Object.isFrozen(remaining), true);
    assert.equal(Object.isFrozen(remaining.entries), true);
    assert.equal(copyNumericContributionState(remaining).entries, remaining.entries);
  }
  assert.equal(removeNumericContribution(registered, "missing"), registered);
  assert.equal(removeNumericContributionsOwnedBy(registered, { unitId: 9, instanceId: 9 }), registered);
});

test("contributions: new payloads retain nonempty identities, dense arrays, and numeric constraints", () => {
  const entry = { id: "sample", sequence: 0, participating: true, values: [value(10)] };
  const state = createNumericContributionState([entry]);
  for (const patch of [
    { sequence: -1 },
    { owner: { unitId: 1, instanceId: 0.5 } },
    { group: { id: "", strength: 1 } },
    { group: { id: "group", strength: Infinity } },
    { values: [value(10), , value(20)] },
    { values: [{ ...value(10), addition: NaN }] },
  ]) {
    assert.throws(() => updateNumericContribution(state, "sample", (current) => ({ ...current, ...patch })));
  }
  assert.throws(() => registerNumericContribution(state, { ...entry, id: "" }), /identity must be nonempty/);
  assert.throws(() => createNumericContributionState([entry, , entry]), /entries must be dense/);
  assert.throws(() => registerNumericContribution(state, {
    id: "provider", sequence: 0, participating: true, providerRef: "",
  }), /provider identity must be nonempty/);
});

test("contributions: samples retain one owner and survive participation changes and copies", () => {
  const resources = new CombatResources();
  const initial = unit(1);
  const sampled = offenseAttackContributions(initial, (state) =>
    registerNumericContribution(state, {
      id: "inspiration",
      sequence: 0,
      participating: true,
      values: [value(150)],
    }),
  );
  let work = workFor(sampled);
  assert.equal(resolveAttackPower(1, combatWorkView(work)), 250);
  const paused = transitionCombatUnit(work, 1, (current) =>
    offenseAttackContributions(current, (state) =>
      setNumericContributionParticipation(state, "inspiration", false),
    ),
  );
  assert.equal(resolveAttackPower(1, combatWorkView(paused), resources.offense), 100);
  const resumed = transitionCombatUnit(paused, 1, (current) =>
    offenseAttackContributions(current, (state) =>
      setNumericContributionParticipation(state, "inspiration", true),
    ),
  );
  assert.equal(resolveAttackPower(1, combatWorkView(resumed), resources.offense), 250);
  const copied = copyUnitSnapshot(getCombatUnit(resumed, 1));
  assert.equal(copied.offense.attack.entries, getCombatUnit(resumed, 1).offense.attack.entries);
  assert.equal(resolveAttackPower(1, combatWorkView(workFor(copied)), resources.offense), 250);
  work = transitionCombatUnit(resumed, 1, (current) =>
    offenseAttackContributions(current, (state) =>
      updateNumericContribution(state, "inspiration", (entry) => ({
        ...entry,
        values: [value(200)],
      })),
    ),
  );
  assert.equal(resolveAttackPower(1, combatWorkView(work), resources.offense), 300);
  assert.equal(resolveAttackPower(1, combatWorkView(resumed), resources.offense), 250);
});

test("contributions: private stack transitions publish maintained projections immediately", () => {
  const resources = new CombatResources();
  const program = createEffectProgram({
    id: "stacks",
    initialize: () => ({ layers: 2, remaining: 20 }),
    ownState: (value) => ({ ...value }),
  });
  resources.registerEffect(program, {
    contributions: {
      contributions: [
        {
          id: "attack",
          target: offenseAttackContributions,
          project: (instance) => [value(instance.state.layers * 10)],
        },
      ],
    },
  });
  const installed = installFixtureEffect(
    unit(1),
    resources.effects.create(program.ref, metadata()),
    resources,
  );
  const initial = workFor(installed);
  const consumed = updateEffectState(
    initial,
    1,
    0,
    program.ref,
    (current) => ({ ...current, remaining: 10 }),
    resources,
  );
  const updated = updateEffectState(
    consumed,
    1,
    0,
    program.ref,
    (current) => ({ ...current, layers: current.layers + 1 }),
    resources,
  );
  assert.equal(resolveAttackPower(1, combatWorkView(updated)), 130);
  assert.deepEqual(getCombatUnit(updated, 1).effects.instances[0].state, {
    layers: 3,
    remaining: 10,
  });
  assert.equal(resolveAttackPower(1, combatWorkView(initial)), 120);
  const expiring = {
    ...getCombatUnit(updated, 1),
    effects: {
      ...getCombatUnit(updated, 1).effects,
      instances: [
        resources.effects.restore(program.ref, {
          ...getCombatUnit(updated, 1).effects.instances[0],
          expiresAtTick: 1,
        }),
      ],
    },
  };
  const expired = prepareCombatEffects(workFor(expiring), 1, resources);
  assert.equal(resolveAttackPower(1, combatWorkView(expired), resources.offense), 100);
  assert.deepEqual(getCombatUnit(expired, 1).offense.attack.entries, []);
});

test("contributions: live provider reads latest working facts without changing stored payloads", () => {
  const resources = new CombatResources();
  const program = createEffectProgram({ id: "live", initialize: () => ({}), ownState: () => ({}) });
  resources.registerEffect(program, {
    contributions: {
      attack: ({ unit }) => [value(unit.vitality.hp < 50 ? 100 : 0)],
    },
  });
  const installed = installFixtureEffect(
    unit(1),
    resources.effects.create(program.ref, metadata()),
    resources,
  );
  const initial = workFor(installed);
  const changed = transitionCombatUnit(initial, 1, (current) => ({
    ...current,
    vitality: { ...current.vitality, hp: 30 },
  }));
  assert.equal(resolveAttackPower(1, combatWorkView(changed), resources.offense), 200);
  assert.equal(resolveAttackPower(1, combatWorkView(initial), resources.offense), 100);
  assert.equal(getCombatUnit(changed, 1).offense.attack.entries, installed.offense.attack.entries);
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
      contributions: {
        contributions: [
          {
            id: "attack",
            target: offenseAttackContributions,
            project: (instance) => [value(instance.state.sample)],
          },
        ],
      },
      lifecycle: {
        start: (context) => {
          const source = context.facts.getUnit(1);
          const sample = resolveOffenseAttack(source.definition.offense, source.offense) * 0.5;
          context.effects.update(context.address, childProgram.ref, () => ({ sample }));
        },
      },
    },
  );

  let work = workFor(unit(1, 300), unit(2, 500));
  const parent = { unitId: 2, instanceId: 0 };
  const first = { unitId: 2, instanceId: 1 };
  work = installEffect(
    work,
    2,
    resources.effects.create(parentProgram.ref, metadata(0)),
    resources,
    0,
  ).work;
  work = installEffect(
    work,
    2,
    resources.effects.create(childProgram.ref, metadata(1)),
    resources,
    0,
  ).work;
  work = attachEffectParent(work, first, parent, resources, 0).work;
  assert.equal(resolveAttackPower(2, combatWorkView(work)), 650);
  work = transitionCombatUnit(work, 1, (current) =>
    offenseAttackContributions(current, (state) =>
      registerNumericContribution(state, {
        id: "source-change",
        sequence: 0,
        participating: true,
        values: [value(100)],
      }),
    ),
  );
  assert.equal(resolveAttackPower(2, combatWorkView(work)), 650);
  const paused = setEffectParticipation(work, first, false, resources, 1);
  assert.equal(resolveAttackPower(2, combatWorkView(paused)), 500);
  assert.deepEqual(getCombatUnit(paused, 2).effects.instances[1].state, { sample: 150 });
  work = setEffectParticipation(paused, first, true, resources, 1);
  assert.equal(resolveAttackPower(2, combatWorkView(work)), 650);
  work = finishEffect(work, first, resources, 2);
  assert.equal(resolveAttackPower(2, combatWorkView(work)), 500);
  const second = { unitId: 2, instanceId: 2 };
  work = installEffect(
    work,
    2,
    resources.effects.create(childProgram.ref, metadata(2)),
    resources,
    2,
  ).work;
  work = attachEffectParent(work, second, parent, resources, 2).work;
  assert.deepEqual(
    getCombatUnit(work, 2).effects.instances.map((instance) => instance.id),
    [0, 2],
  );
  assert.equal(resolveAttackPower(2, combatWorkView(work)), 700);
  assert.deepEqual(getCombatUnit(work, 2).effects.instances[1].state, { sample: 200 });
  const copied = copyUnitSnapshot(getCombatUnit(work, 2));
  assert.equal(resolveAttackPower(2, combatWorkView(workFor(copied))), 700);
  work = finishEffect(work, parent, resources, 3);
  assert.equal(resolveAttackPower(2, combatWorkView(work)), 500);
  work = finalizeEffect(work, second, resources, 3);
  assert.deepEqual(getCombatUnit(work, 2).offense.attack.entries, []);
});

test("combat work: actual create/remove results outlive the empty net diff", () => {
  const initial = workFor();
  const born = registerCombatUnit(initial, unit(1));
  const moved = transitionCombatUnit(born, 1, (current) => ({ ...current, position: [1, 0] }));
  const ended = removeCombatUnit(moved, 1, "SCRIPT");
  assert.deepEqual(combatWorkChanges(ended), []);
  assert.deepEqual(
    ended.lifecycleResults.map((result) => [result.type, result.unit.position]),
    [
      ["CREATED", [0, 0]],
      ["REMOVED", [1, 0]],
    ],
  );
  let called = false;
  assert.equal(
    transitionCombatUnit(ended, 1, (current) => {
      called = true;
      return current;
    }),
    ended,
  );
  assert.equal(called, false);
});
