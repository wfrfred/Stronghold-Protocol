import { fixtureBattlefield } from "../helpers/battlefield.js";
import { liveAttack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRng } from "../../dist/core/common/rng.js";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { advanceProjectiles as advanceBattleProjectiles } from "../../dist/core/tactical/battle/steps/projectiles.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";
import { createOperatorDefinition } from "../../dist/core/tactical/unit/archetype/operator.js";
import { createEnemyDefinition } from "../../dist/core/tactical/unit/archetype/enemy.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import { createRouteDefinition } from "../../dist/core/tactical/unit/capability/locomotion/route/definition.js";
import { compileAction } from "../../dist/core/tactical/unit/capability/action/compile.js";
import { createProjectileDefinition } from "../../dist/core/tactical/battlefield/projectile/definition.js";
import { createBattlefieldRuntime } from "../../dist/core/tactical/battlefield/runtime.js";
import { advanceProjectiles, stopProjectile } from "../../dist/core/tactical/battlefield/projectile/settlement.js";
import { withProjectileOperations } from "../../dist/core/tactical/battlefield/projectile/operations.js";
import { createEffectDefinition } from "../../dist/core/tactical/unit/capability/effects/definition.js";
import { installNewEffect } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import * as modifier from "../../dist/core/tactical/contribution/value.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import {
  battlefieldView,
  createBattleState,
  getUnit,
} from "../../dist/core/tactical/battle/execution/context.js";

const hit = createShapeGeometry({
  shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.1 }],
});
const range = {
  type: "SHAPES",
  geometry: createShapeGeometry({
    shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 10 }],
  }),
};
const contactRange = {
  type: "SHAPES",
  geometry: createShapeGeometry({
    shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.3 }],
  }),
};

function actorDefinition(id = "launcher", attack = 10) {
  return createOperatorDefinition({
    id,
    vitality: { maxHp: 100 },
    offense: { attack },
    defense: { defense: 0, resistance: 0 },
    allegiance: { side: "ALLY" },
    spatial: { layer: "GROUND" },
    hit: { geometry: hit },
    status: { initialFlags: [] },
    blocker: { capacity: 0, geometry: { radius: 0.1 } },
    action: {
      normalAction: {
        triggerBindingId: "primary",
        baseAttackTimeTicks: 100,
        recoveryTicks: 0,
        targetGroups: [
          {
            id: "primary",
            targeting: {
              type: "DAMAGE",
              scope: { type: "RANGE", geometry: range },
              canTargetAir: true,
              includeBlockingRelations: false,
              preferBlockingRelations: false,
              ignoreTargetFree: false,
              ignoreInvisible: false,
              maxTargets: 1,
            },
            operations: [{ type: "DAMAGE", power: 999, damageType: "TRUE" }],
          },
        ],
        followUps: [],
      },
    },
  });
}

function passiveDefinition(id = "receiver", side = "ENEMY") {
  return Object.freeze({
    id,
    vitality: Object.freeze({ maxHp: 100 }),
    defense: Object.freeze({ defense: 0, resistance: 0 }),
    allegiance: Object.freeze({ side }),
    spatial: Object.freeze({ layer: "GROUND" }),
    hit: Object.freeze({ geometry: hit }),
    status: Object.freeze({ initialFlags: Object.freeze([]) }),
  });
}

function spec(initialUnits, { maxTicks = 20, terminal = false } = {}) {
  const keepOpen = createEnemyDefinition({
    id: "later-wave",
    vitality: { maxHp: 1 },
    locomotion: {
      moveSpeedPerTick: 0,
      steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
    },
  });
  const route = createRouteDefinition({
    pathMotionMode: "WALK",
    startPosition: [0, 7],
    endPosition: [0, 1],
    spawnOffset: [0, 0],
    spawnRandomRange: [0, 0],
    checkpoints: [],
    allowDiagonalMove: false,
    visitEveryTileCenter: false,
    visitEveryNodeCenter: false,
    visitEveryCheckPoint: true,
  });

  return {
    ...createLegacyCombatSpec({
      rows: 1,
      columns: 8,
      operators: [],
      enemies: [],
      maxTicks,
      seed: 17,
    }),
    initialUnits,
    schedule: {
      type: "TIMELINE",
      spawns: terminal
        ? []
        : [
            {
              definition: keepOpen,
              route,
              tick: 100,
              timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
              alwaysCheckCurrentPoint: true,
              notCountInTotal: false,
            },
          ],
    },
  };
}

function registerProjectile(resources, { id = "shell", cachedOnly = false, acceptsContact, contact, stop } = {}) {
  return resources.projectiles.register(
    createProjectileDefinition({
      id,
      initialize: () => ({ contacts: 0 }),
      acceptsContact:
        acceptsContact ?? ((_context, unit) => unit.allegiance?.side === "ENEMY"),
      contact:
        contact ??
        ((context) => {
          context.operations.damage({
            sourceUnitId: context.projectile.source,
            targetUnitId: context.targetUnitId,
            tick: context.tick,
            damageType: "TRUE",
            operands: createDamageOperands(
              cachedOnly ? context.projectile.cachedAtk : context.attackPower(),
            ),
          });
        }),
      ...(stop === undefined ? {} : { stop }),
    }),
  );
}

