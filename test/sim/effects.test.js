import { fixtureBattlefield } from "../helpers/battlefield.js";
import { ActionExecutionWork } from "../../dist/core/tactical/unit/capability/action/internal/executions.js";
import { attack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEffectDefinition } from "../../dist/core/tactical/unit/capability/effects/definition.js";
import { EffectResources } from "../../dist/core/tactical/unit/capability/effects/registry.js";
import {
  expireEffects,
  installEffect,
  installNewEffect,
  removeEffect,
  closeEffectLifetimes,
  setEffectEnabled,
  finishEffect,
  finalizeEffect,
  finalizeFinishedEffects,
  bindEffectLifetime,
} from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { createBattleState, battlefieldView, getUnit } from "../../dist/core/tactical/battle/execution/context.js";
import * as modifier from "../../dist/core/tactical/contribution/value.js";
import { updateAttackContributions } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { compileStatusBinding } from "../../dist/core/tactical/unit/capability/status/binding.js";
import { uniqueEffectAdmission } from "../../dist/core/tactical/unit/capability/effects/lifecycle-resources.js";
import { effectFixtureWork, installFixtureEffect } from "../helpers/effects.js";
import {
  registerEffect,
  replaceEffect,
} from "../../dist/core/tactical/unit/capability/effects/internal/state.js";
import { updateEffectState } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import {
  createStatusDefinition,
  hasStatusFlag,
  initializeStatusState,
} from "../../dist/core/tactical/unit/capability/status/capability.js";

function barrierDefinition(id = "barrier") {
  return createEffectDefinition({
    id,
    initialize: () => ({ remainingAmount: 500 }),

  });
}

