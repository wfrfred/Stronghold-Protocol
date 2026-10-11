import { createActionState } from "../../dist/core/tactical/unit/capability/action/capability.js";
import { setAttackContribution, removeAttackContribution } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { setHook as setDamageHook, removeHook as removeDamageHook } from "../../dist/core/tactical/unit/capability/vitality/damage/hook.js";
import { get as getEffect } from "../../dist/core/tactical/unit/effect/query.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";
import { createOperatorDefinition } from "../../dist/core/tactical/unit/archetype/operator.js";
import { createEnemyDefinition } from "../../dist/core/tactical/unit/archetype/enemy.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { seededPlacement } from "../helpers/aura.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import { createRouteDefinition } from "../../dist/core/tactical/unit/capability/locomotion/route/definition.js";
import { compileAction } from "../../dist/core/tactical/unit/capability/action/compile.js";
import { apply as applyEffect, setState as setEffectState } from "../../dist/core/tactical/unit/effect/operations.js";
import { hasStatusFlag, addStatusContribution, removeStatusContribution } from "../../dist/core/tactical/unit/capability/status/capability.js";
import * as modifier from "../../dist/core/tactical/unit/contribution/value.js";
import { initializeVitalityState } from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { battlefieldView, getUnit, transitionUnit } from "../../dist/core/tactical/battle/execution/context.js";
import { createProjectileDefinition } from "../../dist/core/tactical/battlefield/projectile/definition.js";

const hit = createShapeGeometry({
  shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.1 }],
});
const range = {
  type: "SHAPES",
  geometry: createShapeGeometry({
    shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 12 }],
  }),
};
const contactRange = {
  type: "SHAPES",
  geometry: createShapeGeometry({
    shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.3 }],
  }),
};

function passive(id, hp = 100) {
  return {
    id,
    vitality: { maxHp: hp },
    offense: { attack: 10 },
    defense: { defense: 0, resistance: 0 },
    allegiance: { side: "ENEMY" },
    spatial: { layer: "GROUND" },
    hit: { geometry: hit },
    status: { initialFlags: [] },
  };
}

function actor(id) {
  return createOperatorDefinition({
    ...passive(id),
    allegiance: { side: "ALLY" },
    blocker: { capacity: 0, geometry: { radius: 0.1 } },
    action: {
      normalAction: {
        triggerBindingId: "primary",
        baseAttackTimeTicks: 100,
        recoveryTicks: 0,
        targetGroups: [{
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
          operations: [{ type: "DAMAGE", power: 10, damageType: "TRUE" }],
        }],
        followUps: [],
      },
    },
  });
}

function view(snapshot) {
  const units = new Map(snapshot.units.map((unit) => [unit.id, unit]));
  return {
    unitIds: [...units.keys()],
    getUnit: (id) => units.get(id),
    blockerOf: () => undefined,
    blockedBy: () => [],
  };
}

function effect(snapshot, unitId, ref) {
  return snapshot.units.find((unit) => unit.id === unitId).effects.instances
    .find((instance) => instance.definition.id === ref.id);
}

