import { fixtureBattlefield } from "../helpers/battlefield.js";
import { removeUnitWithEffects } from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";
import { liveAttack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptActionExecution,
  actionExecutionPermissions,
  cancelActionExecution,
  createActionExecutionState,
  resumeActionExecution,
} from "../../dist/core/tactical/unit/capability/action/process.js";
import { createActionDefinition } from "../../dist/core/tactical/unit/capability/action/capability.js";
import { compileAction } from "../../dist/core/tactical/unit/capability/action/compile.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import {
  createBattleState,
  getUnit,
  removeUnit,
  updateUnit,
} from "../../dist/core/tactical/battle/execution/context.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { installNewEffect } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { updateEffectState } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { compileStatusBinding } from "../../dist/core/tactical/unit/capability/status/binding.js";
import { hasStatusFlag } from "../../dist/core/tactical/unit/capability/status/capability.js";
import * as modifier from "../../dist/core/tactical/modifier/value.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { battlefieldView } from "../../dist/core/tactical/battle/execution/context.js";
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
  return createBattleState(fixtureBattlefield({
    unitIds: [...byId.keys()],
    getUnit: (id) => byId.get(id),
    blockerOf: () => undefined,
    blockedBy: () => [],
  }));
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
  return createEffectProgram({ id, initialize: () => ({}) });
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
  );
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
  assert.equal(accepted.execution.bindings.primary, bindings.get("primary"));
  assert.equal(accepted.execution.samples, samples);
  const segments = [
    {
      type: "EXECUTE",
      run: (context) => {return {samples: { power: context.samples.power + 1 }};},
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
  const battle = workWith(unit(0), unit(1));
  const waiting = resumeActionExecution(
    battle,
    accepted.state,
    { executionId: accepted.execution.id, segments, tick: 0 },
    resources,
  );
  const execution = waiting.state.executions[0];
  const copied = waiting.state;

  assert.deepEqual(execution.bindings, { primary: [1] });
  assert.deepEqual(execution.samples, { power: 11 });
  assert.equal(execution.wait.remainingTicks, 2);
  assert.deepEqual(actionExecutionPermissions(execution, segments), {
    blockingMovement: true,
    allowNewAction: false,
  });
  assert.equal(copied.executions[0].definition, accepted.execution.definition);
  assert.equal(copied.executions, waiting.state.executions);
  assertData(copied);

  const run = (initialState) => {
    let current = { state: initialState };
    const trace = [];
    for (const tick of [5, 5, 8, 8, 10, 10]) {
      current = resumeActionExecution(
        battle,
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
        run: (context) => {installOwned(resources, effect.ref, context);},
      },
      { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 5 }) },
      { type: "RELEASE", markerId: "late" },
    ];
    const battle = workWith(unit(0), unit(1));
    const waiting = resumeActionExecution(
      battle,
      accepted.state,
      { executionId: 0, segments, tick: 0 },
      resources,
    );
    assert.equal(hasStatusFlag(getUnit(battle, 1), "INVINCIBLE"), true);
    let work = battle;
    if (reason === "removed") {
      removeUnit(work, 0, "RETREAT");
    } else if (reason === "absent") {
      updateUnit(work, {
        ...getUnit(work, 0),
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
    assert.equal(hasStatusFlag(getUnit(battle, 1), "INVINCIBLE"), false);
    assert.equal(getUnit(battle, 1).effects.instances[0].finished, true);
    assert.equal(getUnit(battle, 1).vitality.hp, 100);
    assert.equal(
      cancelled.signals.some((signal) => signal.type === "ACTION_RELEASED"),
      false,
    );
    const duplicate = cancelActionExecution(
      battle,
      cancelled.state,
      { executionId: 0, tick: 6 },
      resources,
    );
    const late = resumeActionExecution(
      battle,
      duplicate.state,
      { executionId: 0, segments, tick: 6 },
      resources,
    );

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
      run: (context) => {installNewEffect(
          context.work,
          1,
          invisible.ref,
          {
            source: 0,
            scopes: [],
          },
          resources,
          context.tick,
        );},
    },
    {
      type: "EXECUTE",
      run: (context) => {return {bindings: compiled.bind({
          source: getUnit(context.work, context.sourceUnitId),
          battlefield: battlefieldView(context.work),
        })};},
    },
    compiled.program[0],
    {
      type: "EXECUTE",
      run: (context) => {return {samples: {
          observedHp: getUnit(context.work, context.bindings.get("primary")[0]).vitality.hp,
        }};},
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
  assert.equal(hasStatusFlag(getUnit(original, 1), "INVISIBLE"), true);
  assert.equal(getUnit(original, 1).vitality.hp, 100);
  assert.equal(getUnit(original, 2).vitality.hp, 93);
  assert.equal(original.battlefield.snapshot("state").getUnit(2).vitality.hp, 100);
  assert.deepEqual(accepted.state.executions[0].bindings, { primary: [1] });
  const completed = resumeActionExecution(
    original,
    waiting.state,
    { executionId: 0, segments, tick: 1 },
    resources,
  );
  assert.equal(completed.result.type, "FINISHED");
  assert.equal(getUnit(original, 2).vitality.hp, 93);
});

test("action process: concurrent executions from one source own independent contributions and cleanup", () => {
  const resources = new CombatResources();
  const bonus = resources.registerEffect(effectProgram("owned-bonus"), {
    contributions: [liveAttack(() => [modifier.create({ finalAddition: 20 })])],
  });
  const first = accept();
  const second = accept(first.state, { definition: first.execution.definition });
  const segments = [
    { type: "EXECUTE", run: (context) => {installOwned(resources, bonus.ref, context);} },
    { type: "WAIT", resolve: () => ({ type: "UNTIL_TICK", targetTick: 5 }) },
    { type: "RELEASE", markerId: "release" },
  ];
  const battle = workWith(unit(0), unit(1));
  let current = resumeActionExecution(
    battle,
    second.state,
    { executionId: 0, segments, tick: 0 },
    resources,
  );
  current = resumeActionExecution(
    battle,
    current.state,
    { executionId: 1, segments, tick: 0 },
    resources,
  );
  const attack = (work) => resolveAttackPower(1, battlefieldView(work), resources.computations);
  assert.equal(attack(battle), 50);
  current = cancelActionExecution(
    battle,
    current.state,
    { executionId: 0, tick: 1 },
    resources,
  );
  assert.equal(attack(battle), 30);
  assert.deepEqual(
    current.state.executions.map((execution) => execution.id),
    [1],
  );
  assert.deepEqual(
    getUnit(battle, 1).effects.instances.map((instance) => [
      instance.scopes.find(scope => scope.type === "ACTION").executionId,
      instance.finished,
    ]),
    [
      [0, true],
      [1, false],
    ],
  );
  const completed = resumeActionExecution(
    battle,
    current.state,
    { executionId: 1, segments, tick: 5 },
    resources,
  );
  assert.equal(attack(battle), 10);
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
      }),
      {
        contributions: [liveAttack(({ instance }) => [
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
          { type: "EXECUTE", run: (context) => {return {samples: { power: 23 }};} },
          {
            type: "EXECUTE",
            run: (context) => {
              installOwned(resources, sampled.ref, context);
              const work = context.work;
              updateEffectState(
                work,
                1,
                0,
                sampled.ref,
                () => ({ power: context.samples.power }),
                resources,
                0,
              );
              assert.equal(resolveAttackPower(1, battlefieldView(work), resources.computations), 33);
              return {continuation};
            },
          },
          { type: "RELEASE", markerId: "unreached" },
          {
            type: "EXECUTE",
            run: (context) => {resolveDamage(
                context.work,
                {
                  sourceUnitId: 0,
                  targetUnitId: 1,
                  damageType: "TRUE",
                  tick: 0,
                  operands: createDamageOperands(100),
                },
                resources,
              );},
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
    assert.equal(getUnit(original, 1).vitality.hp, 100);
    assert.equal(getUnit(original, 1).effects.instances[0].state.power, 23);
    assert.equal(getUnit(original, 1).effects.instances[0].finished, true);
    assert.equal(resolveAttackPower(1, battlefieldView(original), resources.computations), 10);
    assert.equal(original.battlefield.snapshot("state").getUnit(1).effects, undefined);
    assert.deepEqual(
      original.events.map((event) => event.type),
      [continuation === "CANCEL" ? "ACTION_CANCELLED" : "ACTION_FINISHED"],
    );
    const duplicate = resumeActionExecution(
      original,
      result.state,
      { executionId: 0, segments: [], tick: 0 },
      resources,
    );
    assert.equal(duplicate.result.type, "ABSENT");

    assert.deepEqual(duplicate.signals, []);
  }
});

test("action process: a throwing successor exposes neither a partial settlement nor advanced continuation", () => {
  const resources = new CombatResources();
  const accepted = accept();
  const original = workWith(unit(0), unit(1));
  const damage = {
    type: "EXECUTE",
    run: (context) => {resolveDamage(
        context.work,
        {
          sourceUnitId: context.sourceUnitId,
          targetUnitId: 1,
          tick: context.tick,
          damageType: "TRUE",
          operands: createDamageOperands(20),
        },
        resources,
      );},
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
  assert.equal(original.battlefield.snapshot("state").getUnit(1).vitality.hp, 100);
  original.battlefield.drop();
  original.events.length = 0;
  assert.equal(accepted.state.executions[0].cursor, 0);
  const retried = resumeActionExecution(
    original,
    accepted.state,
    { executionId: 0, segments: [damage, { type: "RELEASE", markerId: "retry" }], tick: 0 },
    resources,
  );
  assert.equal(getUnit(original, 1).vitality.hp, 80);
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
    { type: "EXECUTE", run: (context) => {installOwned(resources, marker.ref, context);} },
    { type: "EXECUTE", run: (context) => {
      const work = context.work;
      removeUnit(work, 0, "RETREAT");
      observed.push("synchronous");
      updateUnit(work, { ...getUnit(work, 1), position: [3, 0] });
      assert.equal(hasStatusFlag(getUnit(work, 1), "INVINCIBLE"), true);
      return;
    } },
    { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 1 }) },
    { type: "RELEASE", markerId: "unreached" },
    { type: "EXECUTE", run: (context) => {
      observed.push("delayed");
      return;
    } },
  ];
  const battle = workWith(unit(0), unit(1));
  const cancelled = resumeActionExecution(
    battle,
    accepted.state,
    { executionId: 0, segments, tick: 0 },
    resources,
  );
  assert.deepEqual(cancelled.result, { type: "CANCELLED", reason: "SOURCE_ABSENT" });
  assert.deepEqual(observed, ["synchronous"]);
  assert.deepEqual(getUnit(battle, 1).position, [3, 0]);
  assert.equal(hasStatusFlag(getUnit(battle, 1), "INVINCIBLE"), false);
  assert.equal(battle.events.some(event => event.type === "ACTION_RELEASED"), false);
  assert.deepEqual(cancelled.state.executions, []);
});

test("action process: source absence cancels before release while retaining prior release reports", () => {
  for (const first of [[], [{ type: 'RELEASE', markerId: 'before' }]]) {
    const resources = new CombatResources();
    const accepted = accept();
    let attempted = 0;
    const battle = workWith(unit(0), unit(1));
    const result = resumeActionExecution(
      battle,
      accepted.state,
      {
        executionId: 0,
        segments: [
          ...first,
          {
            type: "EXECUTE",
            run: (context) => {removeUnit(context.work, 0, "RETREAT");},
          },
          { type: "RELEASE", markerId: "after" },
          {
            type: "EXECUTE",
            run: (context) => {
              attempted++;
              return;
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
    assert.deepEqual(battle.events.map(event => event.type), result.signals.map(signal => signal.type));
  }
});

test("action process: a completed final segment can finish after removing its own source", () => {
  const resources = new CombatResources();
  const accepted = accept();
  const battle = workWith(unit(0), unit(1));
  const result = resumeActionExecution(
    battle,
    accepted.state,
    {
      executionId: 0,
      segments: [
        {
          type: "EXECUTE",
          run: (context) => {removeUnit(context.work, 0, "RETREAT");},
        },
      ],
      tick: 0,
    },
    resources,
  );
  assert.equal(result.result.type, 'FINISHED');
  assert.deepEqual(result.signals.map(signal => signal.type), ['ACTION_FINISHED']);
  assert.equal(getUnit(battle, 0), undefined);
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
        installOwned(resources, dependent.ref, context);
        removeUnitWithEffects(context.work, 0, "SCRIPT", resources, context.tick);return;
      },
    },
    {
      type: "EXECUTE",
      run: context => {
        visited.push("after removal");
        return;
      },
    },
  ];
  const battle = workWith(unit(0), unit(1));
  const advanced = resumeActionExecution(
    battle,
    accepted.state,
    { executionId: accepted.execution.id, segments, tick: 0 },
    resources,
  );

  assert.deepEqual(visited, ["remove"]);
  assert.deepEqual(advanced.state.executions, []);
  assert.equal(getUnit(battle, 0), undefined);
  assert.equal(getUnit(battle, 1).effects.instances.every(instance => instance.finished), true);
  assert.deepEqual(battle.events.filter(event => event.type.startsWith("ACTION_")), [
    { type: "ACTION_CANCELLED", executionId: 0, sourceUnitId: 0, tick: 0, reason: "SOURCE_ABSENT" },
  ]);
});

test("action process: source removal in attack completion cannot revive the execution", () => {
  const resources = new CombatResources();
  const accepted = accept();
  let continued = false;
  const battle = workWith(unit(0), unit(1));
  const advanced = resumeActionExecution(
    battle,
    accepted.state,
    {
      executionId: 0,
      tick: 2,
      segments: [
        { type: "EXECUTE", run: context => {} },
        { type: "EXECUTE", run: context => {
          continued = true;
          return;
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
  assert.equal(battle.events.filter(event => event.type === "ACTION_CANCELLED").length, 1);
  assert.equal(battle.events.some(event => event.type === "ACTION_FINISHED"), false);
});
