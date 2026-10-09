import { attack, computedAttack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import { computedDefense } from "../../dist/core/tactical/unit/capability/defense/contributions.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { combatWorkView, getCombatUnit } from "../../dist/core/tactical/battle/execution/work.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { EffectResources } from "../../dist/core/tactical/unit/capability/effects/registry.js";
import { EffectDispatchScope } from "../../dist/core/tactical/unit/capability/effects/dispatch.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import {
  compileStoredBinding,
  compileComputedBinding,
} from "../../dist/core/tactical/unit/capability/effects/binding.js";
import * as modifier from "../../dist/core/tactical/modifier/value.js";
import { updateAttackContributions } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { removeEffect, setEffectEnabled } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { updateEffectState } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { compileStatusBinding } from "../../dist/core/tactical/unit/capability/status/binding.js";
import { hasStatusFlag } from "../../dist/core/tactical/unit/capability/status/capability.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";
import { effectFixtureWork, installFixtureEffect } from "../helpers/effects.js";

const program = (id) => createEffectProgram({
  id,
  initialize: () => ({ value: 1 }),
  ownState: (state) => ({ ...state }),
});
const metadata = {
  id: 0,
  acquiredSequence: 0,
  source: null,
  scopes: [],
};
const unit = () => initializeUnit({
  id: 2,
  position: [0, 0],
  definition: { id: "registration-fixture", status: { initialFlags: [] } },
});
const spec = () => createLegacyCombatSpec({
  rows: 1,
  columns: 1,
  operators: [],
  enemies: [],
  maxTicks: 1,
  seed: 17,
});

test("resources: direct binding registration owns its array and operation descriptors", () => {
  const resources = new CombatResources();
  const descriptor = resources.effects.register(program("direct-binding"));
  const binding = { ...compileStatusBinding(["INVINCIBLE"]) };
  const bindings = [binding];
  resources.effectBindings.register(descriptor.ref, bindings);
  const instance = resources.effects.create(descriptor.ref, metadata);
  const registered = resources.effectBindings.get(instance);

  bindings.length = 0;
  binding.install = (owner) => owner;

  assert.equal(registered.length, 1);
  assert.notEqual(registered[0], binding);
  assert.equal(Object.isFrozen(registered), true);
  assert.equal(Object.isFrozen(registered[0]), true);
  assert.throws(() => registered.pop(), TypeError);
  const installed = installFixtureEffect(unit(), instance, resources);
  assert.equal(hasStatusFlag(installed, "INVINCIBLE"), true);
});

test("resources: caller edits cannot change binding participation or removal after installation", () => {
  const resources = new CombatResources();
  const binding = { ...compileStatusBinding(["INVINCIBLE"]) };
  const descriptor = resources.registerEffect(program("owned-binding"), { bindings: [binding] });
  const installed = installFixtureEffect(
    unit(), resources.effects.create(descriptor.ref, metadata), resources,
  );
  assert.equal(hasStatusFlag(installed, "INVINCIBLE"), true);

  binding.setParticipation = (owner) => owner;
  binding.remove = (owner) => owner;
  const removed = removeEffect(
    effectFixtureWork(installed), { type: "EFFECT", unitId: 2, effectId: 0 }, resources, 0,
  );
  assert.equal(hasStatusFlag(getCombatUnit(removed, 2), "INVINCIBLE"), false);
  assert.deepEqual(getCombatUnit(removed, 2).effects.instances, []);
});

test("resources: binding compilers capture configuration values rather than caller-owned objects", () => {
  for (const kind of ["provider", "projection"]) {
    const resources = new CombatResources();
    const sample = () => [modifier.create({ finalAddition: 20 })];
    const configuration = {
      id: "sample",
      target: updateAttackContributions,
      group: { id: "original-group", strength: 1 },
      computeRef: "sample/attack",
      computations: resources.computations,
      compute: sample,
      sample: sample,
    };
    const compiled = kind === "provider"
      ? compileComputedBinding(configuration)
      : compileStoredBinding(configuration);
    const descriptor = resources.registerEffect(program(`owned-${kind}`), { bindings: [compiled] });
    configuration.id = "changed";
    configuration.target = (owner) => owner;
    configuration.group.strength = 99;
    configuration.computeRef = "missing-provider";
    configuration.sample = () => [modifier.create({ finalAddition: 99 })];

    const owner = initializeUnit({
      id: 2,
      position: [0, 0],
      definition: { id: `owner-${kind}`, offense: { attack: 100 } },
    });
    const installed = installFixtureEffect(
      owner, resources.effects.create(descriptor.ref, metadata), resources,
    );
    const contribution = installed.offense.attack.entries[0];
    assert.equal(contribution.id, "@effect/0/sample");
    assert.deepEqual(contribution.group, { id: "original-group", strength: 1 });
    assert.equal(resolveAttackPower(2, combatWorkView(effectFixtureWork(installed)), resources.computations), 120);
    const removed = removeEffect(
      effectFixtureWork(installed), { type: "EFFECT", unitId: 2, effectId: 0 }, resources, 0,
    );
    assert.deepEqual(getCombatUnit(removed, 2).offense.attack.entries, []);
  }
});