function scenario({ failure = null, cancelled = false } = {}) {
  const resources = new CombatResources();
  const fault = { enabled: failure !== null };
  const launches = [];
  const scopes = [];
  const attempts = [];
  const reports = [];
  const rejected = [];
  const auraAddress = { type: "EFFECT", unitId: 0, effectId: 0 };
  let aura;

  const registerBuff = (id, addition, flags = []) => ({
    id,
    initialize: () => ({ starts: 0, enables: 0 }),
    onApply(context) {
      context.setState(state => ({ ...state, starts: state.starts + 1 }));
    },
    onEnable(context) {
      context.setState(state => ({ ...state, enables: state.enables + 1 }));
      const id = `effect:${context.self.id}`;
      transitionUnit(context.battle, context.ref.unitId, unit => {
        const next = setAttackContribution(unit, { id, value: [modifier.create({ finalAddition: addition })] });
        return flags.length === 0 ? next : { ...next, status: addStatusContribution(next.status, { id, flags }) };
      });
    },
    onDisable(context) {
      const id = `effect:${context.self.id}`;
      transitionUnit(context.battle, context.ref.unitId, unit => {
        const next = removeAttackContribution(unit, id);
        return flags.length === 0 ? next : { ...next, status: removeStatusContribution(next.status, id) };
      });
    },
  });
  const marker = registerBuff("receiver-mark", 3, ["INVISIBLE"]);
  const scoped = registerBuff("execution-power", 2);
  const pulse = registerBuff("release-power", 1);
  const receiverOutput = registerBuff("aura-receiver", 5);
  const receiver = {
    ...receiverOutput,
    initialize: () => ({ ...receiverOutput.initialize(), uses: 0 }),
    onApply(context) {
      receiverOutput.onApply(context);
      const ref = context.ref;
      transitionUnit(context.battle, ref.unitId, unit => setDamageHook(unit, {
        id: `receiver:${ref.effectId}`,
        stage: "reception",
        priority: 0,
        enabled: invocation => getEffect(invocation.battle, ref)?.status === "ACTIVE",
        invoke(invocation, pending) {
          const battle = invocation.battle;
          assert.ok(getEffect(battle, auraAddress).state.remaining > 0);
          setEffectState(battle, auraAddress, aura, state => ({
            ...state, remaining: state.remaining - 1, consumed: state.consumed + 1,
          }));
          setEffectState(battle, ref, receiver, state => ({ ...state, uses: state.uses + 1 }));
          if (cancelled) {
            rejected.push({ type: "SKIPPED", reason: "CONTENT_CONDITION" });
            invocation.operations.heal({
              sourceUnitId: 0, targetUnitId: ref.unitId, power: 4, ignoreHealFree: false,
            });
          } else {
            assert.ok(applyEffect(battle, getUnit(battle, ref.unitId), marker, {
              source: 0, scopes: [ref],
            }));
          }
          const quota = getEffect(battle, auraAddress).state;
          attempts.push({ address: ref,
            quota: { remaining: quota.remaining, consumed: quota.consumed },
            marked: hasStatusFlag(getUnit(battle, ref.unitId), "INVISIBLE"),
          });
          return { value: { ...pending,
            amount: fault.enabled && failure === "invalid-damage" ? NaN : pending.amount,
            cancellation: cancelled ? { stage: "RECEPTION", reason: "BLOCKED" } : null,
          } };
        },
      }));
    },
    onEnd(context) {
      transitionUnit(context.battle, context.ref.unitId, unit => removeDamageHook(unit, `receiver:${context.self.id}`));
    },
  };
  aura = {
    id: "combined-aura",
    initialize: () => ({ remaining: 3, consumed: 0, receivers: [] }),
    onTick(context) {
      if (context.tick >= 3) {
        context.end("AURA_FINISHED");
        return;
      }
      for (const unitId of battlefieldView(context.battle).unitIds) {
        if (context.self.status === "FINISHED") return;
        if (context.self.state.receivers.some(binding => binding.unitId === unitId)) continue;
        context.setState(state => ({ ...state,
          receivers: [...state.receivers, { unitId, ref: null, attempts: 1 }],
        }));
        const ref = applyEffect(context.battle, getUnit(context.battle, unitId), receiver, {
          source: context.ref.unitId, scopes: [context.ref],
        });
        assert.ok(ref);
        context.setState(state => ({ ...state,
          receivers: state.receivers.map(binding => binding.unitId === unitId ? { ...binding, ref } : binding),
        }));
      }
    },
  };
  const shell = resources.projectiles.register(createProjectileDefinition({
    id: "combined-shell",
    initialize: () => ({ contacts: 0 }),
    acceptsContact: (context, unit) =>
      unit.id === context.projectile.traceTarget && !hasStatusFlag(unit, "INVISIBLE"),
    contact: (context) => {
      scopes.push(context);
      context.operations.updateState((state) => ({ contacts: state.contacts + 1 }));
      reports.push(context.operations.damage({
        sourceUnitId: context.projectile.source,
        targetUnitId: context.targetUnitId,
        damageType: "TRUE",
        operands: createDamageOperands(context.projectile.cachedAtk),
        tick: context.tick,
      }));
      context.operations.stopSelf();
      if (fault.enabled && failure === "late-projectile") {
        const auraState = context.facts.getUnit(0).effects.instances
          .find(instance => instance.definition === aura).state;
        assert.deepEqual(auraState.receivers.map(binding => binding.unitId), [0, 1, 2, 3]);
        assert.equal(context.facts.getUnit(1).vitality.hp, 83);
        assert.equal(hasStatusFlag(context.facts.getUnit(1), "INVISIBLE"), true);
        assert.equal(context.facts.getUnit(2).action.readyAtTick, 101);
        throw new Error("late composition failure");
      }
    },
  }));
  const primary = actor("primary-launcher");
  const sibling = actor("later-launcher");
  const scheduled = {
    ...createEnemyDefinition({
      id: "managed-target",
      vitality: { maxHp: 17 },
      locomotion: {
        moveSpeedPerTick: 0,
        steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
      },
    }),
    ...passive("managed-target", 17),
  };
  const route = createRouteDefinition({
    pathMotionMode: "WALK",
    startPosition: [0, 6], endPosition: [0, 7],
    spawnOffset: [0, 0], spawnRandomRange: [0.25, 0.25],
    checkpoints: [{ type: "WAIT_FOR_TICKS", durationTicks: 100 }],
    allowDiagonalMove: false, visitEveryTileCenter: false,
    visitEveryNodeCenter: false, visitEveryCheckPoint: true,
  });
  const installation = (context, services, program) => applyEffect(
    context.work, getUnit(context.work, context.sourceUnitId), program, {
      source: context.sourceUnitId,
      scopes: [{ type: "ACTION", executionId: context.executionId }],
    },
  );
  const launch = (context, services, targetUnitId) => {
    const source = getUnit(context.work, context.sourceUnitId);
    const target = getUnit(context.work, targetUnitId);
    const id = context.projectiles.launch(shell.ref, {
      source: source.id, traceTarget: targetUnitId,
      position: source.position, destination: target.position,
      cachedAtk: resolveAttackPower(source.id, battlefieldView(context.work)),
      speedPerTick: 1, contactRange, stopDelayTicks: 0, expiresAtTick: null,
    });
    launches.push({ id, executionId: context.executionId, targetUnitId });
  };
  const runtime = new BattleRuntime({
    ...createLegacyCombatSpec({
      rows: 3, columns: 8, operators: [], enemies: [], maxTicks: 20, seed: 17,
    }),
    initialUnits: [
      seededPlacement(aura, initializeUnit({ id: 0, definition: primary, position: [0, 0] })),
      { definition: passive("first-target"), position: [1, 0],
        ...(cancelled ? { states: { vitality: {
          ...initializeVitalityState({ maxHp: 100 }), hp: 40,
        } } } : {}) },
      { definition: sibling, position: [0, 2],
        states: { action: { ...createActionState(), readyAtTick: 1 } } },
    ],
    initialMechanisms: [],
    schedule: { type: "TIMELINE", spawns: [{
      definition: scheduled, route, tick: 1,
      timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
      alwaysCheckCurrentPoint: true, notCountInTotal: false,
    }] },
  }, {
    combat: resources,
    compileAction: (definition, services) => {
      const compiled = compileAction(definition, services);
      const first = { type: "EXECUTE", run: (context) => {
        installation(context, services, scoped);
        launch(context, services, definition === primary.action.normalAction ? 1 : 3);
        return { samples: { emitted: 1 } };
      } };
      return { ...compiled, program: definition === primary.action.normalAction ? [
        first,
        { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 1 }) },
        { type: "RELEASE", markerId: "secondary" },
        { type: "EXECUTE", run: (context) => {
          installation(context, services, pulse);
          launch(context, services, 3);
          return { samples: { emitted: 2 } };
        } },
        { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 2 }) },
      ] : [first, { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 4 }) }] };
    },
  });
  return { runtime, resources, fault, launches, attempts, scopes, reports, rejected,
    aura: aura, receiver: receiver, marker: marker, scoped: scoped, pulse: pulse };
}

