import { removeUnitWithEffects } from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";
import { computedAttack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import { combatWorkEvents } from "../../dist/core/tactical/battle/execution/work.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptActionExecution,
  actionExecutionPermissions,
  cancelActionExecution,
  copyActionExecutionState,
  createActionExecutionState,
  resumeActionExecution,
} from "../../dist/core/tactical/unit/capability/action/process.js";
import { createActionDefinition } from "../../dist/core/tactical/unit/capability/action/capability.js";
import { compileAction } from "../../dist/core/tactical/unit/capability/action/compile.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import {
  createCombatWork,
  getCombatUnit,
  removeCombatUnit,
  updateCombatUnit,
} from "../../dist/core/tactical/battle/execution/work.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { installNewEffect } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { updateEffectState } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { compileStatusBinding } from "../../dist/core/tactical/unit/capability/status/binding.js";
import { hasStatusFlag } from "../../dist/core/tactical/unit/capability/status/capability.js";
import * as modifier from "../../dist/core/tactical/modifier/value.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { combatWorkView } from "../../dist/core/tactical/battle/execution/work.js";
import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";

const geometry = createShapeGeometry({
  shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 10 }],
});

function definition() {
  return createActionDefinition({
    triggerBindingId: "primary",
    baseAttackTimeTicks: 10,
    recoveryTicks: 0,
    targetGroups: [
      {
        id: "primary",
        targeting: {
          type: "DAMAGE",
          scope: { type: "RANGE", geometry: { type: "SHAPES", geometry } },
          canTargetAir: true,
          includeBlockingRelations: false,
          preferBlockingRelations: false,
          ignoreTargetFree: false,
          ignoreInvisible: false,
          maxTargets: 1,
        },
        operations: [{ type: "DAMAGE", power: 7, damageType: "TRUE" }],
      },
    ],
    followUps: [],
  });
}

function unit(id) {
  return initializeUnit({
    id,
    position: [id, 0],
    definition: {
      id: `process-unit-${id}`,
      vitality: { maxHp: 100 },
      offense: { attack: 10 },
      defense: { defense: 0, resistance: 0 },
      allegiance: { side: id === 0 ? "ALLY" : "ENEMY" },
      spatial: { layer: "GROUND" },
      hit: { geometry },
      status: { initialFlags: [] },
    },
  });
}

function workWith(...units) {
  const byId = new Map(units.map((value) => [value.id, value]));
  return createCombatWork({
    unitIds: [...byId.keys()],
    getUnit: (id) => byId.get(id),
    blockerOf: () => undefined,
    blockedBy: () => [],
  });
}

function accept(state = createActionExecutionState(), options = {}) {
  return acceptActionExecution(state, {
    sourceUnitId: 0,
    definition: definition(),
    inputTargetUnitId: 1,
    bindings: new Map([["primary", [1]]]),
    tick: 0,
    ...options,
  });
}

function effectProgram(id) {
  return createEffectProgram({ id, initialize: () => ({}), ownState: (value) => ({ ...value }) });
}

function installOwned(resources, ref, context, unitId = 1) {
  return installNewEffect(
    context.work,
    unitId,
    ref,
    {
      source: context.sourceUnitId,
      scopes: [{ type: "ACTION", executionId: context.executionId }],
    },
    resources,
    context.tick,
  ).work;
}

function assertData(value) {
  assert.notEqual(typeof value, "function");
  assert.equal(value instanceof Map, false);
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      assertData(child);
    }
  }
}