function launch(context, services, program, overrides = {}) {
  const source = getUnit(context.work, context.sourceUnitId);
  const targetId = context.bindings.get("primary")[0];
  const target = getUnit(context.work, targetId);
  const id = context.projectiles.launch(program.ref, {
    source: source.id,
    traceTarget: targetId,
    position: source.position,
    destination: target.position,
    cachedAtk: resolveAttackPower(source.id, battlefieldView(context.work), services.computations),
    speedPerTick: 1,
    contactRange,
    stopDelayTicks: 1,
    expiresAtTick: null,
    ...overrides,
  });

  assert.equal(context.projectiles.get(id).id, id);
  assert.equal(context.projectiles.get(id).source, source.id);

  return id;
}

function projectileBattlefield(instances = []) {
  const battlefield = createBattlefieldRuntime({ map: spec([]).map });
  battlefield.advance(instances.map((projectile) => ({ type: "REGISTER_PROJECTILE", projectile })));
  return battlefield;
}

function projectileInstances(view) {
  return view.projectileIds.map((id) => view.getProjectile(id));
}

function execution(nextProjectileId = 0) {
  return { rngState: 0, nextUnitId: 0, nextNavigationRequestId: 0,
    nextMechanismId: 0, nextNavigationModifierId: 0, nextProjectileId };
}

function damageEvents(step) {
  return step.events.filter((event) => event.type === "DAMAGE");
}

function workFrom(snapshot) {
  const units = new Map(snapshot.units.map((unit) => [unit.id, unit]));

  const battlefield = fixtureBattlefield({
      unitIds: [...units.keys()],
      getUnit: (id) => units.get(id),
      blockerOf: () => undefined,
      blockedBy: () => [],
    });
  battlefield.advance(snapshot.projectiles.instances.map(projectile => ({ type: "REGISTER_PROJECTILE", projectile })));
  battlefield.apply();
  return createBattleState(battlefield, snapshot.execution);
}

test("projectile runtime: immediate and resumable Actions launch independent facts without moving on the release tick", () => {
  const instant = actorDefinition("instant");
  const deferred = actorDefinition("deferred");
  const resources = new CombatResources();
  const program = registerProjectile(resources);
  const launched = [];
  const borrowed = [];
  const runtime = new BattleRuntime(
    spec([
      { definition: instant, position: [0, 0] },
      { definition: deferred, position: [1, 0] },
      { definition: passiveDefinition(), position: [4, 0] },
    ]),
    {
      combat: resources,
      compileAction: (definition, services) => {
        const compiled = compileAction(definition, services);
        const release = (context) => {
          borrowed.push(context.projectiles);
          launched.push(launch(context, services, program));
          return;
        };

        return definition === instant.action.normalAction
          ? { ...compiled, program: [{ type: "EXECUTE", run: release }] }
          : {
              ...compiled,
              program: [
                { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 1 }) },
                { type: "RELEASE", markerId: "shell" },
                { type: "EXECUTE", run: release },
              ],
            };
      },
    },
  );

  const first = runtime.step();
  assert.deepEqual(launched, [0]);
  assert.deepEqual(runtime.snapshot().projectiles.instances.map((value) => value.position), [
    [0, 0],
  ]);
  assert.equal(runtime.snapshot().actionExecution.executions.length, 1);
  assert.deepEqual(damageEvents(first), []);
  assert.throws(() => borrowed[0].get(0), /no longer active/);

  const second = runtime.step();
  assert.deepEqual(launched, [0, 1]);
  assert.equal(runtime.snapshot().actionExecution.executions.length, 0);
  assert.deepEqual(runtime.snapshot().projectiles.instances.map((value) => value.position), [
    [1, 0],
    [1, 0],
  ]);
  assert.equal(second.events.some((event) => event.type === "ACTION_FINISHED"), true);
  assert.deepEqual(damageEvents(second), []);
  assert.throws(() => borrowed[1].get(1), /no longer active/);

  runtime.step();
  runtime.step();
  const reached = runtime.step();
  assert.equal(damageEvents(reached).length, 2);
  assert.equal(runtime.snapshot().units.find((unit) => unit.id === 2).vitality.hp, 80);
});

test("projectile runtime: contact re-queries current receivers after its original trace target retreats", () => {
  const resources = new CombatResources();
  const program = registerProjectile(resources);
  const actor = actorDefinition();
  const runtime = new BattleRuntime(
    spec([
      { definition: actor, position: [0, 0] },
      { definition: passiveDefinition("original"), position: [2, 0] },
      { definition: passiveDefinition("nearby"), position: [2.2, 0] },
    ]),
    {
      combat: resources,
      compileAction: (definition, services) => ({
        ...compileAction(definition, services),
        program: [
          { type: "EXECUTE", run: (context) => {
            launch(context, services, program);
            return;
          } },
        ],
      }),
    },
  );

  const launched = runtime.step();
  assert.equal(launched.events.find(event => event.type === 'ACTION').targetUnitId, 1);
  runtime.step([{ type: "RETREAT_UNIT", unitId: 1 }]);
  const reached = runtime.step();

  assert.deepEqual(damageEvents(reached).map((event) => event.targetUnitId), [2]);
  assert.equal(runtime.snapshot().units.find((unit) => unit.id === 2).vitality.hp, 90);
});