test("runtime composition: late exceptions and invalid settlement propagate without publishing any domain", () => {
  for (const failure of ["late-projectile", "invalid-damage"]) {
    const failed = scenario({ failure });
    failed.runtime.step();
    const before = failed.runtime.snapshot();
    const maps = failed.runtime.navigationMaps;
    assert.equal(before.actionExecution.nextExecutionId, 1);
    assert.equal(before.projectiles.nextProjectileId, 1);
    assert.equal(before.execution.nextUnitId, 3);
    assert.equal(before.spawning.spawnedCount, 0);
    assert.equal(effect(before, 0, failed.scoped).state.starts, 1);
    assert.equal(resolveAttackPower(0, view(before)), 17);

    assert.throws(() => failed.runtime.step(), {
      "late-projectile": /late composition failure/,
      "invalid-damage": RangeError,
    }[failure]);
    assert.deepEqual(failed.runtime.snapshot(), before);
    assert.equal(failed.runtime.navigationMaps, maps);
    assert.deepEqual(failed.launches.map((launch) => [launch.id, launch.executionId]), [[0, 0], [1, 0], [2, 1]]);
    assert.deepEqual(failed.attempts, [{
      address: { type: "EFFECT", unitId: 1, effectId: 0 },
      quota: { remaining: 2, consumed: 1 }, marked: true,
    }]);
  }
});