function metadata(id = 1, overrides = {}) {
  return {
    id,
    source: 7,
    scopes: [],
    acquiredSequence: id,

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

test("effects: installation shares typed state and lifecycle updates preserve the input", () => {
  const resources = new CombatResources();
  const observed = [];
  const definition = resources.registerEffect(createEffectDefinition({
    id: "shared-direct",
    initialize: () => ({ remainingAmount: 10 }),
  }), { lifecycle: { start: context => { observed.push(context.instance.state); } } });
  const original = effectFixtureWork(unit());
  const state = { remainingAmount: 5 };
  const scopes = [];
  const instance = resources.effects.create(definition.ref, metadata(1, { scopes }), state);
  assert.equal(instance.state, state);
  assert.equal(instance.scopes, scopes);
  const installed = installEffect(original, 2, instance, resources, 0);
  const current = getUnit(original, 2).effects.instances[0];

  assert.equal(installed.type, "INSTALLED");
  assert.equal(observed[0], state);
  assert.equal(current.state, state);
  assert.equal(current.scopes, scopes);
  assert.equal(current.started, true);
  assert.equal(instance.started, false);
  assert.equal(original.battlefield.snapshot("state").getUnit(2).effects, undefined);

  const nextState = { remainingAmount: 7 };
  const newInstallation = installNewEffect(original, 2, definition.ref, {
    source: null, scopes: [], initialState: nextState,
  }, resources, 0);
  assert.equal(newInstallation.type, "INSTALLED");
  assert.equal(getUnit(original, 2).effects.instances[1].state, nextState);
  assert.deepEqual(observed, [state, nextState]);
});

test("effects: direct installation accepts only a fresh lifecycle instance", () => {
  const resources = new CombatResources();
  const definition = resources.registerEffect(barrierDefinition());
  const instance = resources.effects.create(definition.ref, metadata());
  const original = effectFixtureWork(unit());
  assert.throws(() => installEffect(original, 2, { ...instance, started: true }, resources, 0), /only a fresh effect/);
  assert.equal(original.battlefield.snapshot("state").getUnit(2).effects, undefined);
  const installed = installEffect(original, 2, instance, resources, 0);
  assert.equal(installed.type, "INSTALLED");
});

test("effects: missing direct-install receivers return absence before definition lookup", () => {
  const resources = new CombatResources();
  const foreign = new EffectResources();
  const definition = foreign.register(barrierDefinition());
  const instance = foreign.create(definition.ref, metadata());
  const original = effectFixtureWork(unit());
  const installation = installEffect(original, 99, {
    ...instance, state: { remainingAmount: -1 },
  }, resources, 0);

  assert.deepEqual(installation, {
    type: "REJECTED", reason: "TARGET_ABSENT",
  });
});

test("effects: instance restoration validates lifecycle facts and shares typed state", () => {
  const resources = new EffectResources();
  const definition = resources.register(barrierDefinition());
  const instance = resources.create(definition.ref, metadata());
  const serialized = JSON.parse(JSON.stringify(instance));
  const restored = resources.restore(definition.ref, serialized);

  assert.deepEqual(instance.definitionRef, { id: "barrier" });
  assert.deepEqual(Object.keys(definition.ref), ["id"]);
  assert.deepEqual(restored, instance);
  assert.equal(restored.definitionRef, definition.ref);
  assert.equal(resources.typedState(restored, definition.ref).remainingAmount, 500);
  assert.equal(restored.state, serialized.state);
  assert.equal(restored.scopes, serialized.scopes);
  assert.throws(() => resources.restore(definition.ref, { ...serialized, participating: true }), /invalid effect lifecycle/);
  assert.throws(() => resources.restore(definition.ref, { ...serialized, id: -1 }), /identity/);
  assert.throws(
    () => resources.restore(barrierDefinition().ref, serialized),
    /unregistered/,
  );
});

test("effects: reference and descriptor binding cannot be replaced by a second schema with the same identity", () => {
  const resources = new EffectResources();
  const definition = resources.register(barrierDefinition());
  const other = barrierDefinition();

  assert.equal(resources.register(definition), definition);
  assert.throws(() => resources.register(other), /duplicate effect definition/);
  assert.throws(() => resources.get(other.ref), /unregistered effect definition/);
  const runtimeResources = new CombatResources();
  runtimeResources.registerEffect(definition);
  const foreignResources = new EffectResources();
  const foreign = foreignResources.register(
    createEffectDefinition({
      id: definition.ref.id,
      initialize: () => ({ remainingCharges: 2 }),
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
    /unregistered effect definition/,
  );
});

test("effects: typed updates share new state and preserve the previous instance", () => {
  const lifecycleResources = new CombatResources();
  const resources = lifecycleResources.effects;
  const definition = lifecycleResources.registerEffect(barrierDefinition());
  const instance = resources.create(definition.ref, metadata());
  const input = { remainingAmount: 200, details: { applications: [1, 2] } };
  const updated = resources.update(instance, input);
  const installed = installFixtureEffect(unit(), updated, lifecycleResources);

  assert.equal(instance.state.remainingAmount, 500);
  assert.equal(updated.state, input);
  assert.equal(updated.scopes, instance.scopes);
  assert.equal(resources.update(updated, updated.state), updated);
  assert.equal(installed.effects.instances[0].state, input);
  assert.equal(installed.effects.instances[0].state.details, input.details);
});

test("effects: immutable updates preserve unchanged instances across branches and cleanup", () => {
  const resources = new CombatResources();
  const definition = resources.registerEffect(barrierDefinition());
  const first = installFixtureEffect(
    unit(),
    resources.effects.create(definition.ref, metadata(1)),
    resources,
  );
  const second = installFixtureEffect(
    first,
    resources.effects.create(definition.ref, metadata(2)),
    resources,
  );
  const work = effectFixtureWork(second);
  const address = { type: "EFFECT", unitId: 2, effectId: 2 };
  let calls = 0;
  const unchanged = work;
updateEffectState(
    unchanged,
    2,
    2,
    definition.ref,
    (state) => {
      calls++;
      return state;
    },
    resources, 0,
  );
  const branchState = createBattleState(fixtureBattlefield(work.battlefield.snapshot('draft')));
  const updated = work;
updateEffectState(updated, 2, 2, definition.ref, { remainingAmount: 100 }, resources, 0);
  const updatedUnit = getUnit(updated, 2);
  const branch = branchState;
updateEffectState(branch, 2, 2, definition.ref, { remainingAmount: 200 }, resources, 0);
  const disabled = updated;
  setEffectEnabled(disabled, address, false, resources, 1);
  const disabledUnit = getUnit(disabled, 2);
  const finished = disabled;
  finishEffect(finished, address, resources, 1);
  const finishedUnit = getUnit(finished, 2);
  const cleaned = finished;
  finalizeEffect(cleaned, address, resources, 1);
  const retained = getUnit(cleaned, 2).effects;

  assert.equal(calls, 1);
  assert.equal(unchanged, work);
  assert.equal(first.effects.instances[0], second.effects.instances[0]);
  assert.equal(second.effects.instances[1].state.remainingAmount, 500);
  assert.equal(updatedUnit.effects.instances[1].state.remainingAmount, 100);
  assert.equal(getUnit(branch, 2).effects.instances[1].state.remainingAmount, 200);
  assert.equal(updatedUnit.effects.instances[1].participating, true);
  assert.equal(disabledUnit.effects.instances[1].finished, false);
  const changedUnits = [updatedUnit, getUnit(branch, 2), disabledUnit, finishedUnit, getUnit(cleaned, 2)];
  for (const current of [first, second, ...changedUnits]) {
    assert.equal(current.effects.instances[0], first.effects.instances[0]);
  }
  assert.deepEqual(retained.instances.map((instance) => instance.id), [1]);
  assert.equal(retained.nextInstanceId, 3);
  assert.equal(retained.nextAcquiredSequence, 3);
  assert.equal(finishedUnit.effects.instances.length, 2);
  const empty = cleaned;
removeEffect(empty, { type: "EFFECT", unitId: 2, effectId: 1 }, resources, 1);
  const emptyState = getUnit(empty, 2).effects;
  assert.deepEqual(emptyState.instances, []);
  assert.equal(emptyState.nextInstanceId, retained.nextInstanceId);
  assert.equal(emptyState.nextAcquiredSequence, retained.nextAcquiredSequence);
});

test("effects: creation validates scope identities and deduplicates lifetime dependencies", () => {
  const resources = new EffectResources();
  const definition = resources.register(barrierDefinition());
  const lifetime = { type: "UNIT", unitId: 2 };
  const scopes = [lifetime];
  const first = resources.create(definition.ref, metadata(1, { scopes }));
  assert.equal(first.scopes, scopes);
  assert.equal(first.scopes[0], lifetime);
  const deduplicated = resources.create(definition.ref, metadata(2, { scopes: [lifetime, lifetime] }));
  assert.deepEqual(deduplicated.scopes, [lifetime]);
  assert.equal(deduplicated.scopes[0], lifetime);
  assert.throws(() => resources.create(definition.ref, metadata(3, { scopes: [
    { type: "TICK", tick: 2 }, { type: "TICK", tick: 3 },
  ] })), /only one TICK/);
  assert.throws(() => resources.create(definition.ref, metadata(3, { scopes: [
    { type: "EFFECT", unitId: NaN, effectId: -1 },
  ] })), /scope unit identity/);
  for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resources.create(definition.ref, metadata(invalid)), /identity/);
    assert.throws(() => resources.create(definition.ref, metadata(3, { acquiredSequence: invalid })), /acquired sequence/);
  }

  const original = registerEffect(unit(), first);
  assert.equal(original.effects.instances[0], first);
  assert.throws(() => registerEffect(original, first), /cannot be reused/);
  assert.throws(() => replaceEffect(original, first, deduplicated), /cannot be changed/);
  assert.throws(() => registerEffect(original, resources.create(definition.ref, metadata(Number.MAX_SAFE_INTEGER))), /allocation progress/);
});

test("effects: heterogeneous dispatch remains paired and an unrelated typed definition cannot update an instance", () => {
  const resources = new EffectResources();
  const barrier = resources.register(barrierDefinition());
  const shield = resources.register(
    createEffectDefinition({
      id: "shield",
      initialize: () => ({ remainingCharges: 2 }),
    }),
  );
  const instance = resources.create(barrier.ref, metadata());

  assert.equal(resources.typedState(instance, shield.ref), undefined);
  assert.equal(resources.typedEffect(instance, shield.ref), undefined);
  assert.deepEqual(
    resources.withDefinition(instance, (bound, descriptor) => [
      bound.definitionRef.id,
      descriptor.ref.id,
    ]),
    ["barrier", "barrier"],
  );
});

test("effects: state updates share unchanged nested values", () => {
  const resources = new EffectResources();
  const definition = resources.register(barrierDefinition());
  const sample = { applications: [1, 2] };
  const original = resources.create(definition.ref, metadata(), { remainingAmount: 500, sample });
  const nextState = { ...original.state, remainingAmount: 250 };
  const updated = resources.update(original, nextState);

  assert.equal(updated.state, nextState);
  assert.equal(updated.state.sample, original.state.sample);
  assert.equal(original.state.remainingAmount, 500);
  assert.equal(updated.state.remainingAmount, 250);
});

test("effects: installation and removal keep effect identity and status contributions atomic", () => {
  const resources = new CombatResources();
  const definition = resources.registerEffect(barrierDefinition(), {
    bindings: [compileStatusBinding(["INVINCIBLE"])],
  });
  const original = unit();
  const first = installFixtureEffect(
    original,
    resources.effects.create(definition.ref, metadata(1)),
    resources,
  );
  const second = installFixtureEffect(
    first,
    resources.effects.create(definition.ref, metadata(2)),
    resources,
  );
  const work = effectFixtureWork(second);
  const removed = work;
removeEffect(removed, { type: "EFFECT", unitId: 2, effectId: 1 }, resources, 0);
  const removedUnit = getUnit(removed, 2);
  const cleared = removed;
removeEffect(cleared, { type: "EFFECT", unitId: 2, effectId: 2 }, resources, 0);

  assert.equal(original.effects, undefined);
  assert.equal(hasStatusFlag(original, "INVINCIBLE"), false);
  assert.equal("statusContributionId" in first.effects.instances[0], false);
  assert.equal(hasStatusFlag(removedUnit, "INVINCIBLE"), true);
  assert.equal(removedUnit.effects.instances[0].id, 2);
  assert.equal(hasStatusFlag(getUnit(cleared, 2), "INVINCIBLE"), false);
  assert.deepEqual(getUnit(cleared, 2).status.contributions, original.status.contributions);
  removeEffect(cleared, { type: "EFFECT", unitId: 2, effectId: 99 }, resources, 0);
});

test("effects: installing flags requires existing Status and baseline facts survive effect removal", () => {
  const resources = new CombatResources();
  const definition = resources.registerEffect(barrierDefinition(), {
    bindings: [compileStatusBinding(["INVINCIBLE"])],
  });
  const instance = resources.effects.create(definition.ref, metadata());
  const bare = { id: 2, definition: { id: "bare" }, position: [0, 0] };
  const baseline = unit(["INVINCIBLE"]);

  assert.throws(() => installFixtureEffect(bare, instance, resources), /existing Status/);
  assert.equal(bare.effects, undefined);
  const plain = resources.registerEffect(barrierDefinition("plain"));
  const installed = installFixtureEffect(
    bare,
    resources.effects.create(plain.ref, metadata()),
    resources,
  );
  assert.equal(installed.effects.instances[0].id, instance.id);
  const marked = installFixtureEffect(baseline, instance, resources);
  const removed = effectFixtureWork(marked);
removeEffect(
    removed,
    { type: "EFFECT", unitId: 2, effectId: 1 },
    resources,
    0,
  );
  assert.equal(hasStatusFlag(getUnit(removed, 2), "INVINCIBLE"), true);
});

test("effects: expiration is independent of source and lifetime scope cleanup does not filter by source", () => {
  const resources = new CombatResources();
  const definition = resources.registerEffect(barrierDefinition(), {
    bindings: [compileStatusBinding(["HEAL_FREE"])],
  });
  const owner7 = { id: 7, definition: { id: "owner7" }, position: [0, 0] };
  const owner9 = { id: 9, definition: { id: "owner9" }, position: [0, 0] };
  const actions = new ActionExecutionWork({ nextExecutionId: 12, executions: [10, 11].map(id => ({
    id, sourceUnitId: 9, definition: { segments: [] }, acceptedAtTick: 0, inputTargetUnitId: null, cursor: 0, bindings: {}, samples: {}, wait: null,
  })) });
  let work = { ...effectFixtureWork(unit(), owner7, owner9), actionExecutions: actions };
  const values = [
    metadata(1, { source: 9, scopes: [{type: "UNIT",unitId: 7}, { type: "TICK", tick: 5 }] }),
    metadata(2, {
      source: 7,
      scopes: [{type: "ACTION",executionId: 10}],
    }),
    metadata(3, {
      source: 7,
      scopes: [{type: "ACTION",executionId: 11}],
    }),
    metadata(4, { source: 9, scopes: [] }),
  ];

  for (const value of values) {
    installEffect(work, 2, resources.effects.create(definition.ref, value), resources, 0);
  }

  const activeIds = (work) =>
    getUnit(work, 2)
      .effects.instances.filter((effect) => effect.participating)
      .map((effect) => effect.id);
  expireEffects(work, 4, resources);
  const originalState = createBattleState(fixtureBattlefield(work.battlefield.snapshot('draft')), work.execution, work.actionExecutions);
  const expired = work;
  expireEffects(expired, 5, resources);
  assert.deepEqual(activeIds(expired), [2, 3, 4]);
  assert.equal(getUnit(expired, 2).effects.instances.length, 4);
  finalizeFinishedEffects(expired, 2, resources, 5);
  assert.deepEqual(
    getUnit(expired, 2).effects.instances.map((effect) => effect.id),
    [2, 3, 4],
  );
  const singleAction = createBattleState(fixtureBattlefield(originalState.battlefield.snapshot('draft')), originalState.execution, actions);
  closeEffectLifetimes(singleAction, [{ type: "ACTION", executionId: 10 }], resources, 0);
  assert.deepEqual(activeIds(singleAction), [1, 3, 4]);
  closeEffectLifetimes(originalState, [{ type: "ACTION", executionId: 10 }, { type: "ACTION", executionId: 11 }], resources, 0);
  assert.deepEqual(activeIds(originalState), [1, 4]);
});

test("effects: start can read its registered identity before status bindings participate", () => {
  const resources = new CombatResources();
  const definition = resources.registerEffect(barrierDefinition(), {
    bindings: [compileStatusBinding(["INVINCIBLE"])],
    lifecycle: {
      start: (context) => {
        observed.push([
          context.facts.getEffect(context.ref).id,
          context.instance.started,
          context.facts.participating(context.ref.unitId).length,
          hasStatusFlag(context.facts.getUnit(context.ref.unitId), "INVINCIBLE"),
        ]);
        context.effects.update(context.ref, definition.ref, (state) => ({
          ...state,
          remainingAmount: 100,
        }));
        assert.equal(context.instance.state.remainingAmount, 100);
      },
      enable: (context) => {
        observed.push([
          context.instance.started,
          hasStatusFlag(context.facts.getUnit(context.ref.unitId), "INVINCIBLE"),
        ]);
      },
    },
  });
  const observed = [];

  const resultState = effectFixtureWork(unit());
  const result = installEffect(
    resultState,
    2,
    resources.effects.create(definition.ref, metadata()),
    resources,
    0,
  );

  assert.equal(result.type, "INSTALLED");
  assert.deepEqual(observed, [
    [1, false, 0, false],
    [true, true],
  ]);
  assert.equal(getUnit(resultState, 2).effects.instances[0].participating, true);
});

test("effects: start termination preserves its prefix without initializing or removing bindings", () => {
  const resources = new CombatResources();
  const keeper = resources.registerEffect(
    createEffectDefinition({
      id: "keeper",
      initialize: () => ({ attempts: 0 }),
    }),
  );
  const binding = compileStatusBinding(["INVINCIBLE"]);
  let installed = 0;
  let removed = 0;
  const finalizations = [];
  const definition = resources.registerEffect(barrierDefinition("start-terminated"), {
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
        context.effects.update({ type: "EFFECT", unitId: 2, effectId: 0 }, keeper.ref, (state) => ({
          attempts: state.attempts + 1,
        }));
        context.effects.update(context.ref, definition.ref, () => ({
          remainingAmount: 200,
        }));
        context.effects.finish([context.ref]);
        assert.equal(context.instance.finished, true);
        assert.equal(context.instance.participating, false);
        assert.equal(context.facts.participating(2).length, 1);
      },
      finish: (context) => {
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
    resources.effects.create(definition.ref, metadata(1)),
    resources,
    0,
  );

  assert.deepEqual(result, {
    type: "ENDED",
    ref: { type: "EFFECT", unitId: 2, effectId: 1 },
  });
  assert.deepEqual(finalizations, [[false, true, 200]]);
  assert.equal(installed, 0);
  assert.equal(removed, 0);
  assert.deepEqual(
    getUnit(original, 2).effects.instances.map((instance) => instance.id),
    [0, 1],
  );
  assert.equal(getUnit(original, 2).effects.instances[0].state.attempts, 1);
  assert.equal(getUnit(original, 2).effects.nextInstanceId, 2);
  assert.equal(original.battlefield.snapshot("state").getUnit(2).effects.instances[0].state.attempts, 0);
});

test("effects: lifecycle facts and operation leases close on normal and exceptional callback exits", () => {
  for (const throws of [false, true]) {
    const resources = new CombatResources();
    let escaped;
    const definition = resources.registerEffect(barrierDefinition(), {
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
      installEffect(original, 2, resources.effects.create(definition.ref, metadata()), resources, 0);
    let result;
    if (throws) {
      assert.throws(install, /start failed/);
    } else {
      result = install();
    }
    const input = { source: null, scopes: [], };
    const calls = [
      () => escaped.instance,
      () => escaped.heal({ sourceUnitId: null, targetUnitId: 2, power: 1 }),
      () => escaped.damage({ sourceUnitId: null, targetUnitId: 2, damageType: "TRUE", operands: { power: 1 } }),
      () => escaped.facts.getUnit(2),
      () => escaped.facts.getEffect(escaped.ref),
      () => escaped.facts.participating(2),
      () => escaped.effects.install(2, definition.ref, input),
      () => escaped.effects.update(escaped.ref, definition.ref, (state) => state),
      () => escaped.effects.setEnabled(escaped.ref, false),
      () => escaped.effects.setTick(escaped.ref, null),
      () => escaped.effects.finish([escaped.ref]),
      () => escaped.effects.bind(escaped.ref, { type: "EFFECT", unitId: 2, effectId: 99 }),
    ];
    for (const call of calls) {
      assert.throws(call, /no longer active/);
    }
    if (result !== undefined) {
      assert.equal(getUnit(original, 2).effects.instances[0].participating, true);
      assert.equal(getUnit(original, 2).effects.instances[0].finished, false);
    }
  }
});

test("effects: rejected unique installation runs no start and consumes no identity", () => {
  const resources = new CombatResources();
  const keeper = resources.registerEffect(
    createEffectDefinition({
      id: "keeper",
      initialize: () => ({ attempts: 0 }),
    }),
  );
  const candidate = resources.registerEffect(barrierDefinition("unique"), {
    lifecycle: {
      start: (context) => {
        context.effects.update({ type: "EFFECT", unitId: 2, effectId: 0 }, keeper.ref, (state) => ({
          attempts: state.attempts + 1,
        }));
      },
      accepts: uniqueEffectAdmission("unique"),
      finish: (context) => {
        finalized.push(context.ref.effectId);
      },
    },
  });
  const finalized = [];

  let work = effectFixtureWork(unit());
  installEffect(
    work,
    2,
    resources.effects.create(keeper.ref, metadata(0)),
    resources,
    0,
  );
  const accepted = installEffect(
    work,
    2,
    resources.effects.create(candidate.ref, metadata(1)),
    resources,
    0,
  );
  const rejected = installEffect(
    work,
    2,
    resources.effects.create(candidate.ref, metadata(2)),
    resources,
    0,
  );

  assert.equal(accepted.type, "INSTALLED");
  assert.equal(rejected.reason, "ADMISSION_REJECTED");
  assert.equal(getUnit(work, 2).effects.instances[0].state.attempts, 1);
  assert.deepEqual(
    getUnit(work, 2).effects.instances.map((instance) => instance.id),
    [0, 1],
  );
  assert.deepEqual(finalized, []);
  assert.equal(getUnit(work, 2).effects.nextInstanceId, 2);
  const paused = work;
  setEffectEnabled(
    paused,
    { type: "EFFECT", unitId: 2, effectId: 1 },
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
  assert.equal(duplicate.reason, "ADMISSION_REJECTED");
  assert.equal(getUnit(paused, 2).effects.instances[0].state.attempts, 1);
  const resumed = paused;
  setEffectEnabled(
    resumed,
    { type: "EFFECT", unitId: 2, effectId: 1 },
    true,
    resources,
    1,
  );
  assert.deepEqual(
    getUnit(resumed, 2)
      .effects.instances.filter(
        (instance) => instance.definitionRef === candidate.ref && instance.participating,
      )
      .map((instance) => instance.id),
    [1],
  );
  assert.deepEqual(finalized, []);
  assert.equal(getUnit(resumed, 2).effects.nextInstanceId, 2);
});

test("effects: parent finish stops a cross-unit child before independent finalization and identities are not reused", () => {
  const resources = new CombatResources();
  const parentDefinition = resources.registerEffect(barrierDefinition("parent"));
  const childDefinition = resources.registerEffect(barrierDefinition("child"), {
    bindings: [compileStatusBinding(["INVINCIBLE"])],
  });
  const finalized = [];
  for (const definition of [parentDefinition, childDefinition]) {
    resources.effectLifecycle.register(definition.ref, {
      finish: (context) => {
        assert.equal(context.facts.getEffect(context.ref).finished, true);
        finalized.push(context.instance.definitionRef.id);
      },
    });
  }
  const source = { id: 7, definition: { id: "source" }, position: [0, 0] };
  const parentOwner = { id: 9, definition: { id: "parent-owner" }, position: [0, 0] };
  let work = effectFixtureWork(source, parentOwner, unit());
  installEffect(
    work,
    9,
    resources.effects.create(parentDefinition.ref, metadata(1)),
    resources,
    0,
  );
  installEffect(
    work,
    2,
    resources.effects.create(childDefinition.ref, metadata(1)),
    resources,
    0,
  );
  const parent = { type: "EFFECT", unitId: 9, effectId: 1 };
  const child = { type: "EFFECT", unitId: 2, effectId: 1 };
  bindEffectLifetime(work, child, parent);
  const finished = work;
  finishEffect(finished, parent, resources, 1);

  assert.equal(getUnit(finished, 7), source);
  assert.equal(getUnit(finished, 9).effects.instances[0].finished, true);
  assert.equal(getUnit(finished, 2).effects.instances[0].finished, true);
  assert.equal(hasStatusFlag(getUnit(finished, 2), "INVINCIBLE"), false);
  assert.deepEqual(finalized, ["parent", "child"]);
  finishEffect(finished, parent, resources, 1);

  const parentFinalized = finished;
  finalizeEffect(parentFinalized, parent, resources, 1);
  assert.deepEqual(finalized, ["parent", "child"]);
  assert.equal(getUnit(parentFinalized, 2).effects.instances.length, 1);
  const cleared = parentFinalized;
  finalizeEffect(cleared, child, resources, 1);
  assert.deepEqual(finalized, ["parent", "child"]);
  finalizeEffect(cleared, child, resources, 1);
  assert.throws(
    () =>
      installEffect(
        cleared,
        9,
        resources.effects.create(parentDefinition.ref, metadata(1)),
        resources,
        1,
      ),
    /cannot be reused/,
  );
  assert.equal(getUnit(cleared, 9).effects.nextInstanceId, 2);
});

test("effects: binding an unavailable lifetime rejects without changing the independent effect", () => {
  for (const reason of ["ABSENT", "FINISHED"]) {
    for (const preserve of [false, true]) {
      const resources = new CombatResources();
      const parentDefinition = resources.registerEffect(barrierDefinition("unavailable-parent"));
      const childDefinition = resources.registerEffect(barrierDefinition("child"), {
        bindings: [compileStatusBinding(["INVINCIBLE"])],
        contributions: [attack(() => [modifier.create({ finalAddition: 50 })])],
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
      const parent = { type: "EFFECT", unitId: 9, effectId: 1 };
      const child = { type: "EFFECT", unitId: 2, effectId: 1 };
      let work = effectFixtureWork(owner, receiver);
      if (reason === "FINISHED") {
        installEffect(
          work,
          9,
          resources.effects.create(parentDefinition.ref, metadata(1)),
          resources,
          0,
        );
        finishEffect(work, parent, resources, 0);
      }
      installEffect(
        work,
        2,
        resources.effects.create(childDefinition.ref, metadata(1)),
        resources,
        0,
      );
      assert.equal(resolveAttackPower(2, battlefieldView(work)), 150);
      const binding = bindEffectLifetime(work, child, parent);
      const current = getUnit(work, 2);

      assert.deepEqual(binding, { type: "LIFETIME_UNAVAILABLE" });
      assert.deepEqual(current.effects.instances[0].scopes, []);
      assert.equal(current.effects.instances[0].finished, false);
      assert.equal(current.offense.attack.entries[0].participating, true);
      assert.equal(hasStatusFlag(current, "INVINCIBLE"), true);
      assert.equal(resolveAttackPower(2, battlefieldView(work)), 150);
    }
  }
});

test("effects: finish remains terminal when disable tries to reenable and finish the same instance", () => {
  const resources = new CombatResources();
  const definition = resources.registerEffect(barrierDefinition("reentrant"), {
    contributions: [attack(() => [modifier.create({ finalAddition: 50 })])],
    bindings: [compileStatusBinding(["INVINCIBLE"])],
    lifecycle: {
      disable: (context) => {
        disables++;
        assert.equal(context.instance.finished, true);
        assert.equal(context.instance.participating, false);
        assert.equal(context.facts.getEffect(context.ref), context.instance);
        assert.equal(context.facts.getUnit(2).offense.attack.entries[0].participating, false);
        assert.equal(hasStatusFlag(context.facts.getUnit(2), "INVINCIBLE"), false);
        assert.deepEqual(
          context.facts.participating(2).map((instance) => instance.id),
          [2],
        );
        context.effects.setEnabled(context.ref, true);
        context.effects.finish([context.ref]);
      },
      finish: (context) => {
        assert.equal(context.facts.getEffect(context.ref).finished, true);
        const contribution = context.facts.getUnit(2).offense.attack.entries[0];
        assert.equal(contribution.participating, false);
        finalizedSample = contribution.values[0].finalAddition;
        finalizations.push("reentrant");
        context.effects.finish([{ type: "EFFECT", unitId: 2, effectId: 2 }]);
      },
    },
  });
  const follower = resources.registerEffect(barrierDefinition("follower"), {
    lifecycle: {
      finish: () => {
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
  let installed = effectFixtureWork(owner);
  installEffect(
    installed,
    2,
    resources.effects.create(definition.ref, metadata()),
    resources,
    0,
  );
  installEffect(
    installed,
    2,
    resources.effects.create(follower.ref, metadata(2)),
    resources,
    0,
  );
  const address = { type: "EFFECT", unitId: 2, effectId: 1 };
  assert.equal(resolveAttackPower(2, battlefieldView(installed)), 150);
  assert.equal(hasStatusFlag(getUnit(installed, 2), "INVINCIBLE"), true);

  const finished = installed;
  finishEffect(finished, address, resources, 1);
  const receiver = getUnit(finished, 2);
  assert.equal(disables, 1);
  assert.equal(receiver.effects.instances[0].finished, true);
  assert.equal(receiver.effects.instances[0].participating, false);
  assert.equal(receiver.offense.attack.entries[0].participating, false);
  assert.equal(resolveAttackPower(2, battlefieldView(finished)), 100);
  assert.equal(hasStatusFlag(receiver, "INVINCIBLE"), false);
  finishEffect(finished, address, resources, 1);
  assert.equal(receiver.effects.instances[1].finished, true);
  const finalized = finished;
  finalizeFinishedEffects(finalized, 2, resources, 1);
  assert.equal(finalizedSample, 50);
  assert.deepEqual(finalizations, ["reentrant", "follower"]);
  assert.deepEqual(getUnit(finalized, 2).effects.instances, []);
  assert.deepEqual(getUnit(finalized, 2).offense.attack.entries, []);
});

test("effects: disabling preserves restartable samples and finishing a disabled instance does not dispatch disable twice", () => {
  const resources = new CombatResources();
  const disabled = [];
  let finalized = 0;
  const descriptor = resources.registerEffect(barrierDefinition("disabled-then-finished"), {
    bindings: [compileStatusBinding(["INVINCIBLE"])],
    contributions: [attack(() => [modifier.create({ finalAddition: 50 })])],
    lifecycle: {
      disable: (context) => {
        disabled.push(context.instance.finished);
        assert.equal(context.instance.participating, false);
        assert.equal(context.facts.getUnit(2).offense.attack.entries[0].participating, false);
        assert.equal(hasStatusFlag(context.facts.getUnit(2), "INVINCIBLE"), false);
      },
      finish: () => {
        finalized++;
      },
    },
  });
  const owner = initializeUnit({
    id: 2,
    position: [0, 0],
    definition: { id: "receiver", offense: { attack: 100 }, status: { initialFlags: [] } },
  });
  const installed = effectFixtureWork(owner);
  installEffect(
    installed,
    2,
    resources.effects.create(descriptor.ref, metadata()),
    resources,
    0,
  );
  const address = { type: "EFFECT", unitId: 2, effectId: 1 };
  const inactive = installed;
  setEffectEnabled(inactive, address, false, resources, 1);
  assert.equal(getUnit(inactive, 2).effects.instances[0].finished, false);
  assert.equal(getUnit(inactive, 2).offense.attack.entries[0].values[0].finalAddition, 50);
  const resumed = inactive;
  setEffectEnabled(resumed, address, true, resources, 2);
  assert.equal(resolveAttackPower(2, battlefieldView(resumed)), 150);
  const inactiveAgain = resumed;
  setEffectEnabled(inactiveAgain, address, false, resources, 3);
  const finished = inactiveAgain;
  finishEffect(finished, address, resources, 4);
  assert.deepEqual(disabled, [false, false]);
  assert.equal(getUnit(finished, 2).effects.instances[0].finished, true);
  setEffectEnabled(finished, address, true, resources, 4);
  assert.equal(finalized, 1);
  const cleaned = finished;
  finalizeFinishedEffects(cleaned, 2, resources, 4);
  assert.equal(finalized, 1);
  assert.deepEqual(getUnit(cleaned, 2).offense.attack.entries, []);
});

test("effects: pending terminal notices survive nested cleanup during disable preserves the terminal continuation and finishes existing children", () => {
  const resources = new CombatResources();
  const events = [];
  const replacement = resources.registerEffect(barrierDefinition("replacement"));
  const parent = resources.registerEffect(barrierDefinition("nested-parent"), {
    bindings: [compileStatusBinding(["INVINCIBLE"])],
    lifecycle: {
      disable: (context) => {
        events.push("parent-disable");
        assert.equal(context.instance.finished, true);
        assert.equal(context.instance.participating, false);
        assert.equal(hasStatusFlag(context.facts.getUnit(2), "INVINCIBLE"), false);
        const installed = context.effects.install(2, replacement.ref, {
          source: null,
          scopes: [],

        });
        assert.equal(installed.type, "INSTALLED");
        assert.equal(context.facts.getEffect(context.ref).finished, true);
        assert.equal(context.instance.finished, true);
        assert.equal(context.instance.state.remainingAmount, 500);
        context.effects.setEnabled(context.ref, true);
        context.effects.finish([context.ref]);
        events.push("parent-continued");
      },
      finish: (context) => {
        events.push("parent-finish");
        assert.equal(context.instance.finished, true);
        assert.equal(context.facts.getEffect(context.ref).finished, true);
      },
    },
  });
  const child = resources.registerEffect(barrierDefinition("nested-child"), {
    lifecycle: {
      disable: (context) => {
        events.push("child-disable");
        assert.equal(context.instance.finished, true);
        context.effects.finish([{ type: "EFFECT", unitId: 2, effectId: 1 }]);
        context.effects.setEnabled(context.ref, true);
      },
      finish: () => {
        events.push("child-finish");
      },
    },
  });
  let work = effectFixtureWork(unit());
  installEffect(
    work,
    2,
    resources.effects.create(parent.ref, metadata(1)),
    resources,
    0,
  );
  installEffect(
    work,
    2,
    resources.effects.create(child.ref, metadata(2)),
    resources,
    0,
  );
  const parentAddress = { type: "EFFECT", unitId: 2, effectId: 1 };
  const childAddress = { type: "EFFECT", unitId: 2, effectId: 2 };
  bindEffectLifetime(work, childAddress, parentAddress);
  const beforeFinish = work.battlefield.snapshot("draft");
  const finished = work;
  finishEffect(finished, parentAddress, resources, 1);

  assert.deepEqual(events, [
    "parent-disable",
    "parent-continued",
    "child-disable",
    "parent-finish",
    "child-finish",
  ]);
  const instances = getUnit(finished, 2).effects.instances;
  assert.equal(instances.length, 3);
  assert.equal(instances[2].definitionRef, replacement.ref);
  assert.equal(instances[2].participating, true);
  finishEffect(finished, parentAddress, resources, 1);
  const finalized = finished;
  finalizeFinishedEffects(finalized, 2, resources, 1);
  assert.deepEqual(events, [
    "parent-disable",
    "parent-continued",
    "child-disable",
    "parent-finish",
    "child-finish",
  ]);
  assert.deepEqual(
    getUnit(finalized, 2).effects.instances.map((instance) => instance.definitionRef),
    [replacement.ref],
  );
  assert.equal(beforeFinish.getUnit(2).effects.instances[0].finished, false);
  assert.equal(hasStatusFlag(beforeFinish.getUnit(2), "INVINCIBLE"), true);
});

test("effects: TypeScript preserves invariant definition state references and typed combat hook inference", async () => {
  const { default: ts } = await import("typescript");
  const directory = mkdtempSync(join(tmpdir(), "stronghold-effect-types-"));
  const sourceModule = (name) =>
    JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)));
  const imports = `
import { createEffectDefinition, type EffectDefinition, type EffectDefinitionRef } from ${sourceModule("unit/capability/effects/definition")};
import { EffectResources } from ${sourceModule("unit/capability/effects/registry")};
import type { EffectValue } from ${sourceModule("unit/capability/effects/effect")};
import { installEffect } from ${sourceModule("unit/capability/effects/lifecycle")};
import type { BattleState } from ${sourceModule("battle/execution/context")};
import { CombatResources } from ${sourceModule("battle/resources")};
import type { DamageRuleContext, DamageFormulaContext, DamageQueryContext } from ${sourceModule("unit/capability/vitality/damage/resources")};
import type { PendingDamage } from ${sourceModule("unit/capability/vitality/damage/contract")};
import { createProjectileDefinition, type ProjectileDefinitionRef } from ${sourceModule("battlefield/projectile/definition")};
import type { EffectLifecycleContext, EffectInstallationInput, EffectInstallationResult } from ${sourceModule("unit/capability/effects/contract")};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
interface BarrierState { readonly remainingAmount: number; }
interface ShieldState { readonly remainingCharges: number; }
interface SpecializedBarrierState extends BarrierState { readonly category: 'arts'; }

const barrier = createEffectDefinition({
  id: 'barrier', initialize: (): BarrierState => ({ remainingAmount: 500 }),
});
const resources = new EffectResources();
declare const installationResources: CombatResources;
declare const work: BattleState;
declare const lifecycle: EffectLifecycleContext<BarrierState>;
resources.register(barrier);
const instance = resources.create(barrier.ref, {
  id: 1, source: null, scopes: [], acquiredSequence: 0,
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
type InferredReference = Assert<Equal<typeof barrier.ref, EffectDefinitionRef<BarrierState>>>;
type InferredState = Assert<Equal<typeof instance.state, BarrierState>>;
installEffect(work, 2, instance, installationResources, 0);
const restored = resources.restore(barrier.ref, instance);
type RestoredState = Assert<Equal<typeof restored.state, BarrierState>>;
const descriptor = resources.get(barrier.ref);
type InferredDescriptor = Assert<Equal<typeof descriptor, EffectDefinition<BarrierState>>>;
const updated = resources.update(instance, { remainingAmount: 200 });
type UpdatedState = Assert<Equal<typeof updated.state, BarrierState>>;
const current = resources.typedState(updated, barrier.ref);
type OptionalState = Assert<Equal<typeof current, BarrierState | undefined>>;
const projectile = createProjectileDefinition({
  id: 'typed-projectile', initialize: (): BarrierState => ({ remainingAmount: 1 }),
  acceptsContact: () => true,
});
type ProjectileReference = Assert<Equal<typeof projectile.ref, ProjectileDefinitionRef<BarrierState>>>;
const installed = lifecycle.effects.install(2, barrier.ref, { source: null, scopes: [], initialState: instance.state });
type InstalledResult = Assert<Equal<typeof installed, EffectInstallationResult>>;
resources.withDefinition(instance, (bound, definition) => resources.update(bound, bound.state).id);
const combat = new CombatResources();
combat.registerEffect(barrier, {
 damage: {
  reception: { priority: 0, apply: (context, pending) => {
    const amount: number = context.instance.state.remainingAmount;
    context.operations.effects.update(context.ref, context.instance.definitionRef, state => ({ remainingAmount: Math.max(0, state.remainingAmount - pending.amount) }));
    return { value: pending };
  } },
  reaction: { priority: 0, apply: (context, report) => {
    const amount: number = context.instance.state.remainingAmount;
    const hpLoss: number = report.hpLoss;
    context.operations.effects.update(context.ref, context.instance.definitionRef, state => ({ remainingAmount: state.remainingAmount + hpLoss }));
  } },
 },
 healing: {
  reception: { priority: 0, apply: (context, pending) => {
    const amount: number = context.instance.state.remainingAmount;
    context.operations.effects.update(context.ref, context.instance.definitionRef, state => ({ remainingAmount: state.remainingAmount + amount }));
    return { value: pending };
  } },
 },
 lifecycle: {
  start: context => { context.effects.update(context.ref, barrier.ref, state => ({ remainingAmount: state.remainingAmount })); },
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
declare const specializedRef: EffectDefinitionRef<SpecializedBarrierState>;
const incompatible: EffectDefinitionRef<ShieldState> = barrier.ref;
const cannotWiden: EffectDefinitionRef<BarrierState> = specializedRef;
const cannotNarrow: EffectDefinitionRef<SpecializedBarrierState> = barrier.ref;
const cannotForge: EffectDefinitionRef<ShieldState> = { id: 'barrier' };
`,
        4,
      ],
      ["state-update", `resources.update(instance, { remainingCharges: 2 });`, 1],
      ["direct-install-wrong-state", `installEffect(work, 2, { ...instance, state: { remainingCharges: 2 } }, installationResources, 0);`, 1],
      ["direct-install-erased", `const erased: EffectValue = { ...instance, state: { remainingCharges: 2 } }; installEffect(work, 2, erased, installationResources, 0);`, 1],
      ["direct-install-widened", `installEffect<object>(work, 2, instance, installationResources, 0);`, 1],
      ["unparsed-restore", `declare const raw: unknown; resources.restore(barrier.ref, raw);`, 1],
      ["wrong-restore-state", `resources.restore(barrier.ref, { ...instance, state: { remainingCharges: 2 } });`, 1],
      ["wrong-installation-state", `lifecycle.effects.install(2, barrier.ref, { source: null, scopes: [], initialState: { remainingCharges: 2 } });`, 1],
      ["erased-installation", `const installation: EffectInstallationInput = { source: null, initialState: { remainingCharges: 2 }, scopes: [] }; lifecycle.effects.install(2, barrier.ref, installation);`, 1],
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
combat.registerEffect(barrier, { lifecycle: { start: async context => { await Promise.resolve(); context.effects.finish([context.ref]); } } });
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