test("projectile runtime: contact freezes candidate identities and reads eligibility after earlier receiver transitions", () => {
  const resources = new CombatResources();
  const contacted = [];
  const program = registerProjectile(resources, {
    acceptsContact: (_context, unit) =>
      unit.allegiance?.side === "ENEMY" && (unit.id === 1 || unit.vitality.hp < 100),
    contact: (context) => {
      contacted.push(context.targetUnitId);
      if (context.targetUnitId === 1) {
        context.operations.damage({
          sourceUnitId: context.projectile.source,
          targetUnitId: 2,
          tick: context.tick,
          damageType: "TRUE",
          operands: createDamageOperands(1),
        });
        assert.equal(context.facts.getUnit(2).vitality.hp, 99);
      }
      context.operations.damage({
        sourceUnitId: context.projectile.source,
        targetUnitId: context.targetUnitId,
        tick: context.tick,
        damageType: "TRUE",
        operands: createDamageOperands(context.attackPower()),
      });
    },
  });
  const runtime = new BattleRuntime(
    spec([
      { definition: actorDefinition(), position: [0, 0] },
      { definition: passiveDefinition("first"), position: [1, 0] },
      { definition: passiveDefinition("newly-eligible"), position: [1.2, 0] },
    ]),
    {
      combat: resources,
      compileAction: (definition, services) => ({
        ...compileAction(definition, services),
        program: [
          { type: "EXECUTE", run: (context) => {
            launch(context, services, program);
            return;
          } },
        ],
      }),
    },
  );

  runtime.step();
  const reached = runtime.step();

  assert.deepEqual(contacted, [1, 2]);
  assert.deepEqual(
    reached.events
      .filter((event) => event.type === "PROJECTILE_HIT")
      .map((event) => event.targetUnitId),
    [1, 2],
  );
  assert.equal(runtime.snapshot().units.find((unit) => unit.id === 1).vitality.hp, 90);
  assert.equal(runtime.snapshot().units.find((unit) => unit.id === 2).vitality.hp, 89);
});

test("projectile runtime: current ATK and cached-only ATK stay distinct, while a missing source uses its launch sample", () => {
  const scenario = () => {
    const resources = new CombatResources();
    const normal = registerProjectile(resources, { id: "ordinary" });
    const cached = registerProjectile(resources, { id: "cached", cachedOnly: true });
    const bonus = resources.registerEffect(
      createEffectDefinition({
        id: "post-launch-attack",
        initialize: () => ({}),
      }),
      { contributions: [liveAttack(() => [modifier.create({ addition: 10 })])] },
    );
    const runtime = new BattleRuntime(
      spec([
        { definition: actorDefinition(), position: [0, 0] },
        { definition: passiveDefinition(), position: [3, 0] },
      ]),
      {
        combat: resources,
        compileAction: (definition, services) => ({
          ...compileAction(definition, services),
          program: [
            { type: "EXECUTE", run: (context) => {
              launch(context, services, normal);
              launch(context, services, cached);
              installNewEffect(
                context.work,
                context.sourceUnitId,
                bonus,
                { source: context.sourceUnitId, scopes: [] },
                services,
                context.tick,
              );


            } },
          ],
        }),
      },
    );

    return runtime;
  };

  const alive = scenario();
  alive.step();
  assert.deepEqual(alive.snapshot().projectiles.instances.map((value) => value.cachedAtk), [
    10,
    10,
  ]);
  alive.step();
  alive.step();
  assert.deepEqual(damageEvents(alive.step()).map((event) => event.amount), [20, 10]);
  assert.equal(alive.snapshot().units.find((unit) => unit.id === 1).vitality.hp, 70);

  const retired = scenario();
  retired.step();
  retired.step([{ type: "RETREAT_UNIT", unitId: 0 }]);
  retired.step();
  assert.deepEqual(damageEvents(retired.step()).map((event) => event.amount), [10, 10]);
  assert.equal(retired.snapshot().units.find((unit) => unit.id === 1).vitality.hp, 80);
});

test("projectile runtime: Schedule completion and time limits freeze outstanding processes without running stop callbacks", () => {
  for (const terminal of [true, false]) {
    let stopped = 0;
    const resources = new CombatResources();
    const program = registerProjectile(resources, { stop: () => { stopped++; } });
    const runtime = new BattleRuntime(
      spec([
        { definition: actorDefinition(), position: [0, 0] },
        { definition: passiveDefinition(), position: [6, 0] },
      ], { terminal, maxTicks: terminal ? 20 : 2 }),
      {
        combat: resources,
        compileAction: (definition, services) => ({
          ...compileAction(definition, services),
          program: [
            {
              type: "EXECUTE",
              run: (context) => {
                launch(context, services, program);
                return;
              },
            },
            { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 10 }) },
          ],
        }),
      },
    );

    runtime.step();
    if (!terminal) {
      runtime.step();
    }
    const final = runtime.snapshot();
    assert.equal(final.result.reason, terminal ? "SCHEDULE_COMPLETED" : "TIME_LIMIT");
    assert.equal(final.actionExecution.executions.length, 1);
    assert.equal(final.projectiles.instances.length, 1);
    assert.deepEqual(runtime.step().events, []);
    assert.deepEqual(runtime.step().events, []);
    assert.deepEqual(runtime.snapshot(), final);
    assert.equal(stopped, 0);
  }
});