test("resources: registered authored contributions retain their behavior after caller edits", () => {
  for (const computed of [false, true]) {
    const resources = new CombatResources();
    const group = { id: "original-group", strength: 1 };
    const declaration = computed
      ? computedAttack(({ instance }) => [modifier.create({ finalAddition: instance.state.value * 20 })], { group })
      : attack((instance) => [modifier.create({ finalAddition: instance.state.value * 20 })], { group });
    const contributions = [declaration];
    const descriptor = resources.registerEffect(program(`authored-${computed}`), { contributions });
    contributions.length = 0;
    declaration.id = "changed";
    declaration.target = (owner) => owner;
    group.strength = 99;
    declaration.sample = () => [modifier.create({ finalAddition: 999 })];
    declaration.compute = () => [modifier.create({ finalAddition: 999 })];

    const owner = initializeUnit({
      id: 2,
      position: [0, 0],
      definition: { id: "authored-owner", offense: { attack: 100 } },
    });
    const installed = installFixtureEffect(owner, resources.effects.create(descriptor.ref, metadata), resources);
    const currentAttack = (work) => resolveAttackPower(2, combatWorkView(work), resources.computations);
    const initial = effectFixtureWork(installed);
    assert.equal(currentAttack(initial), 120);
    assert.deepEqual(installed.offense.attack.entries[0].group, { id: "original-group", strength: 1 });
    const updated = updateEffectState(initial, 2, 0, descriptor.ref, () => ({ value: 2 }), resources, 0);
    assert.equal(currentAttack(updated), 140);
    const address = { type: "EFFECT", unitId: 2, effectId: 0 };
    const disabled = setEffectEnabled(updated, address, false, resources, 0);
    assert.equal(currentAttack(disabled), 100);
    assert.equal(currentAttack(setEffectEnabled(disabled, address, true, resources, 0)), 140);
    const removed = removeEffect(updated, address, resources, 0);
    assert.deepEqual(getCombatUnit(removed, 2).offense.attack.entries, []);
  }
});

test("resources: authored identities are nonempty and unique across stored and computed attributes", () => {
  for (const [contributions, error] of [
    [[attack(() => []), computedAttack(() => [])], /duplicate effect contribution/],
    [[attack(() => [], { id: "same" }), computedDefense(() => [], { id: "same" })], /duplicate effect contribution/],
    [[attack(() => [], { id: "" })], /identity must be nonempty/],
  ]) {
    const resources = new CombatResources();
    assert.throws(() => resources.registerEffect(program("invalid-authored"), { contributions }), error);
    assert.throws(() => resources.computations.bind({}), /failed resource construction/);
  }
});

test("resources: a shared reference cannot replace an existing program descriptor", () => {
  const resources = new EffectResources();
  const original = program("stable-program");
  const registered = resources.register(original);
  const replacement = { ...original, initialize: () => ({ value: 99 }) };

  assert.throws(() => resources.register(replacement), /duplicate effect program/);
  assert.equal(resources.get(original.ref), registered);
  assert.equal(resources.register(original), registered);
  assert.equal(resources.register(registered), registered);
  assert.equal(resources.create(original.ref, metadata).state.value, 1);
});

test("resources: publishing owns program behavior even when the caller's descriptor is mutable", () => {
  const resources = new CombatResources();
  const descriptor = { ...program("mutable-program") };
  const registered = resources.registerEffect(descriptor);
  new BattleRuntime(spec(), { combat: resources });
  descriptor.initialize = () => ({ value: 99 });
  descriptor.ownState = () => ({ value: 99 });
  descriptor.ref = program("replaced-reference").ref;

  assert.equal(Object.isFrozen(registered), true);
  assert.equal(resources.effects.get(registered.ref), registered);
  const instance = resources.effects.create(registered.ref, metadata);
  assert.equal(instance.state.value, 1);
  assert.equal(resources.effects.update(instance, { value: 2 }).state.value, 2);
});

