import { fixtureBattlefield } from "../helpers/battlefield.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";
import { createOperatorDefinition } from "../../dist/core/tactical/unit/archetype/operator.js";
import {
  createCombatEnemyDefinition,
  createEnemyDefinition,
} from "../../dist/core/tactical/unit/archetype/enemy.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import { createRouteDefinition } from "../../dist/core/tactical/unit/capability/locomotion/route/definition.js";
import { compileAction } from "../../dist/core/tactical/unit/capability/action/compile.js";
import {
  resumeActionExecution,
} from "../../dist/core/tactical/unit/capability/action/process.js";
import { createEffectDefinition } from "../../dist/core/tactical/unit/capability/effects/definition.js";
import { installNewEffect } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { updateEffectState } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { createBattleState, getUnit } from "../../dist/core/tactical/battle/execution/context.js";

const hit = createShapeGeometry({
  shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.1 }],
});
const range = createShapeGeometry({
  shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 10 }],
});

function actorDefinition(id, { baseAttackTimeTicks = 10, power = 7, moving = false } = {}) {
  const common = {
    id,
    vitality: { maxHp: 100 },
    offense: { attack: power },
    defense: { defense: 0, resistance: 0 },
    allegiance: { side: moving ? "ENEMY" : "ALLY" },
    spatial: { layer: "GROUND" },
    hit: { geometry: hit },
    status: { initialFlags: [] },
    action: {
      normalAction: {
        triggerBindingId: "primary",
        baseAttackTimeTicks,
        recoveryTicks: 0,
        targetGroups: [
          {
            id: "primary",
            targeting: {
              type: "DAMAGE",
              scope: { type: "RANGE", geometry: { type: "SHAPES", geometry: range } },
              canTargetAir: true,
              includeBlockingRelations: false,
              preferBlockingRelations: false,
              ignoreTargetFree: false,
              ignoreInvisible: false,
              maxTargets: 1,
            },
            operations: [{ type: "DAMAGE", power, damageType: "TRUE" }],
          },
        ],
        followUps: [],
      },
    },
  };
  return moving
    ? createCombatEnemyDefinition({
        ...common,
        locomotion: {
          moveSpeedPerTick: 0.1,
          steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
        },
        blockable: { weight: 1 },
      })
    : createOperatorDefinition({
        ...common,
        blocker: { capacity: 0, geometry: { radius: 0.1 } },
      });
}

function passiveDefinition(side = "ENEMY") {
  return Object.freeze({
    id: `passive-${side}`,
    vitality: Object.freeze({ maxHp: 100 }),
    defense: Object.freeze({ defense: 0, resistance: 0 }),
    allegiance: Object.freeze({ side }),
    spatial: Object.freeze({ layer: "GROUND" }),
    hit: Object.freeze({ geometry: hit }),
    status: Object.freeze({ initialFlags: Object.freeze([]) }),
  });
}

function route(startPosition = [0, 7], endPosition = [0, 1]) {
  return createRouteDefinition({
    pathMotionMode: "WALK",
    startPosition,
    endPosition,
    spawnOffset: [0, 0],
    spawnRandomRange: [0, 0],
    checkpoints: [],
    allowDiagonalMove: false,
    visitEveryTileCenter: false,
    visitEveryNodeCenter: false,
    visitEveryCheckPoint: true,
  });
}

function spawn(definition, tick) {
  return {
    definition,
    route: route(),
    tick,
    timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
    alwaysCheckCurrentPoint: true,
    notCountInTotal: false,
  };
}

function spec(initialUnits, spawns) {
  const keepOpen = createEnemyDefinition({
    id: "future-spawn",
    vitality: { maxHp: 1 },
    locomotion: {
      moveSpeedPerTick: 0,
      steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
    },
  });
  return {
    ...createLegacyCombatSpec({
      rows: 1,
      columns: 8,
      operators: [],
      enemies: [],
      maxTicks: 20,
      seed: 17,
    }),
    initialUnits,
    schedule: { type: "TIMELINE", spawns: spawns ?? [spawn(keepOpen, 19)] },
  };
}

function delayed(compiled, ticks, { allowNewAction = false, blockingMovement = false } = {}) {
  return {
    ...compiled,
    program: [
      {
        type: "WAIT",
        allowNewAction,
        blockingMovement,
        resolve: () => ({ type: "FOR_TICKS", ticks }),
      },
      { type: "RELEASE", markerId: "normal" },
      ...compiled.program,
    ],
  };
}