test("projectile runtime: contact history prevents stop fallback damage while synchronous successors remain visible", () => {
  const resources = new CombatResources();
  const attached = resources.registerEffect(
    createEffectDefinition({
      id: "contact-before-damage",
      initialize: () => ({}),
    }),
    {
      damage: {
        reception: {
          priority: 0,
          apply: (_context, pending) => ({ value: { ...pending, amount: pending.amount + 1 } }),
        },
      },
    },
  );
  let stopped = 0;
  let borrowed;
  const trace = [];
  const program = registerProjectile(resources, {
    contact: (context) => {
      trace.push({ stage: "CONTACT", hitUnitIds: [...context.projectile.hitUnitIds] });
      borrowed = context.operations;
      context.operations.updateState((state) => ({ contacts: state.contacts + 1 }));
      const installed = context.operations.effects.install(context.targetUnitId, attached, {
        source: context.projectile.source,
        scopes: [],
      });
      assert.equal(installed.type, "INSTALLED");
      assert.equal(
        context.facts.getUnit(context.targetUnitId).effects.instances.some(
          (effect) => effect.definition.id === attached.id,
        ),
        true,
      );
      const report = context.operations.damage({
        sourceUnitId: context.projectile.source,
        targetUnitId: context.targetUnitId,
        tick: context.tick,
        damageType: "TRUE",
        operands: createDamageOperands(context.attackPower()),
      });
      assert.equal(report.hpLoss, 11);
      context.operations.stopSelf();
      context.operations.stopSelf();
      assert.equal(context.projectile.state.contacts, 1);
      assert.equal(context.facts.getUnit(context.targetUnitId).vitality.hp, 92);
      assert.equal(context.facts.getProjectile(context.projectile.id), undefined);
      context.operations.updateState((state) => ({ contacts: state.contacts + 1 }));
      trace.push({ stage: "AFTER_STOP", hitUnitIds: [...context.projectile.hitUnitIds] });
      assert.equal(context.projectile.state.contacts, 2);
      assert.equal(context.facts.getProjectile(context.projectile.id), undefined);
    },
    stop: (context) => {
      stopped++;
      trace.push({ stage: "STOP", hitUnitIds: [...context.projectile.hitUnitIds] });
      context.operations.stopSelf();
      const target = context.facts.getUnit(context.projectile.traceTarget);
      if (target !== undefined && !context.projectile.hitUnitIds.includes(target.id)) {
        context.operations.damage({
          sourceUnitId: context.projectile.source,
          targetUnitId: target.id,
          tick: context.tick,
          damageType: "TRUE",
          operands: createDamageOperands(context.attackPower()),
        });
      }
      context.operations.heal({
        sourceUnitId: context.projectile.source,
        targetUnitId: context.projectile.traceTarget,
        power: 3,
        ignoreHealFree: false,
      });
    },
  });
  const runtime = new BattleRuntime(
    spec([
      { definition: actorDefinition(), position: [0, 0] },
      { definition: passiveDefinition(), position: [1, 0] },
    ]),
    {
      combat: resources,
      compileAction: (definition, services) => ({
        ...compileAction(definition, services),
        program: [
          { type: "EXECUTE", run: (context) => {
            launch(context, services, program);
            return;
          } },
        ],
      }),
    },
  );

  runtime.step();
  const reached = runtime.step();
  assert.deepEqual(trace, [
    { stage: "CONTACT", hitUnitIds: [1] },
    { stage: "STOP", hitUnitIds: [1] },
    { stage: "AFTER_STOP", hitUnitIds: [1] },
  ]);
  assert.equal(stopped, 1);
  assert.deepEqual(
    reached.events
      .filter((event) => ["PROJECTILE_REACHED", "DAMAGE", "PROJECTILE_STOPPED", "HEAL", "PROJECTILE_HIT"].includes(event.type))
      .map((event) => event.type),
    ["PROJECTILE_REACHED", "DAMAGE", "PROJECTILE_STOPPED", "HEAL", "PROJECTILE_HIT"],
  );
  assert.deepEqual(runtime.snapshot().projectiles.instances, []);
  assert.throws(() => borrowed.stopSelf(), /no longer active/);
  const repeated = runtime.step([
    { type: "STOP_PROJECTILE", projectileId: 0 },
    { type: "STOP_PROJECTILE", projectileId: 0 },
  ]);
  assert.equal(stopped, 1);
  assert.equal(repeated.events.some((event) => event.type === "HEAL"), false);
});

