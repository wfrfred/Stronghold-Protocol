import { attack, liveAttack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import { liveDefense } from "../../dist/core/tactical/unit/capability/defense/contributions.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { battlefieldView, getUnit } from "../../dist/core/tactical/battle/execution/context.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { EffectResources } from "../../dist/core/tactical/unit/capability/effects/registry.js";
import { EffectDispatchScope } from "../../dist/core/tactical/unit/capability/effects/dispatch.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import {
  sampled,
  live,
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

test("resources: direct binding registration shares immutable descriptors and arrays", () => {
  const resources = new CombatResources();
  const descriptor = resources.effects.register(program("direct-binding"));
  const binding = compileStatusBinding(["INVINCIBLE"]);
  const bindings = [binding];
  resources.effectBindings.register(descriptor.ref, bindings);
  const instance = resources.effects.create(descriptor.ref, metadata);
  const registered = resources.effectBindings.get(instance);

  assert.equal(registered, bindings);
  assert.equal(registered[0], binding);
  const owner = unit();
  const installed = installFixtureEffect(owner, instance, resources);
  assert.equal(hasStatusFlag(installed, "INVINCIBLE"), true);
  assert.equal(hasStatusFlag(owner, "INVINCIBLE"), false);
});

test("resources: binding participation and removal leave earlier unit values unchanged", () => {
  const resources = new CombatResources();
  const binding = compileStatusBinding(["INVINCIBLE"]);
  const descriptor = resources.registerEffect(program("shared-binding"), { bindings: [binding] });
  const installed = installFixtureEffect(
    unit(), resources.effects.create(descriptor.ref, metadata), resources,
  );
  const current = effectFixtureWork(installed);
  const address = { type: "EFFECT", unitId: 2, effectId: 0 };

  setEffectEnabled(current, address, false, resources, 0);
  assert.equal(hasStatusFlag(getUnit(current, 2), "INVINCIBLE"), false);
  assert.equal(hasStatusFlag(installed, "INVINCIBLE"), true);
  setEffectEnabled(current, address, true, resources, 0);
  assert.equal(hasStatusFlag(getUnit(current, 2), "INVINCIBLE"), true);
  removeEffect(current, address, resources, 0);
  assert.equal(hasStatusFlag(getUnit(current, 2), "INVINCIBLE"), false);
  assert.deepEqual(getUnit(current, 2).effects.instances, []);
  assert.equal(installed.effects.instances.length, 1);
});

test("resources: binding factories share declared groups and sampled modifier values", () => {
  for (const kind of ["live", "sampled"]) {
    const resources = new CombatResources();
    const values = [modifier.create({ finalAddition: 20 })];
    const sample = () => values;
    const group = { id: "original-group", strength: 1 };
    const configuration = {
      id: "sample",
      target: updateAttackContributions,
      group,
      evaluator: "sample/attack",
      computations: resources.computations,
      evaluate: sample,
      sample,
    };
    const compiled = kind === "live"
      ? live(configuration)
      : sampled(configuration);
    const descriptor = resources.registerEffect(program(`shared-${kind}`), { bindings: [compiled] });
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
    assert.equal(contribution.group, group);
    if (kind === "sampled") {
      assert.equal(contribution.values, values);
    }
    assert.equal(resolveAttackPower(2, battlefieldView(effectFixtureWork(installed)), resources.computations), 120);
    assert.equal(resolveAttackPower(2, battlefieldView(effectFixtureWork(owner)), resources.computations), 100);
    const removed = effectFixtureWork(installed);
    removeEffect(
      removed, { type: "EFFECT", unitId: 2, effectId: 0 }, resources, 0,
    );
    assert.deepEqual(getUnit(removed, 2).offense.attack.entries, []);
    assert.equal(installed.offense.attack.entries[0], contribution);
  }
});

test("resources: authored contributions retain prior snapshots across lifecycle updates", () => {
  for (const useLive of [false, true]) {
    const resources = new CombatResources();
    const group = { id: "original-group", strength: 1 };
    const declaration = useLive
      ? liveAttack(({ instance }) => [modifier.create({ finalAddition: instance.state.value * 20 })], { group })
      : attack((instance) => [modifier.create({ finalAddition: instance.state.value * 20 })], { group });
    const descriptor = resources.registerEffect(program(`authored-${useLive}`), { contributions: [declaration] });
    const owner = initializeUnit({
      id: 2,
      position: [0, 0],
      definition: { id: "authored-owner", offense: { attack: 100 } },
    });
    const installed = installFixtureEffect(owner, resources.effects.create(descriptor.ref, metadata), resources);
    const currentAttack = (work) => resolveAttackPower(2, battlefieldView(work), resources.computations);
    const current = effectFixtureWork(installed);
    const original = current.battlefield.snapshot("draft");
    assert.equal(currentAttack(current), 120);
    assert.equal(installed.offense.attack.entries[0].group, group);
    updateEffectState(current, 2, 0, descriptor.ref, () => ({ value: 2 }), resources, 0);
    assert.equal(currentAttack(current), 140);
    assert.equal(resolveAttackPower(2, original, resources.computations), 120);
    const address = { type: "EFFECT", unitId: 2, effectId: 0 };
    setEffectEnabled(current, address, false, resources, 0);
    assert.equal(currentAttack(current), 100);
    setEffectEnabled(current, address, true, resources, 0);
    assert.equal(currentAttack(current), 140);
    removeEffect(current, address, resources, 0);
    assert.deepEqual(getUnit(current, 2).offense.attack.entries, []);
    assert.equal(installed.offense.attack.entries.length, 1);
    assert.equal(resolveAttackPower(2, original, resources.computations), 120);
  }
});

test("resources: authored identities are nonempty and unique across sampled and live attributes", () => {
  for (const [contributions, error] of [
    [[attack(() => []), liveAttack(() => [])], /duplicate effect contribution/],
    [[attack(() => [], { id: "same" }), liveDefense(() => [], { id: "same" })], /duplicate effect contribution/],
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

test("resources: registration shares the authored program and state updates retain previous values", () => {
  const resources = new CombatResources();
  const descriptor = program("shared-program");
  const registered = resources.registerEffect(descriptor);
  new BattleRuntime(spec(), { combat: resources });

  assert.equal(registered, descriptor);
  assert.equal(resources.effects.get(registered.ref), descriptor);
  const instance = resources.effects.create(registered.ref, metadata);
  const nextState = { value: 2 };
  const updated = resources.effects.update(instance, nextState);
  assert.equal(instance.state.value, 1);
  assert.equal(updated.state, nextState);
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
      facets = { contributions: [liveAttack(() => []), liveDefense(() => [])] };
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
      () => evaluator({ evaluator: `${descriptor.ref.id}/attack` }),
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


test("resources: live contributions distinguish program and binding identities containing separators", () => {
  const resources = new CombatResources();
  const first = resources.registerEffect(program("a/b"), {
    contributions: [liveAttack(() => [modifier.create({ finalAddition: 10 })], { id: "c" })],
  });
  const second = resources.registerEffect(program("a"), {
    contributions: [liveAttack(() => [modifier.create({ finalAddition: 20 })], { id: "b/c" })],
  });
  resources.seal();
  const owner = initializeUnit({
    id: 2, position: [0, 0], definition: { id: "owner", offense: { attack: 100 } },
  });
  const installed = installFixtureEffect(owner, resources.effects.create(first.ref, metadata), resources);
  const both = installFixtureEffect(installed,
    resources.effects.create(second.ref, { ...metadata, id: 1, acquiredSequence: 1 }), resources);
  assert.notEqual(both.offense.attack.entries[0].evaluator, both.offense.attack.entries[1].evaluator);
  assert.equal(resolveAttackPower(2, battlefieldView(effectFixtureWork(both)), resources.computations), 130);
});