test("runtime composition: a successful battle preserves identities, snapshots and the terminal trace", () => {
  const run = scenario();
  const replay = scenario();
  const serialized = value => JSON.parse(JSON.stringify(value));
  const first = run.runtime.step();
  assert.deepEqual(serialized(first), serialized(replay.runtime.step()));
  const events = [...first.events];
  const before = run.runtime.snapshot();
  const second = run.runtime.step();
  assert.deepEqual(serialized(second), serialized(replay.runtime.step()));
  assert.deepEqual(serialized(run.runtime.snapshot()), serialized(replay.runtime.snapshot()));
  events.push(...second.events);
  const after = run.runtime.snapshot();
  assert.equal(effect(before, 0, run.aura).definition, run.aura);
  assert.equal(effect(after, 0, run.aura).definition, run.aura);
  assert.equal(effect(after, 1, run.receiver).definition, run.receiver);
  assert.notEqual(after.execution.rngState, before.execution.rngState);
  assert.equal(after.execution.nextUnitId, 4);
  assert.equal(after.spawning.cursor, 1);
  assert.equal(after.spawning.spawnedCount, 1);
  assert.deepEqual(after.spawning.managedFinalUnitIds, [3]);
  assert.equal(after.actionExecution.nextExecutionId, 2);
  assert.equal(after.actionExecution.executions[0].samples.emitted, 2);
  assert.equal(after.projectiles.nextProjectileId, 3);
  assert.deepEqual(after.projectiles.instances.map((projectile) => projectile.id), [1, 2]);
  assert.deepEqual(after.projectiles.instances.map((projectile) => projectile.cachedAtk), [18, 17]);
  assert.equal(resolveAttackPower(0, view(after)), 18);
  assert.equal(effect(after, 0, run.aura).state.remaining, 2);
  assert.equal(effect(after, 0, run.aura).state.consumed, 1);
  assert.deepEqual(effect(after, 0, run.aura).state.receivers.map(binding => binding.attempts), [1, 1, 1, 1]);
  assert.deepEqual(effect(after, 3, run.receiver).state, { starts: 1, enables: 1, uses: 0 });
  assert.deepEqual(effect(after, 1, run.receiver).state, { starts: 1, enables: 1, uses: 1 });
  assert.equal(effect(after, 1, run.marker).id, 1);
  assert.deepEqual(effect(after, 1, run.marker).scopes, [{ type: "EFFECT", unitId: 1, effectId: 0 }]);
  assert.equal(after.units.find((unit) => unit.id === 1).effects.nextId, 2);
  assert.equal(before.units.find((unit) => unit.id === 1).effects.nextId, 1);
  assert.equal(hasStatusFlag(after.units.find((unit) => unit.id === 1), "INVISIBLE"), true);
  assert.equal(after.units.find((unit) => unit.id === 1).vitality.hp, 83);
  assert.deepEqual(run.launches.map((launch) => launch.id), [0, 1, 2]);
  assert.deepEqual(before.units.map((unit) => unit.id), [0, 1, 2]);
  assert.equal(effect(before, 0, run.aura).state.remaining, 3);
  assert.equal(effect(before, 0, run.aura).state.consumed, 0);
  assert.deepEqual(effect(before, 0, run.aura).state.receivers.map(binding => binding.unitId), [0, 1, 2]);
  assert.equal(before.units[1].vitality.hp, 100);

  while (run.runtime.result === null) {
    const actual = run.runtime.step();
    assert.deepEqual(serialized(actual), serialized(replay.runtime.step()));
    assert.deepEqual(serialized(run.runtime.snapshot()), serialized(replay.runtime.snapshot()));
    events.push(...actual.events);
    if (run.runtime.snapshot().tickIndex === 4) {
      const cleaned = run.runtime.snapshot();
      assert.equal(effect(cleaned, 0, run.aura), undefined);
      assert.ok(cleaned.units.every(unit => effect(cleaned, unit.id, run.receiver) === undefined));
      assert.equal(effect(before, 0, run.aura).status, "ACTIVE");
      assert.equal(hasStatusFlag(cleaned.units.find((unit) => unit.id === 1), "INVISIBLE"), false);
      assert.equal(resolveAttackPower(0, view(cleaned)), 10);
      assert.equal(effect(cleaned, 0, run.scoped), undefined);
      assert.equal(effect(cleaned, 0, run.pulse), undefined);
    }
    if (run.runtime.snapshot().tickIndex === 5) {
      const finalized = run.runtime.snapshot();
      assert.equal(effect(finalized, 0, run.scoped), undefined);
      assert.equal(effect(finalized, 0, run.pulse), undefined);
      assert.equal(effect(finalized, 1, run.marker), undefined);
    }
  }
  assert.deepEqual(events.filter((event) => event.type === "ENEMY_SPAWNED").map((event) => event.unitId), [3]);
  assert.deepEqual(events.filter((event) => event.type === "PROJECTILE_HIT").map((event) => [event.projectileId, event.targetUnitId]), [[0, 1], [1, 3]]);
  assert.deepEqual(events.filter((event) => event.type === "DAMAGE").map((event) => [event.targetUnitId, event.amount]), [[1, 17], [3, 17]]);
  assert.equal(run.reports.at(-1).formulaDamage, 18);
  assert.equal(run.reports.at(-1).hpLoss, 17);
  assert.equal(run.runtime.result.reason, "SCHEDULE_COMPLETED");
  assert.equal(run.runtime.result.spawnedCount, 1);
  assert.equal(run.runtime.result.unspawnedCount, 0);
  assert.equal(run.runtime.result.completedRouteCount, 0);
  assert.deepEqual(run.runtime.result.remainingUnitIds, [0, 1, 2]);
  assert.ok(run.runtime.result.elapsedTicks >= 7);
  const final = run.runtime.snapshot();
  assert.deepEqual(run.runtime.step(), { events: [], result: run.runtime.result });
  assert.deepEqual(run.runtime.snapshot(), final);
});