test("projectile runtime: a same-process immutable copy replays arrival and stopping, and snapshots contain only data", () => {
  const resources = new CombatResources();
  const program = registerProjectile(resources);
  const runtime = new BattleRuntime(
    spec([
      { definition: actorDefinition(), position: [0, 0] },
      { definition: passiveDefinition(), position: [2, 0] },
    ]),
    {
      combat: resources,
      compileAction: (definition, services) => ({
        ...compileAction(definition, services),
        program: [
          { type: "EXECUTE", run: (context) => {
            launch(context, services, program);
            return;
          } },
        ],
      }),
    },
  );

  runtime.step();
  const original = runtime.snapshot();
  const clone = structuredClone(original);
  assert.deepEqual(clone, original);
  const copied = workFrom(original);
  const replayEvents = [];
  const actualEvents = [];

  for (const tick of [1, 2, 3]) {
    advanceProjectiles(copied, resources, tick);
    const actual = runtime.step();
    actualEvents.push(...actual.events);
  }
  replayEvents.push(...copied.events);
  assert.deepEqual(actualEvents, replayEvents);
  assert.deepEqual(runtime.snapshot().projectiles, {
    nextProjectileId: copied.execution.nextProjectileId,
    instances: projectileInstances(copied.battlefield.snapshot("draft")),
  });
  assert.equal(
    runtime.snapshot().units.find((unit) => unit.id === 1).vitality.hp,
    getUnit(copied, 1).vitality.hp,
  );
  assert.equal(original.projectiles.instances[0].position[0], 0);
  assert.equal(original.projectiles.instances[0].hitUnitIds.length, 0);
});

test("projectile runtime: a failed stop propagates without publishing launch, samples or receiver transitions", () => {
  const scenario = (failing) => {
    const fault = { enabled: failing };
    const resources = new CombatResources();
    const attempted = [];
    const borrowed = [];
    const stoppedHistories = [];
    const actor = actorDefinition();
    const child = registerProjectile(resources, { id: "next-shell" });
    const program = registerProjectile(resources, {
      contact: (context) => {
        context.operations.damage({
          sourceUnitId: context.projectile.source,
          targetUnitId: context.targetUnitId,
          tick: context.tick,
          damageType: "TRUE",
          operands: createDamageOperands(context.attackPower()),
        });
        context.operations.stopSelf();
      },
      stop: (context) => {
        stoppedHistories.push([...context.projectile.hitUnitIds]);
        context.operations.heal({
          sourceUnitId: context.projectile.source,
          targetUnitId: context.projectile.traceTarget,
          power: 2,
          ignoreHealFree: false,
        });
        if (fault.enabled) {
          throw new Error("stop successor failed");
        }
      },
    });
    const runtime = new BattleRuntime(
      spec([
        { definition: actor, position: [0, 0] },
        { definition: passiveDefinition(), position: [1, 0] },
      ]),
      {
        combat: resources,
        compileAction: (definition, services) => ({
          ...compileAction(definition, services),
          program: [
            {
              type: "EXECUTE",
              run: (context) => {
                borrowed.push(context.projectiles);
                attempted.push(launch(context, services, program, { stopDelayTicks: 0 }));
                return {samples: { emitted: 1 }};
              },
            },
            { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 1 }) },
            {
              type: "EXECUTE",
              run: (context) => {
                borrowed.push(context.projectiles);
                attempted.push(launch(context, services, child));
                const rng = createRng(context.work.execution.rngState);
                const sample = rng.next();
                context.work.execution = {
                    ...context.work.execution,
                    rngState: rng.state(),
                  };return {samples: { emitted: 2, sample }};
              },
            },
            { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 4 }) },
          ],
        }),
      },
    );

    return { runtime, fault, attempted, borrowed, stoppedHistories, ref: child.ref };
  };

  const failed = scenario(true);
  const control = scenario(false);
  failed.runtime.step();
  control.runtime.step();
  const before = failed.runtime.snapshot();
  assert.throws(() => failed.runtime.step(), /stop successor failed/);
  assert.deepEqual(failed.stoppedHistories, [[1]]);
  assert.deepEqual(failed.runtime.snapshot(), before);
  assert.deepEqual(before.projectiles.instances[0].hitUnitIds, []);
  assert.deepEqual(failed.attempted, [0, 1]);
  assert.throws(() => failed.borrowed[1].get(1), /no longer active/);
  assert.throws(
    () => failed.borrowed[1].launch(failed.ref, {
      source: 0,
      traceTarget: 1,
      position: [0, 0],
      destination: [1, 0],
      cachedAtk: 10,
      speedPerTick: 1,
      contactRange,
      stopDelayTicks: 1,
    }),
    /no longer active/,
  );
  assert.equal(before.projectiles.nextProjectileId, 1);
  assert.equal(before.actionExecution.executions[0].samples.emitted, 1);
  assert.equal(before.units.find((unit) => unit.id === 1).vitality.hp, 100);
  const expectedRng = createRng(before.execution.rngState);
  const expectedSample = expectedRng.next();

  control.runtime.step();
  assert.deepEqual(control.attempted, [0, 1]);
  assert.deepEqual(control.stoppedHistories, [[1]]);
  assert.equal(control.runtime.snapshot().units.find((unit) => unit.id === 1).vitality.hp, 92);
  assert.equal(control.runtime.snapshot().projectiles.nextProjectileId, 2);
  assert.equal(control.runtime.snapshot().actionExecution.executions[0].samples.emitted, 2);
  assert.equal(control.runtime.snapshot().actionExecution.executions[0].samples.sample, expectedSample);
  assert.deepEqual(control.runtime.snapshot().execution, {
    ...before.execution,
    rngState: expectedRng.state(),
    nextProjectileId: 2,
  });
});