function workFrom(snapshot) {
  const units = new Map(snapshot.units.map((unit) => [unit.id, unit]));
  return createBattleState(fixtureBattlefield({
      unitIds: [...units.keys()],
      getUnit: (id) => units.get(id),
      blockerOf: () => undefined,
      blockedBy: () => [],
    }), snapshot.execution);
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

test("action runtime: delayed progress keeps ordinary same-tick order and copied facts resume the same settlement", () => {
  const delayedActor = actorDefinition("delayed");
  const instantActor = actorDefinition("instant", { power: 3 });
  const resources = new CombatResources();
  let process;
  const runtime = new BattleRuntime(
    spec([
      { definition: delayedActor, position: [0, 0] },
      { definition: instantActor, position: [1, 0] },
      { definition: passiveDefinition(), position: [3, 0] },
    ]),
    {
      combat: resources,
      compileAction: (action, services) => {
        const compiled = compileAction(action, services);
        if (action !== delayedActor.action.normalAction) {
          return compiled;
        }
        const result = delayed(compiled, 2);
        process = result.program;
        return result;
      },
    },
  );
  const first = runtime.step();
  const snapshot = runtime.snapshot();

  assert.deepEqual(
    first.events.filter((event) => event.type === "ACTION").map((event) => event.sourceUnitId),
    [0, 1],
  );
  assert.deepEqual(
    first.events
      .filter((event) => event.type === "DAMAGE")
      .map((event) => [event.sourceUnitId, event.amount]),
    [[1, 3]],
  );
  assert.equal(snapshot.units.find((unit) => unit.id === 2).vitality.hp, 97);
  assert.equal(snapshot.actionExecution.executions.length, 1);
  assert.equal(snapshot.actionExecution.executions[0].definition, delayedActor.action.normalAction);
  assert.equal(snapshot.units[0].action.readyAtTick, 10);
  assert.equal(snapshot.units[0].action.recoveryUntilTick, 0);
  assertData(snapshot.actionExecution);
  assert.deepEqual(structuredClone(snapshot), snapshot);

  const id = snapshot.actionExecution.executions[0].id;
  const copiedState = workFrom(snapshot);
  let copied = { state: snapshot.actionExecution };
  const copySignals = [];
  for (const tick of [1, 2]) {
    copied = resumeActionExecution(
      copiedState,
      copied.state,
      { executionId: id, segments: process, tick },
      resources,
    );
    copySignals.push(...copied.signals);
  }
  const second = runtime.step();
  const third = runtime.step();
  assert.equal(
    second.events.some((event) => event.type === "ACTION_RELEASED"),
    false,
  );
  assert.deepEqual(
    third.events
      .filter((event) => ["ACTION_RELEASED", "DAMAGE", "ACTION_FINISHED"].includes(event.type))
      .map((event) => event.type),
    ["ACTION_RELEASED", "DAMAGE", "ACTION_FINISHED"],
  );
  assert.deepEqual(
    third.events.filter((event) => ["ACTION_RELEASED", "ACTION_FINISHED"].includes(event.type)),
    copySignals,
  );
  assert.deepEqual(runtime.snapshot().actionExecution, copied.state);
  assert.equal(
    runtime.snapshot().units.find((unit) => unit.id === 2).vitality.hp,
    getUnit(copiedState, 2).vitality.hp,
  );
  assert.equal(getUnit(copiedState, 2).vitality.hp, 90);
  assert.equal(snapshot.actionExecution.executions[0].wait.remainingTicks, 2);
});

test("action runtime: same-tick cancellation wins over release and does not affect sibling executions", () => {
  const actor = actorDefinition("overlapping", { baseAttackTimeTicks: 1 });
  const runtime = new BattleRuntime(
    spec([
      { definition: actor, position: [0, 0] },
      { definition: passiveDefinition(), position: [3, 0] },
    ]),
    {
      compileAction: (action, services) =>
        delayed(compileAction(action, services), 3, { allowNewAction: true }),
    },
  );
  const events = [];
  for (let tick = 0; tick < 3; tick++) {
    events.push(...runtime.step().events);
  }
  assert.deepEqual(
    runtime
      .snapshot()
      .actionExecution.executions.map((execution) => [execution.id, execution.sourceUnitId]),
    [
      [0, 0],
      [1, 0],
      [2, 0],
    ],
  );
  const command = { type: "CANCEL_ACTION_EXECUTION", executionId: 1 };
  events.push(...runtime.step([command, command]).events);
  assert.deepEqual(
    runtime.snapshot().actionExecution.executions.map((execution) => execution.id),
    [2, 3],
  );
  events.push(...runtime.step([command]).events);
  events.push(...runtime.step().events);

  assert.deepEqual(
    events
      .filter((event) => event.type === "ACTION_RELEASED")
      .map((event) => [event.executionId, event.tick]),
    [
      [0, 3],
      [2, 5],
    ],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "ACTION_CANCELLED").map((event) => event.executionId),
    [1],
  );
  assert.equal(runtime.snapshot().units.find((unit) => unit.id === 1).vitality.hp, 86);

  const due = runtime.snapshot().actionExecution.executions.find((execution) => execution.id === 3);
  assert.equal(due.wait.remainingTicks, 1);
  const dueCancellation = runtime.step([{ type: "CANCEL_ACTION_EXECUTION", executionId: 3 }]);
  assert.equal(
    dueCancellation.events.some(
      (event) => event.type === "ACTION_RELEASED" && event.executionId === 3,
    ),
    false,
  );
});