test("action process: copying preserves samples and deterministic consumed/absolute waits without replaying release", () => {
  const resources = new CombatResources();
  const bindings = new Map([["primary", [1]]]);
  const samples = { power: 10 };
  const accepted = accept(undefined, { bindings, samples });
  bindings.get("primary").push(2);
  samples.power = 900;
  const segments = [
    {
      type: "EXECUTE",
      run: (context) => ({ work: context.work, samples: { power: context.samples.power + 1 } }),
    },
    {
      type: "WAIT",
      blockingMovement: true,
      allowNewAction: false,
      resolve: () => ({ type: "FOR_TICKS", ticks: 2 }),
    },
    { type: "RELEASE", markerId: "first" },
    { type: "WAIT", resolve: (context) => ({ type: "UNTIL_TICK", targetTick: context.tick + 2 }) },
    { type: "RELEASE", markerId: "second" },
  ];
  const waiting = resumeActionExecution(
    workWith(unit(0), unit(1)),
    accepted.state,
    { executionId: accepted.execution.id, segments, tick: 0 },
    resources,
  );
  const execution = waiting.state.executions[0];
  const copied = copyActionExecutionState(waiting.state);

  assert.deepEqual(execution.bindings, { primary: [1] });
  assert.deepEqual(execution.samples, { power: 11 });
  assert.equal(execution.wait.remainingTicks, 2);
  assert.deepEqual(actionExecutionPermissions(execution, segments), {
    blockingMovement: true,
    allowNewAction: false,
  });
  assert.equal(copied.executions[0].definition, accepted.execution.definition);
  assert.notEqual(copied.executions, waiting.state.executions);
  assertData(copied);

  const run = (initialState) => {
    let current = { work: waiting.work, state: initialState };
    const trace = [];
    for (const tick of [5, 5, 8, 8, 10, 10]) {
      current = resumeActionExecution(
        current.work,
        current.state,
        { executionId: accepted.execution.id, segments, tick },
        resources,
      );
      trace.push({ tick, result: current.result, signals: current.signals });
      if (tick === 5) {
        assert.equal(current.state.executions[0].wait.remainingTicks, 1);
      }
    }
    assert.equal(current.state.executions.length, 0);
    assert.equal(current.state.nextExecutionId, 1);
    assert.deepEqual(
      trace.flatMap(({ signals }) =>
        signals.map((signal) => [signal.type, signal.markerId, signal.tick]),
      ),
      [
        ["ACTION_RELEASED", "first", 8],
        ["ACTION_RELEASED", "second", 10],
        ["ACTION_FINISHED", undefined, 10],
      ],
    );
    return trace;
  };

  assert.deepEqual(run(copied), run(waiting.state));
  assert.equal(waiting.state.executions[0].wait.remainingTicks, 2);
});

test("action process: cancellation and source exit keep installed prefixes but prevent delayed release", () => {
  for (const reason of ["cancel", "removed", "absent"]) {
    const resources = new CombatResources();
    const effect = resources.registerEffect(effectProgram("owned-invincibility"), {
      bindings: [compileStatusBinding(["INVINCIBLE"])],
    });
    const accepted = accept();
    const segments = [
      {
        type: "EXECUTE",
        run: (context) => ({ work: installOwned(resources, effect.ref, context) }),
      },
      { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 5 }) },
      { type: "RELEASE", markerId: "late" },
    ];
    const waiting = resumeActionExecution(
      workWith(unit(0), unit(1)),
      accepted.state,
      { executionId: 0, segments, tick: 0 },
      resources,
    );
    assert.equal(hasStatusFlag(getCombatUnit(waiting.work, 1), "INVINCIBLE"), true);
    let work = waiting.work;
    if (reason === "removed") {
      work = removeCombatUnit(work, 0, "RETREAT");
    } else if (reason === "absent") {
      work = updateCombatUnit(work, {
        ...getCombatUnit(work, 0),
        spatialPresence: { present: false },
      });
    }
    const cancelled =
      reason === "cancel"
        ? cancelActionExecution(work, waiting.state, { executionId: 0, tick: 1 }, resources)
        : resumeActionExecution(
            work,
            waiting.state,
            { executionId: 0, segments, tick: 1 },
            resources,
          );

    assert.deepEqual(cancelled.result, {
      type: "CANCELLED",
      reason: reason === "cancel" ? "CANCELLED" : "SOURCE_ABSENT",
    });
    assert.equal(hasStatusFlag(getCombatUnit(cancelled.work, 1), "INVINCIBLE"), false);
    assert.equal(getCombatUnit(cancelled.work, 1).effects.instances[0].finished, true);
    assert.equal(getCombatUnit(cancelled.work, 1).vitality.hp, 100);
    assert.equal(
      cancelled.signals.some((signal) => signal.type === "ACTION_RELEASED"),
      false,
    );
    const duplicate = cancelActionExecution(
      cancelled.work,
      cancelled.state,
      { executionId: 0, tick: 6 },
      resources,
    );
    const late = resumeActionExecution(
      duplicate.work,
      duplicate.state,
      { executionId: 0, segments, tick: 6 },
      resources,
    );
    assert.equal(duplicate.work, cancelled.work);
    assert.equal(late.state, cancelled.state);
    assert.deepEqual(duplicate.signals, []);
    assert.deepEqual(late.signals, []);
    assert.equal(late.result.type, "ABSENT");
  }
});