test("projectile runtime: bulk launch shares immutable payloads and preserves earlier snapshots", () => {
  const resources = new CombatResources();
  const program = registerProjectile(resources);
  const previous = projectileBattlefield();
  const previousExecution = execution();
  const input = {
    source: null,
    traceTarget: null,
    position: [0, 0],
    destination: [100, 0],
    cachedAtk: 10,
    speedPerTick: 1,
    contactRange,
    stopDelayTicks: 1,
    initialState: { contacts: 0, history: [1] },
  };
  let borrowed;
  const observed = [];
  const launched = withProjectileOperations(previous.snapshot("draft"), previousExecution.nextProjectileId, resources.projectiles, 0, (operations) => {
    borrowed = operations;
    for (let index = 0; index < 32; index++) {
      assert.equal(operations.launch(program.ref, input), index);
      observed.push(operations.get(index));
      assert.equal(operations.get(index).id, index);
    }
    return operations.get(0);
  });

  assert.deepEqual(previous.snapshot("draft").projectileIds, []);
  assert.equal(previousExecution.nextProjectileId, 0);
  assert.equal(launched.nextProjectileId, 32);
  assert.equal(launched.result, observed[0]);
  assert.equal(observed[0].position, input.position);
  assert.equal(observed[0].destination, input.destination);
  assert.equal(observed[0].contactRange, input.contactRange);
  assert.equal(observed[0].state, input.initialState);
  assert.throws(() => borrowed.get(0), /no longer active/);
  assert.throws(() => borrowed.launch(program.ref, input), /no longer active/);

  const original = previous.snapshot("draft");
  const released = previous;
  released.advance(launched.changes);
  assert.deepEqual(projectileInstances(released.snapshot("draft")), observed);
  assert.deepEqual(original.projectileIds, []);
  const launchedSnapshot = released.snapshot("draft");
  const work = createBattleState(released, { ...previousExecution, nextProjectileId: launched.nextProjectileId });
  const sibling = createBattleState(fixtureBattlefield(launchedSnapshot), work.execution);
  advanceProjectiles(work, resources, 1);
  advanceProjectiles(sibling, resources, 1);
  assert.deepEqual(projectileInstances(released.snapshot("draft")), projectileInstances(sibling.battlefield.snapshot("draft")));
  assert.equal(released.snapshot("draft").projectileIds.length, 32);
  assert.equal(projectileInstances(released.snapshot("draft")).every((instance) => instance.position[0] === 1), true);
  assert.equal(projectileInstances(launchedSnapshot).every((instance) => instance.position[0] === 0), true);
  assert.equal(released.snapshot("draft").getProjectile(0).state, input.initialState);
  assert.equal(released.snapshot("draft").getProjectile(0).destination, input.destination);
  assert.equal(released.snapshot("draft").getProjectile(0).hitUnitIds, observed[0].hitUnitIds);
  const unchanged = projectileInstances(released.snapshot("draft"));
  advanceProjectiles(work, resources, 1);
  assert.deepEqual(projectileInstances(released.snapshot("draft")), unchanged);
});

test("projectile runtime: failed launch scopes discard allocation and close borrowed operations", () => {
  const resources = new CombatResources();
  const program = registerProjectile(resources);
  const previous = projectileBattlefield();
  const previousExecution = execution();
  const input = {
    source: null,
    traceTarget: null,
    position: [0, 0],
    destination: [2, 0],
    cachedAtk: 10,
    speedPerTick: 1,
    contactRange,
    stopDelayTicks: 1,
  };
  let borrowed;
  assert.throws(() => withProjectileOperations(previous.snapshot("draft"), previousExecution.nextProjectileId, resources.projectiles, 0, (operations) => {
    borrowed = operations;
    assert.equal(operations.launch(program.ref, input), 0);
    assert.equal(operations.get(0).id, 0);
    throw new Error("launch scope failed");
  }), /launch scope failed/);
  assert.deepEqual(previous.snapshot("draft").projectileIds, []);
  assert.equal(previousExecution.nextProjectileId, 0);
  assert.throws(() => borrowed.get(0), /no longer active/);
  assert.throws(() => borrowed.launch(program.ref, input), /no longer active/);

  const retried = withProjectileOperations(previous.snapshot("draft"), previousExecution.nextProjectileId, resources.projectiles, 0,
    (operations) => operations.launch(program.ref, input));
  assert.equal(retried.result, 0);
  assert.equal(retried.nextProjectileId, 1);
  assert.deepEqual(previous.snapshot("draft").projectileIds, []);
  assert.equal(previousExecution.nextProjectileId, 0);
});

