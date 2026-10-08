import { attack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { EffectResources } from "../../dist/core/tactical/unit/capability/effects/registry.js";
import {
  expireEffects,
  installEffect,
  installNewEffect,
  removeEffect,
  finishEffectsOwnedByExecution,
  finishEffectsOwnedByUnit,
  setEffectParticipation,
  finishEffect,
  finalizeEffect,
  finalizeFinishedEffects,
  attachEffectParent,
} from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { combatWorkView, getCombatUnit } from "../../dist/core/tactical/battle/execution/work.js";
import { createNumericContribution } from "../../dist/core/tactical/modifier/numeric.js";
import { offenseAttackContributions } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { compileStatusBinding } from "../../dist/core/tactical/unit/capability/status/binding.js";
import { uniqueEffectAdmission } from "../../dist/core/tactical/unit/capability/effects/lifecycle-resources.js";
import { effectFixtureWork, installFixtureEffect } from "../helpers/effects.js";
import { copyEffectsState } from "../../dist/core/tactical/unit/capability/effects/capability.js";
import {
  registerEffectInstance,
  removeEffectInstance,
  replaceEffectInstance,
} from "../../dist/core/tactical/unit/capability/effects/internal/state.js";
import { updateEffectState } from "../../dist/core/tactical/unit/capability/effects/transition.js";
import {
  createStatusDefinition,
  hasStatusFlag,
  initializeStatusState,
} from "../../dist/core/tactical/unit/capability/status/capability.js";

function barrierProgram(id = "barrier") {
  return createEffectProgram({
    id,
    initialize: () => ({ remainingAmount: 500 }),
    ownState: (value) => {
      if (
        !value ||
        typeof value !== "object" ||
        !Number.isFinite(value.remainingAmount) ||
        value.remainingAmount < 0
      ) {
        throw new TypeError("invalid barrier state");
      }
      return value;
    },
  });
}

function metadata(id = 1, overrides = {}) {
  return {
    id,
    source: 7,
    scope: { type: "UNIT", unitId: 9 },
    acquiredSequence: id,
    expiresAtTick: null,
    ...overrides,
  };
}

function unit(flags = []) {
  const status = createStatusDefinition({ initialFlags: flags });
  return {
    id: 2,
    definition: { id: "unit", status },
    position: [0, 0],
    status: initializeStatusState(status),
  };
}

test("effects: direct installation normalizes typed state before lifecycle behavior and isolates it", () => {
  const resources = new CombatResources();
  const observed = [];
  let normalizationCount = 0;
  const program = resources.registerEffect(createEffectProgram({
    id: "normalized-direct",
    initialize: () => ({ remainingAmount: 10 }),
    ownState: state => {
      normalizationCount++;
      return { remainingAmount: Math.max(0, state.remainingAmount) };
    },
  }), { lifecycle: { start: context => { observed.push(context.instance.state.remainingAmount); } } });
  const original = effectFixtureWork(unit());
  const instance = resources.effects.create(program.ref, metadata());
  const input = { ...instance, state: { remainingAmount: -5 } };
  const copied = copyEffectsState({ instances: [input], nextInstanceId: 2, nextAcquiredSequence: 2 });
  normalizationCount = 0;
  const installed = installEffect(original, 2, copied.instances[0], resources, 0);
  input.state.remainingAmount = 999;
  assert.equal(normalizationCount, 1);
  assert.deepEqual(observed, [0]);
  assert.equal(getCombatUnit(installed.work, 2).effects.instances[0].state.remainingAmount, 0);
  assert.equal(getCombatUnit(original, 2).effects, undefined);

  normalizationCount = 0;
  const newInstallation = installNewEffect(original, 2, program.ref, {
    source: null, scope: null, expiresAtTick: null, initialState: { remainingAmount: -7 },
  }, resources, 0);
  assert.equal(normalizationCount, 1);
  assert.equal(getCombatUnit(newInstallation.work, 2).effects.instances[0].state.remainingAmount, 0);
  assert.deepEqual(observed, [0, 0]);
});

test("effects: direct installation rejects program-invalid numeric facts even after ordinary ownership", () => {
  const resources = new CombatResources();
  const program = resources.registerEffect(barrierProgram());
  const instance = resources.effects.create(program.ref, metadata());
  const copied = copyEffectsState({
    instances: [{ ...instance, state: { remainingAmount: -1 } }],
    nextInstanceId: 2, nextAcquiredSequence: 2,
  });
  const original = effectFixtureWork(unit());
  assert.throws(() => installEffect(original, 2, copied.instances[0], resources, 0), /invalid barrier state/);
  assert.equal(getCombatUnit(original, 2).effects, undefined);
  assert.throws(() => installEffect(original, 2, { ...instance, started: true }, resources, 0), /only a fresh effect/);
  const installed = installEffect(original, 2, instance, resources, 0);
  assert.equal(installed.result.type, "INSTALLED");
});

test("effects: missing direct-install receivers return absence before program normalization", () => {
  const resources = new CombatResources();
  const foreign = new EffectResources();
  const program = foreign.register(barrierProgram());
  const instance = foreign.create(program.ref, metadata());
  const original = effectFixtureWork(unit());
  const installation = installEffect(original, 99, {
    ...instance, state: { remainingAmount: -1 },
  }, resources, 0);
  assert.equal(installation.work, original);
  assert.deepEqual(installation.result, {
    type: "REJECTED", reason: "TARGET_ABSENT", address: { unitId: 99, instanceId: instance.id },
  });
});

test("effects: instance resources are separate from snapshot facts and restoration validates the program state", () => {
  const resources = new EffectResources();
  const program = resources.register(barrierProgram());
  const instance = resources.create(program.ref, metadata());
  const serialized = JSON.parse(JSON.stringify(instance));
  const restored = resources.restore(program.ref, serialized);

  assert.deepEqual(instance.programRef, { id: "barrier" });
  assert.deepEqual(Object.keys(program.ref), ["id"]);
  assert.deepEqual(restored, instance);
  assert.equal(restored.programRef, program.ref);
  assert.equal(resources.typedState(restored, program.ref).remainingAmount, 500);
  serialized.state.remainingAmount = -1;
  assert.throws(() => resources.restore(program.ref, serialized), /invalid barrier/);
  assert.throws(
    () => resources.restore(barrierProgram().ref, serialized),
    /unregistered/,
  );
});

test("effects: reference and descriptor binding cannot be replaced by a second schema with the same identity", () => {
  const resources = new EffectResources();
  const program = resources.register(barrierProgram());
  const other = barrierProgram();

  assert.equal(resources.register(program), program);
  assert.throws(() => resources.register(other), /duplicate effect program/);
  assert.throws(() => resources.get(other.ref), /unregistered effect program/);
  const runtimeResources = new CombatResources();
  runtimeResources.registerEffect(program);
  const foreignResources = new EffectResources();
  const foreign = foreignResources.register(
    createEffectProgram({
      id: program.ref.id,
      initialize: () => ({ remainingCharges: 2 }),
      ownState: (value) => value,
    }),
  );
  assert.throws(
    () =>
      installEffect(
        effectFixtureWork(unit()),
        2,
        foreignResources.create(foreign.ref, metadata()),
        runtimeResources,
        0,
      ),
    /unregistered effect program/,
  );
});

test("effects: typed updates isolate external facts, retain unchanged instances and copy shares owned state", () => {
  const lifecycleResources = new CombatResources();
  const resources = lifecycleResources.effects;
  const program = lifecycleResources.registerEffect(barrierProgram());
  const instance = resources.create(program.ref, metadata());
  const input = { remainingAmount: 200, details: { applications: [1, 2] } };
  const updated = resources.update(instance, input);
  const installed = installFixtureEffect(unit(), updated, lifecycleResources);
  const copy = copyEffectsState(installed.effects);

  input.remainingAmount = 1;
  input.details.applications.push(3);
  assert.equal(instance.state.remainingAmount, 500);
  assert.equal(updated.state.remainingAmount, 200);
  assert.deepEqual(updated.state.details.applications, [1, 2]);
  assert.ok(Object.isFrozen(updated.state.details.applications));
  assert.equal(resources.update(updated, updated.state), updated);
  assert.equal(copy.instances, installed.effects.instances);
  assert.equal(copy.instances[0], installed.effects.instances[0]);
  assert.equal(copy.instances[0].state, updated.state);
  assert.throws(
    () => copyEffectsState({ ...installed.effects, nextInstanceId: 1 }),
    /allocation progress/,
  );
  assert.throws(
    () => copyEffectsState({ ...installed.effects, nextAcquiredSequence: 1 }),
    /allocation progress/,
  );
});

test("effects: derived arrays stay frozen and preserve unchanged instances across branches and cleanup", () => {
  const resources = new CombatResources();
  const program = resources.registerEffect(barrierProgram());
  const first = installFixtureEffect(
    unit(),
    resources.effects.create(program.ref, metadata(1)),
    resources,
  );
  const second = installFixtureEffect(
    first,
    resources.effects.create(program.ref, metadata(2)),
    resources,
  );
  const work = effectFixtureWork(second);
  const address = { unitId: 2, instanceId: 2 };
  let calls = 0;
  const unchanged = updateEffectState(
    work,
    2,
    2,
    program.ref,
    (state) => {
      calls++;
      return state;
    },
    resources,
  );
  const updated = updateEffectState(work, 2, 2, program.ref, { remainingAmount: 100 }, resources);
  const branch = updateEffectState(work, 2, 2, program.ref, { remainingAmount: 200 }, resources);
  const disabled = setEffectParticipation(updated, address, false, resources, 1);
  const finished = finishEffect(disabled, address, resources, 1);
  const cleaned = finalizeEffect(finished, address, resources, 1);
  const retained = getCombatUnit(cleaned, 2).effects;

  assert.equal(calls, 1);
  assert.equal(unchanged, work);
  assert.equal(first.effects.instances[0], second.effects.instances[0]);
  assert.equal(second.effects.instances[1].state.remainingAmount, 500);
  assert.equal(getCombatUnit(updated, 2).effects.instances[1].state.remainingAmount, 100);
  assert.equal(getCombatUnit(branch, 2).effects.instances[1].state.remainingAmount, 200);
  assert.equal(getCombatUnit(updated, 2).effects.instances[1].participating, true);
  assert.equal(getCombatUnit(disabled, 2).effects.instances[1].finished, false);
  const changedUnits = [updated, branch, disabled, finished, cleaned].map((value) =>
    getCombatUnit(value, 2),
  );
  for (const current of [first, second, ...changedUnits]) {
    assert.ok(Object.isFrozen(current.effects));
    assert.ok(Object.isFrozen(current.effects.instances));
    assert.equal(current.effects.instances[0], first.effects.instances[0]);
    assert.equal(copyEffectsState(current.effects).instances, current.effects.instances);
  }
  assert.deepEqual(retained.instances.map((instance) => instance.id), [1]);
  assert.equal(
    copyEffectsState({ ...retained, nextInstanceId: 2, nextAcquiredSequence: 2 }).instances,
    retained.instances,
  );
  assert.throws(() => retained.instances.push(second.effects.instances[1]), TypeError);
  const empty = removeEffect(cleaned, { unitId: 2, instanceId: 1 }, resources, 1);
  const emptyState = getCombatUnit(empty, 2).effects;
  assert.ok(Object.isFrozen(emptyState.instances));
  assert.equal(
    copyEffectsState({ ...emptyState, nextInstanceId: 0, nextAcquiredSequence: 0 }).instances,
    emptyState.instances,
  );
});

test("effects: array ownership isolates mutable instances and preserves allocation invariants", () => {
  const resources = new EffectResources();
  const program = resources.register(barrierProgram());
  const instance = resources.create(program.ref, metadata(1));
  const input = [instance];
  const effects = copyEffectsState({ instances: input, nextInstanceId: 2, nextAcquiredSequence: 2 });
  const original = { ...unit(), effects };
  const mutable = { ...instance, state: { remainingAmount: 123 } };

  assert.notEqual(effects.instances, input);
  assert.equal(Object.isFrozen(input), false);
  assert.ok(Object.isFrozen(effects.instances));
  input.length = 0;
  assert.deepEqual(effects.instances, [instance]);
  const copied = copyEffectsState({ ...effects, instances: [mutable] });
  mutable.state.remainingAmount = 999;
  assert.equal(copied.instances[0].state.remainingAmount, 123);
  assert.equal(Object.isFrozen(copied.instances[0]), true);
  assert.equal(Object.isFrozen(copied.instances[0].state), true);
  assert.equal(copyEffectsState(copied), copied);
  const mutableBound = {
    ...instance, state: { remainingAmount: 100 },
    scope: { type: "UNIT", unitId: 2 }, parent: { unitId: 2, instanceId: 1 },
  };
  const unchanged = resources.update(mutableBound, mutableBound.state);
  const changed = resources.update(mutableBound, { remainingAmount: 200 });
  mutableBound.parent.instanceId = 99;
  mutableBound.scope.unitId = 99;
  mutableBound.state.remainingAmount = 999;
  for (const owned of [unchanged, changed]) {
    assert.equal(owned.parent.instanceId, 1);
    assert.equal(owned.scope.unitId, 2);
    assert.ok(Object.isFrozen(owned.parent));
    assert.ok(Object.isFrozen(owned.scope));
  }
  assert.equal(unchanged.state.remainingAmount, 100);
  assert.equal(changed.state.remainingAmount, 200);
  assert.throws(
    () => copyEffectsState({ ...effects, instances: [{ ...instance, participating: true }] }),
    /invalid effect lifecycle/,
  );
  assert.throws(
    () => copyEffectsState({ ...effects, instances: [{ ...instance, parent: { unitId: NaN, instanceId: -1 } }] }),
    /parent unit identity/,
  );
  assert.throws(
    () => copyEffectsState({ ...effects, instances: [instance, instance] }),
    /duplicate effect/,
  );
  assert.throws(
    () => replaceEffectInstance(original, instance, resources.create(program.ref, metadata(2))),
    /cannot be changed/,
  );
  for (const invalid of [-1, 1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => copyEffectsState({ ...effects, nextInstanceId: invalid }),
      /allocation progress/,
    );
    assert.throws(
      () => copyEffectsState({ ...effects, nextAcquiredSequence: invalid }),
      /allocation progress/,
    );
  }
  assert.equal(copyEffectsState(effects).instances, effects.instances);
});

test("effects: heterogeneous dispatch remains paired and an unrelated typed program cannot update an instance", () => {
  const resources = new EffectResources();
  const barrier = resources.register(barrierProgram());
  const shield = resources.register(
    createEffectProgram({
      id: "shield",
      initialize: () => ({ remainingCharges: 2 }),
      ownState: (value) => value,
    }),
  );
  const instance = resources.create(barrier.ref, metadata());

  assert.equal(resources.typedState(instance, shield.ref), undefined);
  assert.equal(resources.typedInstance(instance, shield.ref), undefined);
  assert.deepEqual(
    resources.withProgram(instance, (bound, descriptor) => [
      bound.programRef.id,
      descriptor.ref.id,
    ]),
    ["barrier", "barrier"],
  );
});

test("effects: program ownership excludes behavior, accessors, cycles and sparse state arrays", () => {
  const resources = new EffectResources();
  const program = resources.register(barrierProgram());
  const instance = resources.create(program.ref, metadata());
  const cycle = {};
  cycle.self = cycle;
  const sparse = new Array(2);
  const accessor = Object.defineProperty({}, "value", {
    get: () => assert.fail("accessor executed"),
  });

  for (const invalid of [() => 1, cycle, sparse, accessor, new Map()]) {
    assert.throws(
      () => resources.update(instance, { remainingAmount: 500, invalid }),
      TypeError,
    );
  }
});

test("effects: installation and removal keep effect identity and status contributions atomic", () => {
  const resources = new CombatResources();
  const program = resources.registerEffect(barrierProgram(), {
    bindings: [compileStatusBinding(["INVINCIBLE"])],
  });
  const original = unit();
  const first = installFixtureEffect(
    original,
    resources.effects.create(program.ref, metadata(1)),
    resources,
  );
  const second = installFixtureEffect(
    first,
    resources.effects.create(program.ref, metadata(2)),
    resources,
  );
  const work = effectFixtureWork(second);
  const removed = removeEffect(work, { unitId: 2, instanceId: 1 }, resources, 0);
  const cleared = removeEffect(removed, { unitId: 2, instanceId: 2 }, resources, 0);

  assert.equal(original.effects, undefined);
  assert.equal(hasStatusFlag(original, "INVINCIBLE"), false);
  assert.equal("statusContributionId" in first.effects.instances[0], false);
  assert.equal(hasStatusFlag(getCombatUnit(removed, 2), "INVINCIBLE"), true);
  assert.equal(getCombatUnit(removed, 2).effects.instances[0].id, 2);
  assert.equal(hasStatusFlag(getCombatUnit(cleared, 2), "INVINCIBLE"), false);
  assert.deepEqual(getCombatUnit(cleared, 2).status.contributions, original.status.contributions);
  assert.equal(removeEffect(cleared, { unitId: 2, instanceId: 99 }, resources, 0), cleared);
});

test("effects: installing flags requires existing Status and baseline facts survive effect removal", () => {
  const resources = new CombatResources();
  const program = resources.registerEffect(barrierProgram(), {
    bindings: [compileStatusBinding(["INVINCIBLE"])],
  });
  const instance = resources.effects.create(program.ref, metadata());
  const bare = { id: 2, definition: { id: "bare" }, position: [0, 0] };
  const baseline = unit(["INVINCIBLE"]);

  assert.throws(() => installFixtureEffect(bare, instance, resources), /existing Status/);
  assert.equal(bare.effects, undefined);
  const plain = resources.registerEffect(barrierProgram("plain"));
  const installed = installFixtureEffect(
    bare,
    resources.effects.create(plain.ref, metadata()),
    resources,
  );
  assert.equal(installed.effects.instances[0].id, instance.id);
  const marked = installFixtureEffect(baseline, instance, resources);
  const removed = removeEffect(
    effectFixtureWork(marked),
    { unitId: 2, instanceId: 1 },
    resources,
    0,
  );
  assert.equal(hasStatusFlag(getCombatUnit(removed, 2), "INVINCIBLE"), true);
});

test("effects: expiration is independent of source and lifetime scope cleanup does not filter by source", () => {
  const resources = new CombatResources();
  const program = resources.registerEffect(barrierProgram(), {
    bindings: [compileStatusBinding(["HEAL_FREE"])],
  });
  let current = unit();
  const values = [
    metadata(1, { source: 9, scope: { type: "UNIT", unitId: 7 }, expiresAtTick: 5 }),
    metadata(2, {
      source: 7,
      scope: { type: "EXECUTION", unitId: 9, executionId: 10 },
    }),
    metadata(3, {
      source: 7,
      scope: { type: "EXECUTION", unitId: 9, executionId: 11 },
    }),
    metadata(4, { source: 9, scope: null }),
  ];

  for (const value of values) {
    current = installFixtureEffect(
      current,
      resources.effects.create(program.ref, value),
      resources,
    );
  }

  const work = effectFixtureWork(current);
  const activeIds = (work) =>
    getCombatUnit(work, 2)
      .effects.instances.filter((effect) => effect.participating)
      .map((effect) => effect.id);
  assert.equal(expireEffects(work, 4, resources), work);
  const expired = expireEffects(work, 5, resources);
  assert.deepEqual(activeIds(expired), [2, 3, 4]);
  assert.equal(getCombatUnit(expired, 2).effects.instances.length, 4);
  assert.deepEqual(
    getCombatUnit(finalizeFinishedEffects(expired, 2, resources, 5), 2).effects.instances.map(
      (effect) => effect.id,
    ),
    [2, 3, 4],
  );
  assert.deepEqual(activeIds(finishEffectsOwnedByExecution(work, 9, 10, resources, 0)), [1, 3, 4]);
  assert.deepEqual(activeIds(finishEffectsOwnedByUnit(work, 9, resources, 0)), [1, 4]);
});

test("effects: start can read its registered identity before status bindings participate", () => {
  const resources = new CombatResources();
  const program = resources.registerEffect(barrierProgram(), {
    bindings: [compileStatusBinding(["INVINCIBLE"])],
    lifecycle: {
      start: (context) => {
        observed.push([
          context.facts.getEffect(context.address).id,
          context.instance.started,
          context.facts.participating(context.address.unitId).length,
          hasStatusFlag(context.facts.getUnit(context.address.unitId), "INVINCIBLE"),
        ]);
        context.effects.update(context.address, program.ref, (state) => ({
          ...state,
          remainingAmount: 100,
        }));
        assert.equal(context.instance.state.remainingAmount, 100);
      },
      enable: (context) => {
        observed.push([
          context.instance.started,
          hasStatusFlag(context.facts.getUnit(context.address.unitId), "INVINCIBLE"),
        ]);
      },
    },
  });
  const observed = [];

  const result = installEffect(
    effectFixtureWork(unit()),
    2,
    resources.effects.create(program.ref, metadata()),
    resources,
    0,
  );

  assert.equal(result.result.type, "INSTALLED");
  assert.deepEqual(observed, [
    [1, false, 0, false],
    [true, true],
  ]);
  assert.equal(getCombatUnit(result.work, 2).effects.instances[0].participating, true);
});

test("effects: start termination preserves its prefix without initializing or removing bindings", () => {
  const resources = new CombatResources();
  const keeper = resources.registerEffect(
    createEffectProgram({
      id: "keeper",
      initialize: () => ({ attempts: 0 }),
      ownState: (value) => ({ ...value }),
    }),
  );
  const binding = compileStatusBinding(["INVINCIBLE"]);
  let installed = 0;
  let removed = 0;
  const finalizations = [];
  const program = resources.registerEffect(barrierProgram("start-terminated"), {
    bindings: [
      {
        ...binding,
        install: (unit, instance) => {
          installed++;
          return binding.install(unit, instance);
        },
        remove: (unit, instance) => {
          removed++;
          return binding.remove(unit, instance);
        },
      },
    ],
    lifecycle: {
      start: (context) => {
        context.effects.update({ unitId: 2, instanceId: 0 }, keeper.ref, (state) => ({
          attempts: state.attempts + 1,
        }));
        context.effects.update(context.address, program.ref, () => ({
          remainingAmount: 200,
        }));
        context.effects.finish(context.address);
        assert.equal(context.instance.finished, true);
        assert.equal(context.instance.participating, false);
        assert.equal(context.facts.participating(2).length, 1);
      },
      finalize: (context) => {
        finalizations.push([
          context.instance.started,
          context.instance.finished,
          context.instance.state.remainingAmount,
        ]);
      },
    },
  });
  const bare = { id: 2, definition: { id: "bare" }, position: [0, 0] };
  const seeded = installFixtureEffect(
    bare,
    resources.effects.create(keeper.ref, metadata(0)),
    resources,
  );
  const original = effectFixtureWork(seeded);
  const result = installEffect(
    original,
    2,
    resources.effects.create(program.ref, metadata(1)),
    resources,
    0,
  );

  assert.deepEqual(result.result, {
    type: "REJECTED",
    reason: "START_FINISHED",
    address: { unitId: 2, instanceId: 1 },
  });
  assert.deepEqual(finalizations, [[false, true, 200]]);
  assert.equal(installed, 0);
  assert.equal(removed, 0);
  assert.deepEqual(
    getCombatUnit(result.work, 2).effects.instances.map((instance) => instance.id),
    [0],
  );
  assert.equal(getCombatUnit(result.work, 2).effects.instances[0].state.attempts, 1);
  assert.equal(getCombatUnit(result.work, 2).effects.nextInstanceId, 2);
  assert.equal(getCombatUnit(original, 2).effects.instances[0].state.attempts, 0);
});

test("effects: lifecycle facts and operation leases close on normal and exceptional callback exits", () => {
  for (const throws of [false, true]) {
    const resources = new CombatResources();
    let escaped;
    const program = resources.registerEffect(barrierProgram(), {
      lifecycle: {
        start: (context) => {
          escaped = context;
          if (throws) {
            throw new Error("start failed");
          }
        },
      },
    });
    const original = effectFixtureWork(unit());
    const install = () =>
      installEffect(original, 2, resources.effects.create(program.ref, metadata()), resources, 0);
    let result;
    if (throws) {
      assert.throws(install, /start failed/);
    } else {
      result = install();
    }
    const input = { source: null, scope: null, expiresAtTick: null };
    const calls = [
      () => escaped.instance,
      () => escaped.facts.getUnit(2),
      () => escaped.facts.getEffect(escaped.address),
      () => escaped.facts.participating(2),
      () => escaped.effects.install(2, program.ref, input),
      () => escaped.effects.update(escaped.address, program.ref, (state) => state),
      () => escaped.effects.setParticipation(escaped.address, false),
      () => escaped.effects.finish(escaped.address),
      () => escaped.effects.attachParent(escaped.address, { unitId: 2, instanceId: 99 }),
    ];
    for (const call of calls) {
      assert.throws(call, /no longer active/);
    }
    if (result !== undefined) {
      assert.equal(getCombatUnit(result.work, 2).effects.instances[0].participating, true);
      assert.equal(getCombatUnit(result.work, 2).effects.instances[0].finished, false);
    }
  }
});

test("effects: rejected unique installation preserves completed start transitions", () => {
  const resources = new CombatResources();
  const keeper = resources.registerEffect(
    createEffectProgram({
      id: "keeper",
      initialize: () => ({ attempts: 0 }),
      ownState: (value) => ({ ...value }),
    }),
  );
  const candidate = resources.registerEffect(barrierProgram("unique"), {
    lifecycle: {
      start: (context) => {
        context.effects.update({ unitId: 2, instanceId: 0 }, keeper.ref, (state) => ({
          attempts: state.attempts + 1,
        }));
      },
      accepts: uniqueEffectAdmission("unique"),
      finalize: (context) => {
        finalized.push(context.address.instanceId);
      },
    },
  });
  const finalized = [];

  let work = effectFixtureWork(unit());
  work = installEffect(
    work,
    2,
    resources.effects.create(keeper.ref, metadata(0)),
    resources,
    0,
  ).work;
  const accepted = installEffect(
    work,
    2,
    resources.effects.create(candidate.ref, metadata(1)),
    resources,
    0,
  );
  const rejected = installEffect(
    accepted.work,
    2,
    resources.effects.create(candidate.ref, metadata(2)),
    resources,
    0,
  );

  assert.equal(accepted.result.type, "INSTALLED");
  assert.equal(rejected.result.reason, "ADMISSION_REJECTED");
  assert.equal(getCombatUnit(rejected.work, 2).effects.instances[0].state.attempts, 2);
  assert.deepEqual(
    getCombatUnit(rejected.work, 2).effects.instances.map((instance) => instance.id),
    [0, 1],
  );
  assert.deepEqual(finalized, [2]);
  assert.equal(getCombatUnit(rejected.work, 2).effects.nextInstanceId, 3);
  const paused = setEffectParticipation(
    rejected.work,
    { unitId: 2, instanceId: 1 },
    false,
    resources,
    1,
  );
  const duplicate = installEffect(
    paused,
    2,
    resources.effects.create(candidate.ref, metadata(3)),
    resources,
    1,
  );
  assert.equal(duplicate.result.reason, "ADMISSION_REJECTED");
  assert.equal(getCombatUnit(duplicate.work, 2).effects.instances[0].state.attempts, 3);
  const resumed = setEffectParticipation(
    duplicate.work,
    { unitId: 2, instanceId: 1 },
    true,
    resources,
    1,
  );
  assert.deepEqual(
    getCombatUnit(resumed, 2)
      .effects.instances.filter(
        (instance) => instance.programRef === candidate.ref && instance.participating,
      )
      .map((instance) => instance.id),
    [1],
  );
  assert.deepEqual(finalized, [2, 3]);
  assert.equal(getCombatUnit(resumed, 2).effects.nextInstanceId, 4);
});

test("effects: parent finish stops a cross-unit child before independent finalization and identities are not reused", () => {
  const resources = new CombatResources();
  const parentProgram = resources.registerEffect(barrierProgram("parent"));
  const childProgram = resources.registerEffect(barrierProgram("child"), {
    bindings: [compileStatusBinding(["INVINCIBLE"])],
  });
  const finalized = [];
  for (const program of [parentProgram, childProgram]) {
    resources.effectLifecycle.register(program.ref, {
      finalize: (context) => {
        assert.equal(context.facts.getEffect(context.address), undefined);
        finalized.push(context.instance.programRef.id);
      },
    });
  }
  const source = { id: 7, definition: { id: "source" }, position: [0, 0] };
  const parentOwner = { id: 9, definition: { id: "parent-owner" }, position: [0, 0] };
  let work = effectFixtureWork(source, parentOwner, unit());
  work = installEffect(
    work,
    9,
    resources.effects.create(parentProgram.ref, metadata(1)),
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
  const parent = { unitId: 9, instanceId: 1 };
  const child = { unitId: 2, instanceId: 1 };
  work = attachEffectParent(work, child, parent, resources, 0).work;
  const finished = finishEffect(work, parent, resources, 1);

  assert.equal(getCombatUnit(finished, 7), source);
  assert.equal(getCombatUnit(finished, 9).effects.instances[0].finished, true);
  assert.equal(getCombatUnit(finished, 2).effects.instances[0].finished, true);
  assert.equal(hasStatusFlag(getCombatUnit(finished, 2), "INVINCIBLE"), false);
  assert.deepEqual(finalized, []);
  assert.equal(finishEffect(finished, parent, resources, 1), finished);

  const parentFinalized = finalizeEffect(finished, parent, resources, 1);
  assert.deepEqual(finalized, ["parent"]);
  assert.equal(getCombatUnit(parentFinalized, 2).effects.instances.length, 1);
  const cleared = finalizeEffect(parentFinalized, child, resources, 1);
  assert.deepEqual(finalized, ["parent", "child"]);
  assert.equal(finalizeEffect(cleared, child, resources, 1), cleared);
  assert.throws(
    () =>
      installEffect(
        cleared,
        9,
        resources.effects.create(parentProgram.ref, metadata(1)),
        resources,
        1,
      ),
    /cannot be reused/,
  );
  assert.equal(getCombatUnit(cleared, 9).effects.nextInstanceId, 2);
});

test("effects: unavailable parents end a child by default and explicit preservation rejects binding", () => {
  for (const reason of ["ABSENT", "FINISHED"]) {
    for (const preserve of [false, true]) {
      const resources = new CombatResources();
      const parentProgram = resources.registerEffect(barrierProgram("unavailable-parent"));
      const childProgram = resources.registerEffect(barrierProgram("child"), {
        bindings: [compileStatusBinding(["INVINCIBLE"])],
        contributions: [attack(() => [createNumericContribution({ finalAddition: 50 })])],
      });
      const receiver = initializeUnit({
        id: 2,
        position: [0, 0],
        definition: {
          id: "receiver",
          offense: { attack: 100 },
          status: { initialFlags: [] },
        },
      });
      const owner = { id: 9, definition: { id: "parent-owner" }, position: [0, 0] };
      const parent = { unitId: 9, instanceId: 1 };
      const child = { unitId: 2, instanceId: 1 };
      let work = effectFixtureWork(owner, receiver);
      if (reason === "FINISHED") {
        work = installEffect(
          work,
          9,
          resources.effects.create(parentProgram.ref, metadata(1)),
          resources,
          0,
        ).work;
        work = finishEffect(work, parent, resources, 0);
      }
      work = installEffect(
        work,
        2,
        resources.effects.create(childProgram.ref, metadata(1)),
        resources,
        0,
      ).work;
      assert.equal(resolveAttackPower(2, combatWorkView(work)), 150);
      const binding = preserve
        ? attachEffectParent(work, child, parent, resources, 1, false)
        : attachEffectParent(work, child, parent, resources, 1);
      const current = getCombatUnit(binding.work, 2);

      assert.deepEqual(binding.result, { type: "PARENT_UNAVAILABLE", reason });
      assert.equal(current.effects.instances[0].parent, null);
      assert.equal(current.effects.instances[0].finished, !preserve);
      assert.equal(current.offense.attack.entries[0].participating, preserve);
      assert.equal(hasStatusFlag(current, "INVINCIBLE"), preserve);
      assert.equal(resolveAttackPower(2, combatWorkView(binding.work)), preserve ? 150 : 100);
      if (preserve) {
        assert.equal(binding.work, work);
      }
    }
  }
});

test("effects: finish remains terminal when disable tries to reenable and finish the same instance", () => {
  const resources = new CombatResources();
  const program = resources.registerEffect(barrierProgram("reentrant"), {
    contributions: [attack(() => [createNumericContribution({ finalAddition: 50 })])],
    bindings: [compileStatusBinding(["INVINCIBLE"])],
    lifecycle: {
      disable: (context) => {
        disables++;
        assert.equal(context.instance.finished, true);
        assert.equal(context.instance.participating, false);
        assert.equal(context.facts.getEffect(context.address), context.instance);
        assert.equal(context.facts.getUnit(2).offense.attack.entries[0].participating, false);
        assert.equal(hasStatusFlag(context.facts.getUnit(2), "INVINCIBLE"), false);
        assert.deepEqual(
          context.facts.participating(2).map((instance) => instance.id),
          [2],
        );
        context.effects.setParticipation(context.address, true);
        context.effects.finish(context.address);
      },
      finalize: (context) => {
        assert.equal(context.facts.getEffect(context.address), undefined);
        const contribution = context.facts.getUnit(2).offense.attack.entries[0];
        assert.equal(contribution.participating, false);
        finalizedSample = contribution.values[0].finalAddition;
        finalizations.push("reentrant");
        context.effects.finish({ unitId: 2, instanceId: 2 });
      },
    },
  });
  const follower = resources.registerEffect(barrierProgram("follower"), {
    lifecycle: {
      finalize: () => {
        finalizations.push("follower");
      },
    },
  });
  let disables = 0;
  let finalizedSample;
  const finalizations = [];

  const owner = initializeUnit({
    id: 2,
    position: [0, 0],
    definition: { id: "receiver", offense: { attack: 100 }, status: { initialFlags: [] } },
  });
  let installed = installEffect(
    effectFixtureWork(owner),
    2,
    resources.effects.create(program.ref, metadata()),
    resources,
    0,
  ).work;
  installed = installEffect(
    installed,
    2,
    resources.effects.create(follower.ref, metadata(2)),
    resources,
    0,
  ).work;
  const address = { unitId: 2, instanceId: 1 };
  assert.equal(resolveAttackPower(2, combatWorkView(installed)), 150);
  assert.equal(hasStatusFlag(getCombatUnit(installed, 2), "INVINCIBLE"), true);

  const finished = finishEffect(installed, address, resources, 1);
  const receiver = getCombatUnit(finished, 2);
  assert.equal(disables, 1);
  assert.equal(receiver.effects.instances[0].finished, true);
  assert.equal(receiver.effects.instances[0].participating, false);
  assert.equal(receiver.offense.attack.entries[0].participating, false);
  assert.equal(resolveAttackPower(2, combatWorkView(finished)), 100);
  assert.equal(hasStatusFlag(receiver, "INVINCIBLE"), false);
  assert.equal(finishEffect(finished, address, resources, 1), finished);
  assert.equal(receiver.effects.instances[1].finished, false);
  const finalized = finalizeFinishedEffects(finished, 2, resources, 1);
  assert.equal(finalizedSample, 50);
  assert.deepEqual(finalizations, ["reentrant", "follower"]);
  assert.deepEqual(getCombatUnit(finalized, 2).effects.instances, []);
  assert.deepEqual(getCombatUnit(finalized, 2).offense.attack.entries, []);
});

test("effects: disabling preserves restartable samples and finishing a disabled instance does not dispatch disable twice", () => {
  const resources = new CombatResources();
  const disabled = [];
  let finalized = 0;
  const descriptor = resources.registerEffect(barrierProgram("disabled-then-finished"), {
    bindings: [compileStatusBinding(["INVINCIBLE"])],
    contributions: [attack(() => [createNumericContribution({ finalAddition: 50 })])],
    lifecycle: {
      disable: (context) => {
        disabled.push(context.instance.finished);
        assert.equal(context.instance.participating, false);
        assert.equal(context.facts.getUnit(2).offense.attack.entries[0].participating, false);
        assert.equal(hasStatusFlag(context.facts.getUnit(2), "INVINCIBLE"), false);
      },
      finalize: () => {
        finalized++;
      },
    },
  });
  const owner = initializeUnit({
    id: 2,
    position: [0, 0],
    definition: { id: "receiver", offense: { attack: 100 }, status: { initialFlags: [] } },
  });
  const installed = installEffect(
    effectFixtureWork(owner),
    2,
    resources.effects.create(descriptor.ref, metadata()),
    resources,
    0,
  ).work;
  const address = { unitId: 2, instanceId: 1 };
  const inactive = setEffectParticipation(installed, address, false, resources, 1);
  assert.equal(getCombatUnit(inactive, 2).effects.instances[0].finished, false);
  assert.equal(getCombatUnit(inactive, 2).offense.attack.entries[0].values[0].finalAddition, 50);
  const resumed = setEffectParticipation(inactive, address, true, resources, 2);
  assert.equal(resolveAttackPower(2, combatWorkView(resumed)), 150);
  const inactiveAgain = setEffectParticipation(resumed, address, false, resources, 3);
  const finished = finishEffect(inactiveAgain, address, resources, 4);
  assert.deepEqual(disabled, [false, false]);
  assert.equal(getCombatUnit(finished, 2).effects.instances[0].finished, true);
  assert.equal(setEffectParticipation(finished, address, true, resources, 4), finished);
  assert.equal(finalized, 0);
  const cleaned = finalizeFinishedEffects(finished, 2, resources, 4);
  assert.equal(finalized, 1);
  assert.deepEqual(getCombatUnit(cleaned, 2).offense.attack.entries, []);
});

test("effects: nested finalization during disable preserves the terminal continuation and finishes existing children", () => {
  const resources = new CombatResources();
  const events = [];
  const replacement = resources.registerEffect(barrierProgram("replacement"));
  const parent = resources.registerEffect(barrierProgram("nested-parent"), {
    bindings: [compileStatusBinding(["INVINCIBLE"])],
    lifecycle: {
      disable: (context) => {
        events.push("parent-disable");
        assert.equal(context.instance.finished, true);
        assert.equal(context.instance.participating, false);
        assert.equal(hasStatusFlag(context.facts.getUnit(2), "INVINCIBLE"), false);
        const installed = context.effects.install(2, replacement.ref, {
          source: null,
          scope: null,
          expiresAtTick: null,
        });
        assert.equal(installed.type, "INSTALLED");
        assert.equal(context.facts.getEffect(context.address), undefined);
        assert.equal(context.instance.finished, true);
        assert.equal(context.instance.state.remainingAmount, 500);
        context.effects.setParticipation(context.address, true);
        context.effects.finish(context.address);
        events.push("parent-continued");
      },
      finalize: (context) => {
        events.push("parent-finalize");
        assert.equal(context.instance.finished, true);
        assert.equal(context.facts.getEffect(context.address), undefined);
      },
    },
  });
  const child = resources.registerEffect(barrierProgram("nested-child"), {
    lifecycle: {
      disable: (context) => {
        events.push("child-disable");
        assert.equal(context.instance.finished, true);
        context.effects.finish({ unitId: 2, instanceId: 1 });
        context.effects.setParticipation(context.address, true);
      },
      finalize: () => {
        events.push("child-finalize");
      },
    },
  });
  let work = installEffect(
    effectFixtureWork(unit()),
    2,
    resources.effects.create(parent.ref, metadata(1)),
    resources,
    0,
  ).work;
  work = installEffect(
    work,
    2,
    resources.effects.create(child.ref, metadata(2)),
    resources,
    0,
  ).work;
  const parentAddress = { unitId: 2, instanceId: 1 };
  const childAddress = { unitId: 2, instanceId: 2 };
  work = attachEffectParent(work, childAddress, parentAddress, resources, 0).work;
  const finished = finishEffect(work, parentAddress, resources, 1);

  assert.deepEqual(events, [
    "parent-disable",
    "parent-finalize",
    "parent-continued",
    "child-disable",
  ]);
  const instances = getCombatUnit(finished, 2).effects.instances;
  assert.equal(instances[0].id, 2);
  assert.equal(instances[0].finished, true);
  assert.equal(instances[0].participating, false);
  assert.equal(instances[1].programRef, replacement.ref);
  assert.equal(instances[1].participating, true);
  assert.equal(finishEffect(finished, parentAddress, resources, 1), finished);
  const finalized = finalizeFinishedEffects(finished, 2, resources, 1);
  assert.deepEqual(events, [
    "parent-disable",
    "parent-finalize",
    "parent-continued",
    "child-disable",
    "child-finalize",
  ]);
  assert.deepEqual(
    getCombatUnit(finalized, 2).effects.instances.map((instance) => instance.programRef),
    [replacement.ref],
  );
  assert.equal(getCombatUnit(work, 2).effects.instances[0].finished, false);
  assert.equal(hasStatusFlag(getCombatUnit(work, 2), "INVINCIBLE"), true);
});

test("effects: TypeScript preserves invariant program state references and typed combat hook inference", async () => {
  const { default: ts } = await import("typescript");
  const directory = mkdtempSync(join(tmpdir(), "stronghold-effect-types-"));
  const sourceModule = (name) =>
    JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)));
  const imports = `
import { createEffectProgram, type EffectProgram, type EffectProgramRef } from ${sourceModule("unit/capability/effects/program")};
import { EffectResources } from ${sourceModule("unit/capability/effects/registry")};
import type { EffectInstanceValue } from ${sourceModule("unit/capability/effects/instance")};
import { installEffect } from ${sourceModule("unit/capability/effects/lifecycle")};
import type { CombatWork } from ${sourceModule("battle/execution/work")};
import { CombatResources } from ${sourceModule("battle/resources")};
import type { DamageRuleContext, DamageFormulaContext, DamageQueryContext } from ${sourceModule("unit/capability/vitality/damage/resources")};
import type { PendingDamage } from ${sourceModule("unit/capability/vitality/damage/contract")};
import { createProjectileProgram, type ProjectileProgramRef } from ${sourceModule("battlefield/projectile/program")};
import { effectSourceInstallation, type EffectSourceInstallation } from ${sourceModule("battlefield/effect-source/program")};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
interface BarrierState { readonly remainingAmount: number; }
interface ShieldState { readonly remainingCharges: number; }
interface SpecializedBarrierState extends BarrierState { readonly category: 'arts'; }
function ownBarrierState(value: unknown): BarrierState {
  if (value === null || typeof value !== 'object' || !('remainingAmount' in value)
      || typeof value.remainingAmount !== 'number' || !Number.isFinite(value.remainingAmount)) {
    throw new TypeError('invalid barrier state');
  }
  return Object.freeze({ remainingAmount: value.remainingAmount });
}
const barrier = createEffectProgram({
  id: 'barrier', initialize: (): BarrierState => ({ remainingAmount: 500 }), ownState: ownBarrierState,
});
const resources = new EffectResources();
declare const installationResources: CombatResources;
declare const work: CombatWork;
resources.register(barrier);
const instance = resources.create(barrier.ref, {
  id: 1, source: null, scope: null, acquiredSequence: 0, expiresAtTick: null,
});
`;
  const compile = (name, source) => {
    const path = join(directory, `${name}.mts`);
    writeFileSync(path, imports + source);
    const program = ts.createProgram([path], {
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      types: [],
    });

    return ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
      file: diagnostic.file?.fileName,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    }));
  };

  try {
    assert.deepEqual(
      compile(
        "positive",
        `
type InferredReference = Assert<Equal<typeof barrier.ref, EffectProgramRef<BarrierState>>>;
type InferredState = Assert<Equal<typeof instance.state, BarrierState>>;
installEffect(work, 2, instance, installationResources, 0);
const restored = resources.restore(barrier.ref, instance);
type RestoredState = Assert<Equal<typeof restored.state, BarrierState>>;
const descriptor = resources.get(barrier.ref);
type InferredDescriptor = Assert<Equal<typeof descriptor, EffectProgram<BarrierState>>>;
const updated = resources.update(instance, { remainingAmount: 200 });
type UpdatedState = Assert<Equal<typeof updated.state, BarrierState>>;
const current = resources.typedState(updated, barrier.ref);
type OptionalState = Assert<Equal<typeof current, BarrierState | undefined>>;
const projectile = createProjectileProgram({
  id: 'typed-projectile', initialize: (): BarrierState => ({ remainingAmount: 1 }),
  ownState: state => ({ remainingAmount: state.remainingAmount }), acceptsContact: () => true,
});
type ProjectileReference = Assert<Equal<typeof projectile.ref, ProjectileProgramRef<BarrierState>>>;
const installation = effectSourceInstallation(barrier.ref, { expiresAtTick: null, initialState: instance.state });
const installed = installation((ref, input) => resources.create(ref, {
  id: 2, source: null, scope: null, acquiredSequence: 1, expiresAtTick: input.expiresAtTick,
}, input.initialState).id);
type InstalledIdentity = Assert<Equal<typeof installed, number>>;
resources.withProgram(instance, (bound, program) => resources.update(bound, bound.state).id);
const combat = new CombatResources();
combat.registerEffect(barrier, {
 damage: {
  reception: { priority: 0, apply: (context, pending) => {
    const amount: number = context.instance.state.remainingAmount;
    context.operations.effects.update(context.address, context.instance.programRef, state => ({ remainingAmount: Math.max(0, state.remainingAmount - pending.amount) }));
    return { value: pending };
  } },
  reaction: { priority: 0, apply: (context, report) => {
    const amount: number = context.instance.state.remainingAmount;
    const hpLoss: number = report.hpLoss;
    context.operations.effects.update(context.address, context.instance.programRef, state => ({ remainingAmount: state.remainingAmount + hpLoss }));
  } },
 },
 healing: {
  reception: { priority: 0, apply: (context, pending) => {
    const amount: number = context.instance.state.remainingAmount;
    context.operations.effects.update(context.address, context.instance.programRef, state => ({ remainingAmount: state.remainingAmount + amount }));
    return { value: pending };
  } },
 },
 lifecycle: {
  start: context => { context.effects.update(context.address, barrier.ref, state => ({ remainingAmount: state.remainingAmount })); },
 },
});
`,
      ),
      [],
    );

    for (const [name, source, errors] of [
      [
        "references",
        `
declare const specializedRef: EffectProgramRef<SpecializedBarrierState>;
const incompatible: EffectProgramRef<ShieldState> = barrier.ref;
const cannotWiden: EffectProgramRef<BarrierState> = specializedRef;
const cannotNarrow: EffectProgramRef<SpecializedBarrierState> = barrier.ref;
const cannotForge: EffectProgramRef<ShieldState> = { id: 'barrier' };
`,
        4,
      ],
      ["state-update", `resources.update(instance, { remainingCharges: 2 });`, 1],
      ["direct-install-wrong-state", `installEffect(work, 2, { ...instance, state: { remainingCharges: 2 } }, installationResources, 0);`, 1],
      ["direct-install-erased", `const erased: EffectInstanceValue = { ...instance, state: { remainingCharges: 2 } }; installEffect(work, 2, erased, installationResources, 0);`, 1],
      ["direct-install-widened", `installEffect<object>(work, 2, instance, installationResources, 0);`, 1],
      ["unparsed-restore", `declare const raw: unknown; resources.restore(barrier.ref, raw);`, 1],
      ["wrong-restore-state", `resources.restore(barrier.ref, { ...instance, state: { remainingCharges: 2 } });`, 1],
      ["wrong-installation-state", `effectSourceInstallation(barrier.ref, { expiresAtTick: null, initialState: { remainingCharges: 2 } });`, 1],
      ["erased-installation", `const installation: EffectSourceInstallation = { programRef: barrier.ref, initialState: { remainingCharges: 2 }, expiresAtTick: null };`, 1],
      [
        "hook-authority",
        `
declare const formula: DamageFormulaContext<BarrierState>;
declare const query: DamageQueryContext<BarrierState>;
declare const reception: DamageRuleContext<BarrierState>;
query.operations;
formula.operations.damage({});
formula.operations.heal({});
reception.work;
reception.resources;
reception.operations.spawn;
`,
        6,
      ],
      [
        "async-lifecycle",
        `
const combat = new CombatResources();
combat.registerEffect(barrier, { lifecycle: { start: async context => { await Promise.resolve(); context.effects.finish(context.address); } } });
`,
        1,
      ],
      [
        "void-lifecycle",
        `
declare const start: (context: import(${sourceModule("unit/capability/effects/contract")}).EffectLifecycleContext<BarrierState>) => void;
const combat = new CombatResources();
combat.registerEffect(barrier, { lifecycle: { start } });
`,
        1,
      ],
      [
        "flat-rules",
        `
const combat = new CombatResources();
combat.registerEffect(barrier, { reception: { priority: 0, apply: () => undefined } });
`,
        1,
      ],
      [
        "third-argument",
        `
const combat = new CombatResources();
combat.registerEffect(barrier, {}, []);
`,
        1,
      ],
      [
        "combat-hook",
        `
const combat = new CombatResources();
combat.registerEffect(barrier, {
 damage: {
  reception: { priority: 0, apply: (context: DamageRuleContext<ShieldState>, pending: PendingDamage) => ({ value: pending }) },
 },
});
`,
        1,
      ],
    ]) {
      const diagnostics = compile(name, source);
      const ownErrors = diagnostics.filter(
        (diagnostic) => diagnostic.file === join(directory, `${name}.mts`),
      );

      assert.equal(
        ownErrors.length,
        errors,
        `${name} must reject every mismatched state binding: ${JSON.stringify(diagnostics)}`,
      );
      assert.equal(
        diagnostics.length,
        ownErrors.length,
        `${name} must not rely on unrelated compilation failures: ${JSON.stringify(diagnostics)}`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