test("action process: install then query binds current targets and the next segment sees completed Damage", () => {
  const resources = new CombatResources();
  const invisible = resources.registerEffect(effectProgram("invisible"), {
    bindings: [compileStatusBinding(["INVISIBLE"])],
  });
  const accepted = accept();
  const compiled = compileAction(accepted.execution.definition, resources);
  const segments = [
    {
      type: "EXECUTE",
      run: (context) => ({
        work: installNewEffect(
          context.work,
          1,
          invisible.ref,
          {
            source: 0,
            scopes: [],
          },
          resources,
          context.tick,
        ).work,
      }),
    },
    {
      type: "EXECUTE",
      run: (context) => ({
        work: context.work,
        bindings: compiled.bind({
          source: getCombatUnit(context.work, context.sourceUnitId),
          battlefield: combatWorkView(context.work),
        }),
      }),
    },
    compiled.program[0],
    {
      type: "EXECUTE",
      run: (context) => ({
        work: context.work,
        samples: {
          observedHp: getCombatUnit(context.work, context.bindings.get("primary")[0]).vitality.hp,
        },
      }),
    },
    { type: "WAIT", resolve: () => ({ type: "UNTIL_TICK", targetTick: 1 }) },
    { type: "RELEASE", markerId: "follow-up" },
  ];
  const original = workWith(unit(0), unit(1), unit(2));
  const waiting = resumeActionExecution(
    original,
    accepted.state,
    { executionId: 0, segments, tick: 0 },
    resources,
  );

  assert.deepEqual(waiting.state.executions[0].bindings, { primary: [2] });
  assert.equal(waiting.state.executions[0].inputTargetUnitId, 1);
  assert.deepEqual(waiting.state.executions[0].samples, { observedHp: 93 });
  assert.equal(hasStatusFlag(getCombatUnit(waiting.work, 1), "INVISIBLE"), true);
  assert.equal(getCombatUnit(waiting.work, 1).vitality.hp, 100);
  assert.equal(getCombatUnit(waiting.work, 2).vitality.hp, 93);
  assert.equal(getCombatUnit(original, 2).vitality.hp, 100);
  assert.deepEqual(accepted.state.executions[0].bindings, { primary: [1] });
  const completed = resumeActionExecution(
    waiting.work,
    copyActionExecutionState(waiting.state),
    { executionId: 0, segments, tick: 1 },
    resources,
  );
  assert.equal(completed.result.type, "FINISHED");
  assert.equal(getCombatUnit(completed.work, 2).vitality.hp, 93);
});