test("projectile runtime: stop callbacks see latest peer progress while snapshots retain earlier instances", () => {
  const resources = new CombatResources();
  const observations = [];
  let borrowed;
  const program = registerProjectile(resources, {
    stop: (context) => {
      borrowed = context;
      const first = context.facts.getProjectile(0);
      const second = context.facts.getProjectile(1);
      observations.push({
        id: context.projectile.id,
        first: first?.progress.type,
        second: second?.progress.type,
      });
      context.operations.updateState((state) => ({ ...state, contacts: state.contacts + 1 }));
      assert.equal(context.facts.getProjectile(context.projectile.id).state.contacts, 1);
    },
  });
  const launchAt = (operations, destination) => operations.launch(program.ref, {
    source: null,
    traceTarget: null,
    position: [0, 0],
    destination,
    cachedAtk: 0,
    speedPerTick: 1,
    contactRange,
    stopDelayTicks: 0,
  });
  const empty = projectileBattlefield();
  const launched = withProjectileOperations(empty.snapshot("draft"), 0, resources.projectiles, 0, (operations) => {
    launchAt(operations, [1, 0]);
    launchAt(operations, [100, 0]);
  });
  const battlefield = empty;
  battlefield.advance([...launched.changes].reverse());
  const launchedSnapshot = battlefield.snapshot("draft");
  const work = createBattleState(battlefield, execution(launched.nextProjectileId));
  advanceProjectiles(work, resources, 1);
  assert.deepEqual(observations, [{ id: 0, first: "STOPPED", second: "FLYING" }]);
  assert.deepEqual(battlefield.snapshot("draft").projectileIds, [1]);
  assert.deepEqual(battlefield.snapshot("draft").getProjectile(1).position, [1, 0]);
  assert.deepEqual(projectileInstances(launchedSnapshot).map((instance) => instance.progress.type), ["FLYING", "FLYING"]);
  assert.throws(() => borrowed.facts.getProjectile(1), /no longer active/);

  const progressed = battlefield.snapshot("draft");
  stopProjectile(work, 1, resources, 1);
  assert.deepEqual(observations[1], { id: 1, first: undefined, second: "STOPPED" });
  assert.deepEqual(battlefield.snapshot("draft").projectileIds, []);
  assert.equal(progressed.getProjectile(1).progress.type, "FLYING");
  assert.equal(progressed.getProjectile(1).state.contacts, 0);
});

test("projectile runtime: command stops share one container before advancing survivors", () => {
  const resources = new CombatResources();
  const observed = [];
  const program = registerProjectile(resources, {
    stop: (context) => {
      observed.push(context.projectile.id);
    },
  });
  const battlefield = projectileBattlefield();
  const launched = withProjectileOperations(battlefield.snapshot("draft"), 0, resources.projectiles, 0, (operations) => {
    for (let index = 0; index < 32; index++) {
      operations.launch(program.ref, {
        source: null,
        traceTarget: null,
        position: [0, 0],
        destination: [100, 0],
        cachedAtk: 0,
        speedPerTick: 1,
        contactRange,
        stopDelayTicks: 1,
      });
    }
  });
  battlefield.advance(launched.changes);
  const ids = Array.from({ length: 16 }, (_, index) => 30 - index * 2);
  const stopIds = ids.flatMap((projectileId) => [projectileId, projectileId]);
  stopIds.push(999);
  let containers = 0;
  const NativeMap = globalThis.Map;
  class ObservedMap extends NativeMap {
    constructor(entries) {
      super(entries);
      if (Array.isArray(entries) && entries.length > 0 && entries.every(([, value]) =>
        value !== null && typeof value === "object" && Object.hasOwn(value, "lastAdvancedTick")
      )) {
        containers++;
      }
    }
  }
  const before = battlefield.snapshot("draft");
  const state = createBattleState(battlefield, execution(launched.nextProjectileId));
  try {
    globalThis.Map = ObservedMap;
    advanceBattleProjectiles(state, 1,
      stopIds.map(projectileId => ({ type: "STOP_PROJECTILE", projectileId })), resources);
  } finally {
    globalThis.Map = NativeMap;
  }

  assert.equal(containers, 1);
  assert.deepEqual(observed, ids);
  assert.deepEqual(state.events.map((event) => event.projectileId), ids);
  const progressed = battlefield.snapshot("draft");
  assert.deepEqual(progressed.projectileIds, Array.from({ length: 16 }, (_, index) => index * 2 + 1));
  assert.equal(projectileInstances(progressed).every((instance) => instance.position[0] === 1), true);
  assert.equal(projectileInstances(before).every((instance) => instance.position[0] === 0), true);
  assert.equal(projectileInstances(before).every((instance) => instance.progress.type === "FLYING"), true);
});

