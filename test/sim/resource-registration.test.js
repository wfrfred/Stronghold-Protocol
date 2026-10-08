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
  compileNumericProjectionBinding,
  compileNumericProviderBinding,
} from "../../dist/core/tactical/unit/capability/effects/contribution-bindings.js";
import { createNumericContribution } from "../../dist/core/tactical/modifier/numeric.js";
import { offenseAttackContributions } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { removeEffect } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
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
  scope: null,
  expiresAtTick: null,
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
    effectFixtureWork(installed), { unitId: 2, instanceId: 0 }, resources, 0,
  );
  assert.equal(hasStatusFlag(getCombatUnit(removed, 2), "INVINCIBLE"), false);
  assert.deepEqual(getCombatUnit(removed, 2).effects.instances, []);
});

test("resources: binding compilers capture configuration values rather than caller-owned objects", () => {
  for (const kind of ["provider", "projection"]) {
    const resources = new CombatResources();
    const sample = () => [createNumericContribution({ finalAddition: 20 })];
    const configuration = {
      id: "sample",
      target: offenseAttackContributions,
      group: { id: "original-group", strength: 1 },
      providerRef: "sample/attack",
      providers: resources.offense,
      evaluate: sample,
      project: sample,
    };
    const compiled = kind === "provider"
      ? compileNumericProviderBinding(configuration)
      : compileNumericProjectionBinding(configuration);
    const descriptor = resources.registerEffect(program(`owned-${kind}`), { bindings: [compiled] });
    configuration.id = "changed";
    configuration.target = (owner) => owner;
    configuration.group.strength = 99;
    configuration.providerRef = "missing-provider";
    configuration.project = () => [createNumericContribution({ finalAddition: 99 })];

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
    assert.equal(resolveAttackPower(2, combatWorkView(effectFixtureWork(installed)), resources.offense), 120);
    const removed = removeEffect(
      effectFixtureWork(installed), { unitId: 2, instanceId: 0 }, resources, 0,
    );
    assert.deepEqual(getCombatUnit(removed, 2).offense.attack.entries, []);
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
    const evaluator = resources.offense.evaluator({});
    let facets;
    if (stage === "numeric") {
      resources.defense.register(`${descriptor.ref.id}/defense`, () => []);
      facets = { contributions: { attack: () => [], defense: () => [] } };
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
      () => resources.offense.evaluator({}),
      () => evaluator({ providerRef: `${descriptor.ref.id}/attack` }),
      () => resources.settleDamage(effectFixtureWork(), {
        sourceUnitId: null, targetUnitId: 2, damageType: "TRUE",
        operands: createDamageOperands(10), tick: 0,
      }, new EffectDispatchScope()),
      () => resources.settleHealing(effectFixtureWork(), {
        sourceUnitId: null, targetUnitId: 2, power: 10,
      }, 0, new EffectDispatchScope()),
      () => resources.seal(),
      () => new BattleRuntime(spec(), { combat: resources }),
    ]) {
      assert.throws(read, /failed resource construction/, stage);
    }
    assert.throws(() => resources.registerEffect(descriptor), /failed resource construction/);
    assert.throws(() => resources.offense.register("retry", () => []), /failed resource construction/);

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
    () => resources.offense.register("late-attack", () => []),
    () => resources.defense.register("late-defense", () => []),
    () => resources.vitality.register("late-hp", () => []),
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