test("action process: concurrent executions from one source own independent contributions and cleanup", () => {
  const resources = new CombatResources();
  const bonus = resources.registerEffect(effectProgram("owned-bonus"), {
    contributions: [computedAttack(() => [modifier.create({ finalAddition: 20 })])],
  });
  const first = accept();
  const second = accept(first.state, { definition: first.execution.definition });
  const segments = [
    { type: "EXECUTE", run: (context) => ({ work: installOwned(resources, bonus.ref, context) }) },
    { type: "WAIT", resolve: () => ({ type: "UNTIL_TICK", targetTick: 5 }) },
    { type: "RELEASE", markerId: "release" },
  ];
  let current = resumeActionExecution(
    workWith(unit(0), unit(1)),
    second.state,
    { executionId: 0, segments, tick: 0 },
    resources,
  );
  current = resumeActionExecution(
    current.work,
    current.state,
    { executionId: 1, segments, tick: 0 },
    resources,
  );
  const attack = (work) => resolveAttackPower(1, combatWorkView(work), resources.computations);
  assert.equal(attack(current.work), 50);
  current = cancelActionExecution(
    current.work,
    current.state,
    { executionId: 0, tick: 1 },
    resources,
  );
  assert.equal(attack(current.work), 30);
  assert.deepEqual(
    current.state.executions.map((execution) => execution.id),
    [1],
  );
  assert.deepEqual(
    getCombatUnit(current.work, 1).effects.instances.map((instance) => [
      instance.scopes.find(scope => scope.type === "ACTION").executionId,
      instance.finished,
    ]),
    [
      [0, true],
      [1, false],
    ],
  );
  const completed = resumeActionExecution(
    current.work,
    current.state,
    { executionId: 1, segments, tick: 5 },
    resources,
  );
  assert.equal(attack(completed.work), 10);
  assert.deepEqual(
    completed.signals.map((signal) => [signal.type, signal.executionId]),
    [
      ["ACTION_RELEASED", 1],
      ["ACTION_FINISHED", 1],
    ],
  );
  assert.equal(completed.state.nextExecutionId, 2);
  assert.equal(completed.state.executions.length, 0);
});

test("action process: content cancellation and normal finish retain completed prefixes without releasing or executing successors", () => {
  for (const continuation of ["CANCEL", "FINISH"]) {
    const resources = new CombatResources();
    const sampled = resources.registerEffect(
      createEffectProgram({
        id: "sampled-prefix",
        initialize: () => ({ power: 0 }),
        ownState: (value) => ({ ...value }),
      }),
      {
        contributions: [computedAttack(({ instance }) => [
            modifier.create({ finalAddition: instance.state.power }),
          ])],
      },
    );
    const accepted = accept();
    const original = workWith(unit(0), unit(1));
    const result = resumeActionExecution(
      original,
      accepted.state,
      {
        executionId: 0,
        segments: [
          { type: "EXECUTE", run: (context) => ({ work: context.work, samples: { power: 23 } }) },
          {
            type: "EXECUTE",
            run: (context) => {
              let work = installOwned(resources, sampled.ref, context);
              work = updateEffectState(
                work,
                1,
                0,
                sampled.ref,
                () => ({ power: context.samples.power }),
                resources,
                0,
              );
              assert.equal(resolveAttackPower(1, combatWorkView(work), resources.computations), 33);
              return { work, continuation };
            },
          },
          { type: "RELEASE", markerId: "unreached" },
          {
            type: "EXECUTE",
            run: (context) => ({
              work: resolveDamage(
                context.work,
                {
                  sourceUnitId: 0,
                  targetUnitId: 1,
                  damageType: "TRUE",
                  tick: 0,
                  operands: createDamageOperands(100),
                },
                resources,
              ).work,
            }),
          },
        ],
        tick: 0,
      },
      resources,
    );

    assert.deepEqual(
      result.result,
      continuation === "CANCEL"
        ? { type: "CANCELLED", reason: "CONTENT_CANCELLED" }
        : { type: "FINISHED" },
    );
    assert.equal(result.state.executions.length, 0);
    assert.equal(result.state.nextExecutionId, 1);
    assert.equal(getCombatUnit(result.work, 1).vitality.hp, 100);
    assert.equal(getCombatUnit(result.work, 1).effects.instances[0].state.power, 23);
    assert.equal(getCombatUnit(result.work, 1).effects.instances[0].finished, true);
    assert.equal(resolveAttackPower(1, combatWorkView(result.work), resources.computations), 10);
    assert.equal(getCombatUnit(original, 1).effects, undefined);
    assert.deepEqual(
      combatWorkEvents(result.work).map((event) => event.type),
      [continuation === "CANCEL" ? "ACTION_CANCELLED" : "ACTION_FINISHED"],
    );
    const duplicate = resumeActionExecution(
      result.work,
      result.state,
      { executionId: 0, segments: [], tick: 0 },
      resources,
    );
    assert.equal(duplicate.result.type, "ABSENT");
    assert.equal(duplicate.work, result.work);
    assert.deepEqual(duplicate.signals, []);
  }
});