test("resources: failed composite registration invalidates the entire unpublished resource graph", () => {
  for (const stage of ["numeric", "damage", "healing", "lifecycle"]) {
    const resources = new CombatResources();
    const descriptor = resources.effects.register(program(`partial-${stage}`));
    const instance = resources.effects.create(descriptor.ref, metadata);
    const evaluator = resources.computations.bind({});
    let facets;
    if (stage === "numeric") {
      resources.computations.register(JSON.stringify([descriptor.ref.id, "defense"]), () => []);
      facets = { contributions: [computedAttack(() => []), computedDefense(() => [])] };
    } else {
      const registry = stage === "lifecycle" ? resources.effectLifecycle : resources[stage];
      registry.register(descriptor.ref, {});
      facets = { damage: {}, healing: {}, lifecycle: {} };
    }

    assert.throws(() => resources.registerEffect(descriptor, facets), /duplicate/);

    for (const read of [
      () => resources.effects.get(descriptor.ref),
      () => resources.effects.create(descriptor.ref, metadata),
      () => resources.effects.restore(descriptor.ref, JSON.parse(JSON.stringify(instance))),
      () => resources.effectBindings.get(instance),
      () => resources.damage.get(instance),
      () => resources.healing.get(instance),
      () => resources.effectLifecycle.get(instance),
      () => resources.computations.bind({}),
      () => evaluator({ computeRef: `${descriptor.ref.id}/attack` }),
      () => resources.settleDamage(effectFixtureWork(), {
        sourceUnitId: null, targetUnitId: 2, damageType: "TRUE",
        operands: createDamageOperands(10), tick: 0,
      }, new EffectDispatchScope()),
      () => resources.settleHealing(
        effectFixtureWork(),
        { sourceUnitId: null, targetUnitId: 2, power: 10, tick: 0 },
        new EffectDispatchScope(),
      ),
      () => resources.seal(),
      () => new BattleRuntime(spec(), { combat: resources }),
    ]) {
      assert.throws(read, /failed resource construction/, stage);
    }
    assert.throws(() => resources.registerEffect(descriptor), /failed resource construction/);
    assert.throws(() => resources.computations.register("retry", () => []), /failed resource construction/);

    const rebuilt = new CombatResources();
    const rebuiltProgram = rebuilt.registerEffect(program(descriptor.ref.id), facets);
    rebuilt.seal();
    assert.equal(rebuilt.effects.create(rebuiltProgram.ref, metadata).state.value, 1);
  }
});

test("resources: publishing to BattleRuntime closes every registry while preserving execution", () => {
  const resources = new CombatResources();
  const descriptor = resources.registerEffect(program("published"));
  const runtime = new BattleRuntime(spec(), { combat: resources });

  for (const write of [
    () => resources.registerEffect(program("late")),
    () => resources.effects.register(program("late-program")),
    () => resources.effectBindings.register(descriptor.ref, []),
    () => resources.computations.register("late-attack", () => []),
    () => resources.computations.register("late-defense", () => []),
    () => resources.damage.register(descriptor.ref, {}),
    () => resources.healing.register(descriptor.ref, {}),
    () => resources.effectLifecycle.register(descriptor.ref, {}),
  ]) {
    assert.throws(write, /registration is sealed/);
  }

  assert.equal(resources.seal(), resources);
  assert.equal(resources.effects.create(descriptor.ref, metadata).state.value, 1);
  runtime.step();
  assert.equal(runtime.snapshot().tickIndex, 1);
});


test("resources: computed contributions distinguish program and binding identities containing separators", () => {
  const resources = new CombatResources();
  const first = resources.registerEffect(program("a/b"), {
    contributions: [computedAttack(() => [modifier.create({ finalAddition: 10 })], { id: "c" })],
  });
  const second = resources.registerEffect(program("a"), {
    contributions: [computedAttack(() => [modifier.create({ finalAddition: 20 })], { id: "b/c" })],
  });
  resources.seal();
  const owner = initializeUnit({
    id: 2, position: [0, 0], definition: { id: "owner", offense: { attack: 100 } },
  });
  const installed = installFixtureEffect(owner, resources.effects.create(first.ref, metadata), resources);
  const both = installFixtureEffect(installed,
    resources.effects.create(second.ref, { ...metadata, id: 1, acquiredSequence: 1 }), resources);
  assert.notEqual(both.offense.attack.entries[0].computeRef, both.offense.attack.entries[1].computeRef);
  assert.equal(resolveAttackPower(2, combatWorkView(effectFixtureWork(both)), resources.computations), 130);
});