test("runtime composition: content conditions skip installation while cancelled damage retains consumption and healing", () => {
  const run = scenario({ cancelled: true });
  run.runtime.step();
  const reached = run.runtime.step();
  const after = run.runtime.snapshot();
  assert.deepEqual(run.rejected, [{
    type: "SKIPPED", reason: "CONTENT_CONDITION",
  }]);
  assert.equal(run.reports[0].hpLoss, 0);
  assert.deepEqual(run.reports[0].cancellation, { stage: "RECEPTION", reason: "BLOCKED" });
  assert.deepEqual(reached.events.filter((event) => ["HEAL", "DAMAGE"].includes(event.type))
    .map((event) => [event.type, event.targetUnitId, event.amount, event.hp]), [
    ["HEAL", 1, 4, 44], ["DAMAGE", 1, 0, 44],
  ]);
  assert.equal(after.tickIndex, 2);
  assert.equal(after.execution.nextUnitId, 4);
  assert.equal(after.spawning.spawnedCount, 1);
  assert.equal(after.actionExecution.nextExecutionId, 2);
  assert.equal(after.projectiles.nextProjectileId, 3);
  assert.equal(effect(after, 0, run.aura).state.remaining, 2);
  assert.equal(effect(after, 0, run.aura).state.consumed, 1);
  assert.equal(effect(after, 1, run.receiver).state.uses, 1);
  assert.equal(effect(after, 1, run.marker), undefined);
  assert.equal(hasStatusFlag(after.units.find((unit) => unit.id === 1), "INVISIBLE"), false);
  assert.equal(resolveAttackPower(1, view(after)), 15);
  assert.equal(after.units.find((unit) => unit.id === 1).effects.nextId, 1);
  while (run.runtime.result === null) run.runtime.step();
  const final = run.runtime.snapshot();
  assert.equal(final.result.reason, "SCHEDULE_COMPLETED");
  assert.equal(final.units.find((unit) => unit.id === 1).vitality.hp, 44);
  assert.equal(hasStatusFlag(final.units.find((unit) => unit.id === 1), "INVISIBLE"), false);
  assert.equal(resolveAttackPower(1, view(final)), 10);
});