test("action process: a throwing successor exposes neither a partial settlement nor advanced continuation", () => {
  const resources = new CombatResources();
  const accepted = accept();
  const original = workWith(unit(0), unit(1));
  const damage = {
    type: "EXECUTE",
    run: (context) => ({
      work: resolveDamage(
        context.work,
        {
          sourceUnitId: context.sourceUnitId,
          targetUnitId: 1,
          tick: context.tick,
          damageType: "TRUE",
          operands: createDamageOperands(20),
        },
        resources,
      ).work,
    }),
  };
  assert.throws(
    () =>
      resumeActionExecution(
        original,
        accepted.state,
        {
          executionId: 0,
          segments: [
            damage,
            {
              type: "EXECUTE",
              run: () => {
                throw new Error("successor failed");
              },
            },
          ],
          tick: 0,
        },
        resources,
      ),
    /successor failed/,
  );
  assert.equal(getCombatUnit(original, 1).vitality.hp, 100);
  assert.equal(accepted.state.executions[0].cursor, 0);
  const retried = resumeActionExecution(
    original,
    accepted.state,
    { executionId: 0, segments: [damage, { type: "RELEASE", markerId: "retry" }], tick: 0 },
    resources,
  );
  assert.equal(getCombatUnit(retried.work, 1).vitality.hp, 80);
  assert.deepEqual(
    retried.signals.map((signal) => signal.type),
    ["ACTION_RELEASED", "ACTION_FINISHED"],
  );
});

test("action process: source departure completes the entered segment and cancels unentered successors", () => {
  const resources = new CombatResources();
  const marker = resources.registerEffect(effectProgram("source-exit-prefix"), {
    bindings: [compileStatusBinding(["INVINCIBLE"])],
  });
  const accepted = accept();
  const observed = [];
  const segments = [
    { type: "EXECUTE", run: (context) => ({ work: installOwned(resources, marker.ref, context) }) },
    { type: "EXECUTE", run: (context) => {
      let work = removeCombatUnit(context.work, 0, "RETREAT");
      observed.push("synchronous");
      work = updateCombatUnit(work, { ...getCombatUnit(work, 1), position: [3, 0] });
      assert.equal(hasStatusFlag(getCombatUnit(work, 1), "INVINCIBLE"), true);
      return { work };
    } },
    { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 1 }) },
    { type: "RELEASE", markerId: "unreached" },
    { type: "EXECUTE", run: (context) => {
      observed.push("delayed");
      return { work: context.work };
    } },
  ];
  const cancelled = resumeActionExecution(
    workWith(unit(0), unit(1)),
    accepted.state,
    { executionId: 0, segments, tick: 0 },
    resources,
  );
  assert.deepEqual(cancelled.result, { type: "CANCELLED", reason: "SOURCE_ABSENT" });
  assert.deepEqual(observed, ["synchronous"]);
  assert.deepEqual(getCombatUnit(cancelled.work, 1).position, [3, 0]);
  assert.equal(hasStatusFlag(getCombatUnit(cancelled.work, 1), "INVINCIBLE"), false);
  assert.equal(combatWorkEvents(cancelled.work).some(event => event.type === "ACTION_RELEASED"), false);
  assert.deepEqual(cancelled.state.executions, []);
});