test("action runtime: a waiting segment blocks routed movement until its own transition completes", () => {
  const mover = actorDefinition("moving", { moving: true });
  const runtime = new BattleRuntime(
    spec([{ definition: passiveDefinition("ALLY"), position: [0, 0] }], [spawn(mover, 0)]),
    {
      compileAction: (action, services) =>
        delayed(compileAction(action, services), 2, { blockingMovement: true }),
    },
  );
  const first = runtime.step();
  const position = [...runtime.snapshot().units.find((unit) => unit.id === 1).position];
  assert.equal(
    first.events.some((event) => event.type === "ACTION" && event.sourceUnitId === 1),
    true,
  );
  runtime.step();
  assert.deepEqual(runtime.snapshot().units.find((unit) => unit.id === 1).position, position);
  const released = runtime.step();
  assert.equal(
    released.events.some((event) => event.type === "ACTION_RELEASED" && event.sourceUnitId === 1),
    true,
  );
  assert.equal(
    runtime.snapshot().units.find((unit) => unit.id === 1).position[0] < position[0],
    true,
  );
  assert.equal(runtime.snapshot().units.find((unit) => unit.id === 1).action.recoveryUntilTick, 0);
});

test("action runtime: failed continuation publishes no progress, sample, settlement or identity", () => {
  const scenario = (failing) => {
    const fault = { enabled: failing };
    const attemptedIds = [];
    const resources = new CombatResources();
    const marker = resources.registerEffect(
      createEffectDefinition({
        id: "action-sample",
        initialize: () => ({ count: 0 }),
      }),
    );
    const actor = actorDefinition("continuation");
    const runtime = new BattleRuntime(
      spec([
        { definition: actor, position: [0, 0] },
        { definition: passiveDefinition(), position: [3, 0] },
      ]),
      {
        combat: resources,
        compileAction: (action, services) => {
          const compiled = delayed(compileAction(action, services), 1);
          return {
            ...compiled,
            program: [
              {
                type: "EXECUTE",
                run: (context) => {installNewEffect(
                    context.work,
                    0,
                    marker,
                    {
                      source: 0,
                      scopes: [{ type: "ACTION", executionId: context.executionId }],
                    },
                    services,
                    context.tick,
                  );},
              },
              ...compiled.program,
              {
                type: "EXECUTE",
                run: (context) => {
                  attemptedIds.push(context.executionId);
                  updateEffectState(
                    context.work,
                    0,
                    0,
                    marker,
                    (state) => ({ count: state.count + 1 }),
                    services, 0,
                  );
                  if (fault.enabled) {
                    throw new Error("continuation failed");
                  }
                  return;
                },
              },
            ],
          };
        },
      },
    );
    return { runtime, fault, attemptedIds };
  };
  const failed = scenario(true);
  failed.runtime.step();
  const before = failed.runtime.snapshot();
  assert.throws(() => failed.runtime.step(), /continuation failed/);
  assert.deepEqual(failed.runtime.snapshot(), before);
  assert.equal(before.actionExecution.executions[0].id, 0);
  assert.equal(before.units[0].effects.instances[0].state.count, 0);
  assert.equal(before.units[1].vitality.hp, 100);
  assert.deepEqual(failed.attemptedIds, [0]);
  const clean = scenario(false);
  clean.runtime.step();
  clean.runtime.step();
  assert.deepEqual(clean.attemptedIds, [0]);
  assert.equal(clean.runtime.snapshot().actionExecution.nextExecutionId, 1);
  assert.equal(clean.runtime.snapshot().units[1].vitality.hp, 93);
});

test("action runtime: a throwing Effect finish after nested host death does not publish execution or battlefield changes", () => {
  const reasons = [];
  const resources = new CombatResources();
  const terminal = resources.registerEffect(createEffectDefinition({
    id: "throwing-action-terminal",
    initialize: () => ({}),
  }), { lifecycle: { finish: context => {
    reasons.push(context.end.reason);
    context.damage({ sourceUnitId: null, targetUnitId: 0, damageType: "TRUE", operands: createDamageOperands(100) });
    throw new Error("terminal failure");
  } } });
  const runtime = new BattleRuntime(spec([
    { definition: actorDefinition("terminal-failure"), position: [0, 0] },
    { definition: passiveDefinition(), position: [3, 0] },
  ]), {
    combat: resources,
    compileAction: (action, services) => {
      const compiled = compileAction(action, services);
      return {
        ...compiled,
        program: [
          { type: "EXECUTE", run: context => {installNewEffect(context.work, 0, terminal, {
              source: 0, scopes: [{ type: "ACTION", executionId: context.executionId }],
            }, services, context.tick);} },
          { type: "WAIT", allowNewAction: false, resolve: () => ({ type: "FOR_TICKS", ticks: 10 }) },
          ...compiled.program,
        ],
      };
    },
  });
  runtime.step();
  const before = runtime.snapshot();
  const cancel = [{ type: "CANCEL_ACTION_EXECUTION", executionId: 0 }];

  assert.throws(() => runtime.step(cancel), /terminal failure/);
  assert.deepEqual(runtime.snapshot(), before);
  assert.equal(before.actionExecution.executions[0].id, 0);
  assert.equal(before.units[0].vitality.hp, 100);

  assert.deepEqual(reasons, ["CANCELLED"]);
});