test("projectile Battlefield changes: rejected batches and dropped drafts preserve published projectile instances", () => {
  const resources = new CombatResources();
  const program = registerProjectile(resources);
  const battlefield = projectileBattlefield();
  const launched = withProjectileOperations(battlefield.snapshot("draft"), 0, resources.projectiles, 0,
    (operations) => operations.launch(program.ref, {
      source: null, traceTarget: null, position: [0, 0], destination: [3, 0],
      cachedAtk: 0, speedPerTick: 1, contactRange, stopDelayTicks: 1,
    }));
  battlefield.advance(launched.changes);
  battlefield.apply();
  const original = battlefield.snapshot("draft").getProjectile(0);
  const maps = battlefield.snapshot("draft").navigationMaps;
  assert.throws(() => battlefield.advance([
    { type: "UPDATE_PROJECTILE", projectile: { ...original, position: [1, 0] } },
    { type: "REMOVE_PROJECTILE", projectileId: 999 },
  ]), /unknown projectile/);
  assert.equal(battlefield.snapshot("draft").getProjectile(0), original);
  assert.equal(battlefield.snapshot("draft").navigationMaps, maps);
  const failure = new Error("projectile settlement failed");
  assert.throws(() => {
    try {
      battlefield.advance([{ type: "REMOVE_PROJECTILE", projectileId: 0 }]);
      assert.deepEqual(battlefield.snapshot("draft").projectileIds, []);
      assert.equal(battlefield.snapshot("state").getProjectile(0), original);
      throw failure;
    } finally {
      battlefield.drop();
    }
  }, error => error === failure);
  assert.equal(battlefield.snapshot("draft").getProjectile(0), original);
  assert.deepEqual(battlefield.snapshot("draft").projectileIds, [0]);
});

test("projectile runtime: ordered command stops see same-tick launches and publish only on success", () => {
  const scenario = (failing) => {
    const resources = new CombatResources();
    const fault = { enabled: failing };
    const observed = [];
    const attempted = [];
    const borrowed = [];
    const program = registerProjectile(resources, {
      stop: (context) => {
        if (borrowed.length > 0) {
          assert.throws(() => borrowed.at(-1).operations.stopSelf(), /no longer active/);
        }
        borrowed.push(context);
        observed.push({
          id: context.projectile.id,
          hp: context.facts.getUnit(1).vitality.hp,
          survivorPosition: context.facts.getProjectile(2).position,
          newPeer: context.facts.getProjectile(3)?.progress.type,
        });
        assert.equal(context.facts.getProjectile(context.projectile.id).progress.type, "STOPPED");
        context.operations.stopSelf();
        context.operations.stopSelf();
        context.operations.updateState((state) => ({ ...state, contacts: state.contacts + 1 }));
        assert.equal(context.projectile.state.contacts, 1);
        context.operations.damage({
          sourceUnitId: context.projectile.source,
          targetUnitId: 1,
          tick: context.tick,
          damageType: "TRUE",
          operands: createDamageOperands(1),
        });
        if (fault.enabled && context.projectile.id === 1) {
          throw new Error("second command stop failed");
        }
      },
    });
    const runtime = new BattleRuntime(
      spec([
        { definition: actorDefinition(), position: [0, 0] },
        { definition: passiveDefinition(), position: [4, 0] },
      ]),
      {
        combat: resources,
        compileAction: (definition, services) => ({
          ...compileAction(definition, services),
          program: [
            { type: "EXECUTE", run: (context) => {
              for (let index = 0; index < 3; index++) {
                attempted.push(launch(context, services, program));
              }
              return;
            } },
            { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 1 }) },
            { type: "EXECUTE", run: (context) => {
              attempted.push(launch(context, services, program));
              return;
            } },
          ],
        }),
      },
    );
    runtime.step();

    return { runtime, fault, observed, attempted, borrowed };
  };
  const commands = [3, 3, 999, 1, 0].map((projectileId) => ({ type: "STOP_PROJECTILE", projectileId }));
  const control = scenario(false);
  const failed = scenario(true);
  const before = failed.runtime.snapshot();
  assert.throws(() => failed.runtime.step(commands), /second command stop failed/);
  assert.deepEqual(failed.runtime.snapshot(), before);
  assert.deepEqual(failed.attempted, [0, 1, 2, 3]);
  assert.deepEqual(failed.observed.map((entry) => entry.id), [3, 1]);
  for (const context of failed.borrowed) {
    assert.throws(() => context.facts.getProjectile(2), /no longer active/);
    assert.throws(() => context.operations.updateState((state) => state), /no longer active/);
  }

  const ordinary = control.runtime.step(commands);
  assert.deepEqual(control.attempted, [0, 1, 2, 3]);
  assert.deepEqual(control.observed, [
    { id: 3, hp: 100, survivorPosition: [0, 0], newPeer: "STOPPED" },
    { id: 1, hp: 99, survivorPosition: [0, 0], newPeer: undefined },
    { id: 0, hp: 98, survivorPosition: [0, 0], newPeer: undefined },
  ]);
  assert.deepEqual(ordinary.events
    .filter((event) => event.type === "PROJECTILE_STOPPED" || event.type === "DAMAGE")
    .map((event) => event.type), [
      "PROJECTILE_STOPPED", "DAMAGE", "PROJECTILE_STOPPED", "DAMAGE", "PROJECTILE_STOPPED", "DAMAGE",
    ]);
  const snapshot = control.runtime.snapshot();
  assert.equal(snapshot.projectiles.nextProjectileId, 4);
  assert.deepEqual(snapshot.projectiles.instances.map((instance) => [instance.id, instance.position]), [[2, [1, 0]]]);
  assert.equal(snapshot.units.find((unit) => unit.id === 1).vitality.hp, 97);
  assert.equal(before.projectiles.instances.every((instance) => instance.progress.type === "FLYING"), true);
  assert.equal(before.projectiles.instances.every((instance) => instance.state.contacts === 0), true);
});