test("action process: source absence cancels before release while retaining prior release reports", () => {
  for (const first of [[], [{ type: 'RELEASE', markerId: 'before' }]]) {
    const resources = new CombatResources();
    const accepted = accept();
    let attempted = 0;
    const result = resumeActionExecution(
      workWith(unit(0), unit(1)),
      accepted.state,
      {
        executionId: 0,
        segments: [
          ...first,
          {
            type: "EXECUTE",
            run: (context) => ({ work: removeCombatUnit(context.work, 0, "RETREAT") }),
          },
          { type: "RELEASE", markerId: "after" },
          {
            type: "EXECUTE",
            run: (context) => {
              attempted++;
              return { work: context.work };
            },
          },
        ],
        tick: 0,
      },
      resources,
    );
    assert.deepEqual(result.result, { type: 'CANCELLED', reason: 'SOURCE_ABSENT' });
    assert.equal(attempted, 0);
    assert.deepEqual(result.signals.map(signal => signal.type), [
      ...first.map(() => 'ACTION_RELEASED'), 'ACTION_CANCELLED',
    ]);
    assert.deepEqual(combatWorkEvents(result.work).map(event => event.type), result.signals.map(signal => signal.type));
  }
});

test("action process: a completed final segment can finish after removing its own source", () => {
  const resources = new CombatResources();
  const accepted = accept();
  const result = resumeActionExecution(
    workWith(unit(0), unit(1)),
    accepted.state,
    {
      executionId: 0,
      segments: [
        {
          type: "EXECUTE",
          run: (context) => ({ work: removeCombatUnit(context.work, 0, "RETREAT") }),
        },
      ],
      tick: 0,
    },
    resources,
  );
  assert.equal(result.result.type, 'FINISHED');
  assert.deepEqual(result.signals.map(signal => signal.type), ['ACTION_FINISHED']);
  assert.equal(getCombatUnit(result.work, 0), undefined);
});

test("action process: nested source departure cancels the current execution without resuming later segments", () => {
  const resources = new CombatResources();
  const dependent = resources.registerEffect(effectProgram("departing-action-dependent"));
  const accepted = accept();
  const visited = [];
  const segments = [
    {
      type: "EXECUTE",
      run: context => {
        visited.push("remove");
        const attached = installOwned(resources, dependent.ref, context);
        return { work: removeUnitWithEffects(attached, 0, "SCRIPT", resources, context.tick) };
      },
    },
    {
      type: "EXECUTE",
      run: context => {
        visited.push("after removal");
        return { work: context.work };
      },
    },
  ];
  const advanced = resumeActionExecution(
    workWith(unit(0), unit(1)),
    accepted.state,
    { executionId: accepted.execution.id, segments, tick: 0 },
    resources,
  );

  assert.deepEqual(visited, ["remove"]);
  assert.deepEqual(advanced.state.executions, []);
  assert.equal(getCombatUnit(advanced.work, 0), undefined);
  assert.equal(getCombatUnit(advanced.work, 1).effects.instances.every(instance => instance.finished), true);
  assert.deepEqual(combatWorkEvents(advanced.work).filter(event => event.type.startsWith("ACTION_")), [
    { type: "ACTION_CANCELLED", executionId: 0, sourceUnitId: 0, tick: 0, reason: "SOURCE_ABSENT" },
  ]);
});

test("action process: source removal in attack completion cannot revive the execution", () => {
  const resources = new CombatResources();
  const accepted = accept();
  let continued = false;
  const advanced = resumeActionExecution(
    workWith(unit(0), unit(1)),
    accepted.state,
    {
      executionId: 0,
      tick: 2,
      segments: [
        { type: "EXECUTE", run: context => ({ work: context.work }) },
        { type: "EXECUTE", run: context => {
          continued = true;
          return { work: context.work };
        } },
      ],
    },
    {
      ...resources,
      completeAttack: (work, sourceUnitId, tick) =>
        removeUnitWithEffects(work, sourceUnitId, "DEATH", resources, tick),
    },
  );

  assert.equal(continued, false);
  assert.deepEqual(advanced.state.executions, []);
  assert.equal(combatWorkEvents(advanced.work).filter(event => event.type === "ACTION_CANCELLED").length, 1);
  assert.equal(combatWorkEvents(advanced.work).some(event => event.type === "ACTION_FINISHED"), false);
});
