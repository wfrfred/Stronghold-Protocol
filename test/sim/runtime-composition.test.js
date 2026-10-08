import { computedAttack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";
import { createOperatorDefinition } from "../../dist/core/tactical/unit/archetype/operator.js";
import { createEnemyDefinition } from "../../dist/core/tactical/unit/archetype/enemy.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import { createRouteDefinition } from "../../dist/core/tactical/unit/capability/locomotion/route/definition.js";
import { compileAction } from "../../dist/core/tactical/unit/capability/action/compile.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { installNewEffect } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { compileStatusBinding } from "../../dist/core/tactical/unit/capability/status/binding.js";
import { hasStatusFlag } from "../../dist/core/tactical/unit/capability/status/capability.js";
import { createNumericContribution } from "../../dist/core/tactical/modifier/numeric.js";
import { initializeVitalityState } from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { combatWorkView, getCombatUnit } from "../../dist/core/tactical/battle/execution/work.js";
import { createProjectileProgram } from "../../dist/core/tactical/battlefield/projectile/program.js";
import {
  createMechanismDefinition,
  createMechanismRuntime,
} from "../../dist/core/tactical/battlefield/mechanism.js";
import {
  createEffectSourceProgramRef,
  effectSourceInstallation,
} from "../../dist/core/tactical/battlefield/effect-source/program.js";

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
        intervalTicks: 100,
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
    .find((instance) => instance.programRef.id === ref.id);
}

function scenario({ failure = null, cancelled = false } = {}) {
  const resources = new CombatResources();
  const fault = { enabled: failure !== null };
  const launches = [];
  const scopes = [];
  const attempts = [];
  const reports = [];
  const rejected = [];
  const sourceRef = createEffectSourceProgramRef("combined-source");

  const registerBuff = (id, addition, flags = []) => {
    let program;
    program = resources.registerEffect(createEffectProgram({
      id,
      initialize: () => ({ starts: 0, enables: 0 }),
      ownState: (state) => ({ ...state }),
    }), {
      contributions: [computedAttack(() => [createNumericContribution({ finalAddition: addition })])],
      bindings: flags.length === 0 ? [] : [compileStatusBinding(flags)],
      lifecycle: {
        start: (context) => {
          context.effects.update(context.address, program.ref, (state) => ({
            ...state, starts: state.starts + 1,
          }));
        },
        enable: (context) => {
          context.effects.update(context.address, program.ref, (state) => ({
            ...state, enables: state.enables + 1,
          }));
        },
      },
    });
    return program;
  };
  const marker = registerBuff("receiver-mark", 3, ["INVISIBLE"]);
  const scoped = registerBuff("execution-power", 2);
  const pulse = registerBuff("release-power", 1);
  const refused = resources.registerEffect(createEffectProgram({
    id: "refused-installation",
    initialize: () => ({}),
    ownState: (state) => ({ ...state }),
  }), {
    lifecycle: {
      start: (context) => {
        const prefix = context.effects.install(context.address.unitId, marker.ref, {
          source: 0, scope: null, expiresAtTick: null,
        });
        assert.equal(prefix.type, "INSTALLED");
      },
      accepts: () => false,
    },
  });
  let receiver;
  receiver = resources.registerEffect(createEffectProgram({
    id: "source-receiver",
    initialize: () => ({ starts: 0, enables: 0, uses: 0 }),
    ownState: (state) => ({ ...state }),
  }), {
    contributions: [computedAttack(() => [createNumericContribution({ finalAddition: 5 })])],
    lifecycle: {
      start: (context) => {
        context.effects.update(context.address, receiver.ref, (state) => ({
          ...state, starts: state.starts + 1,
        }));
      },
      enable: (context) => {
        context.effects.update(context.address, receiver.ref, (state) => ({
          ...state, enables: state.enables + 1,
        }));
      },
    },
    damage: {
      reception: {
        priority: 0,
        apply: (context, pending) => {
          assert.equal(context.operations.sources.tryConsume(40, sourceRef, (state) =>
            state.remaining === 0 ? undefined : {
              remaining: state.remaining - 1, consumed: state.consumed + 1,
            }), true);
          context.operations.effects.update(context.address, receiver.ref, (state) => ({
            ...state, uses: state.uses + 1,
          }));
          if (cancelled) {
            rejected.push(context.operations.effects.install(context.ownerUnitId, refused.ref, {
              source: 0, scope: null, expiresAtTick: null,
            }));
            context.operations.heal({
              sourceUnitId: 0, targetUnitId: context.ownerUnitId,
              power: 4, ignoreHealFree: false,
            });
          } else {
            const installed = context.operations.effects.install(context.ownerUnitId, marker.ref, {
              source: 0, scope: null, expiresAtTick: null,
            });
            assert.equal(installed.type, "INSTALLED");
            assert.equal(context.operations.effects.attachParent(installed.address, context.address).type, "BOUND");
          }
          attempts.push({
            address: context.address,
            source: context.operations.sources.get(40, sourceRef).effectSource.state,
            marked: hasStatusFlag(context.facts.getUnit(context.ownerUnitId), "INVISIBLE"),
          });
          return { value: {
            ...pending,
            amount: fault.enabled && failure === "invalid-damage" ? NaN : pending.amount,
            cancellation: cancelled ? { stage: "RECEPTION", reason: "BLOCKED" } : null,
          } };
        },
      },
    },
  });
  resources.effectSources.register({
    ref: sourceRef,
    initialize: () => ({ remaining: 3, consumed: 0 }),
    ownState: (state) => ({ ...state }),
    selectInitial: ({ battlefield }) => battlefield.unitIds,
    acceptsRegistration: () => true,
    install: () => effectSourceInstallation(receiver.ref, { expiresAtTick: null }),
    shouldFinish: ({ source, battlefield, tick }) => {
      if (fault.enabled && failure === "late-source" && source.effectSource.state.consumed > 0) {
        assert.deepEqual(source.effectSource.receivers.map((binding) => binding.unitId), [0, 1, 2, 3]);
        assert.equal(battlefield.getUnit(1).vitality.hp, 83);
        assert.equal(hasStatusFlag(battlefield.getUnit(1), "INVISIBLE"), true);
        assert.equal(battlefield.getUnit(2).action.readyAtTick, 101);
        throw new Error("late composition failure");
      }
      return tick >= 3;
    },
  });
  const source = createMechanismRuntime({
    id: 40,
    definition: createMechanismDefinition({ id: sourceRef.id }),
    active: true,
    effectSource: resources.effectSources.create(sourceRef, { sourceUnitId: null }),
  });
  const shell = resources.projectiles.register(createProjectileProgram({
    id: "combined-shell",
    initialize: () => ({ contacts: 0 }),
    ownState: (state) => ({ ...state }),
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
  const installation = (context, services, program) => installNewEffect(
    context.work, context.sourceUnitId, program.ref, {
      source: context.sourceUnitId,
      scope: { type: "EXECUTION", unitId: context.sourceUnitId, executionId: context.executionId },
      expiresAtTick: null,
    }, services, context.tick,
  ).work;
  const launch = (context, services, targetUnitId) => {
    const source = getCombatUnit(context.work, context.sourceUnitId);
    const target = getCombatUnit(context.work, targetUnitId);
    const id = context.projectiles.launch(shell.ref, {
      source: source.id, traceTarget: targetUnitId,
      position: source.position, destination: target.position,
      cachedAtk: resolveAttackPower(source.id, combatWorkView(context.work), services.offense),
      speedPerTick: 1, contactRange, stopDelayTicks: 0, expiresAtTick: null,
    });
    launches.push({ id, executionId: context.executionId, targetUnitId });
  };
  const runtime = new BattleRuntime({
    ...createLegacyCombatSpec({
      rows: 3, columns: 8, operators: [], enemies: [], maxTicks: 20, seed: 17,
    }),
    initialUnits: [
      { definition: primary, position: [0, 0] },
      { definition: passive("first-target"), position: [1, 0],
        ...(cancelled ? { states: { vitality: {
          ...initializeVitalityState({ maxHp: 100 }), hp: 40,
        } } } : {}) },
      { definition: sibling, position: [0, 2],
        states: { action: { readyAtTick: 1, recoveryUntilTick: 0 } } },
    ],
    initialMechanisms: [source],
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
        const work = installation(context, services, scoped);
        launch({ ...context, work }, services, definition === primary.action.normalAction ? 1 : 3);
        return { work, samples: { emitted: 1 } };
      } };
      return { ...compiled, program: definition === primary.action.normalAction ? [
        first,
        { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 1 }) },
        { type: "RELEASE", markerId: "secondary" },
        { type: "EXECUTE", run: (context) => {
          const work = installation(context, services, pulse);
          launch({ ...context, work }, services, 3);
          return { work, samples: { emitted: 2 } };
        } },
        { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 2 }) },
      ] : [first, { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 4 }) }] };
    },
  });
  return { runtime, resources, fault, launches, attempts, scopes, reports, rejected,
    receiver: receiver.ref, marker: marker.ref, scoped: scoped.ref, pulse: pulse.ref };
}

test("runtime composition: late exceptions and invalid settlement discard every domain, then retry the same identities and terminal trace", () => {
  for (const failure of ["late-source", "invalid-damage"]) {
    const failed = scenario({ failure });
    const clean = scenario();
    const events = [...failed.runtime.step().events];
    assert.deepEqual(events, clean.runtime.step().events);
    const before = failed.runtime.snapshot();
    const maps = failed.runtime.navigationMaps;
    assert.equal(before.actionExecution.nextExecutionId, 1);
    assert.equal(before.projectiles.nextProjectileId, 1);
    assert.equal(before.execution.nextUnitId, 3);
    assert.equal(before.spawning.spawnedCount, 0);
    assert.equal(effect(before, 0, failed.scoped).state.starts, 1);
    assert.equal(resolveAttackPower(0, view(before), failed.resources.offense), 17);

    assert.throws(() => failed.runtime.step(), failure === "late-source" ? /late composition failure/ : RangeError);
    assert.deepEqual(failed.runtime.snapshot(), before);
    assert.equal(failed.runtime.navigationMaps, maps);
    assert.deepEqual(failed.launches.map((launch) => [launch.id, launch.executionId]), [[0, 0], [1, 0], [2, 1]]);
    assert.deepEqual(failed.attempts, [{
      address: { unitId: 1, instanceId: 0 },
      source: { remaining: 2, consumed: 1 }, marked: true,
    }]);
    assert.throws(() => failed.scopes[0].facts.getUnit(1), /no longer active/);
    assert.throws(() => failed.scopes[0].operations.updateState((state) => state), /no longer active/);

    failed.fault.enabled = false;
    const retried = failed.runtime.step();
    assert.deepEqual(retried, clean.runtime.step());
    assert.deepEqual(failed.runtime.snapshot(), clean.runtime.snapshot());
    events.push(...retried.events);
    const after = failed.runtime.snapshot();
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
    assert.equal(resolveAttackPower(0, view(after), failed.resources.offense), 18);
    assert.deepEqual(after.mechanisms[0].effectSource.state, { remaining: 2, consumed: 1 });
    assert.deepEqual(after.mechanisms[0].effectSource.receivers.map((binding) => binding.installationAttempts), [1, 1, 1, 1]);
    assert.deepEqual(effect(after, 3, failed.receiver).state, { starts: 1, enables: 1, uses: 0 });
    assert.deepEqual(effect(after, 1, failed.receiver).state, { starts: 1, enables: 1, uses: 1 });
    assert.equal(effect(after, 1, failed.marker).id, 1);
    assert.deepEqual(effect(after, 1, failed.marker).parent, { unitId: 1, instanceId: 0 });
    assert.equal(after.units.find((unit) => unit.id === 1).effects.nextInstanceId, 2);
    assert.equal(before.units.find((unit) => unit.id === 1).effects.nextInstanceId, 1);
    assert.equal(hasStatusFlag(after.units.find((unit) => unit.id === 1), "INVISIBLE"), true);
    assert.equal(after.units.find((unit) => unit.id === 1).vitality.hp, 83);
    assert.deepEqual(failed.launches.map((launch) => launch.id), [0, 1, 2, 1, 2]);
    assert.deepEqual(before.units.map((unit) => unit.id), [0, 1, 2]);
    assert.deepEqual(before.mechanisms[0].effectSource.state, { remaining: 3, consumed: 0 });
    assert.equal(before.units[1].vitality.hp, 100);

    while (failed.runtime.result === null) {
      const actual = failed.runtime.step();
      assert.deepEqual(actual, clean.runtime.step());
      assert.deepEqual(failed.runtime.snapshot(), clean.runtime.snapshot());
      events.push(...actual.events);
      if (failed.runtime.snapshot().tickIndex === 4) {
        const cleaned = failed.runtime.snapshot();
        assert.equal(cleaned.mechanisms[0].effectSource.finished, true);
        assert.equal(hasStatusFlag(cleaned.units.find((unit) => unit.id === 1), "INVISIBLE"), false);
        assert.equal(resolveAttackPower(0, view(cleaned), failed.resources.offense), 10);
        assert.equal(effect(cleaned, 0, failed.scoped).finished, true);
        assert.equal(effect(cleaned, 0, failed.scoped).participating, false);
        assert.equal(effect(cleaned, 0, failed.pulse).finished, true);
        assert.equal(effect(cleaned, 0, failed.pulse).participating, false);
      }
      if (failed.runtime.snapshot().tickIndex === 5) {
        const finalized = failed.runtime.snapshot();
        assert.equal(effect(finalized, 0, failed.scoped), undefined);
        assert.equal(effect(finalized, 0, failed.pulse), undefined);
        assert.equal(effect(finalized, 1, failed.marker), undefined);
      }
    }
    assert.deepEqual(events.filter((event) => event.type === "ENEMY_SPAWNED").map((event) => event.unitId), [3]);
    assert.deepEqual(events.filter((event) => event.type === "PROJECTILE_HIT").map((event) => [event.projectileId, event.targetUnitId]), [[0, 1], [1, 3]]);
    assert.deepEqual(events.filter((event) => event.type === "DAMAGE").map((event) => [event.targetUnitId, event.amount]), [[1, 17], [3, 17]]);
    assert.equal(failed.reports.at(-1).formulaDamage, 18);
    assert.equal(failed.reports.at(-1).hpLoss, 17);
    assert.equal(failed.runtime.result.reason, "SCHEDULE_COMPLETED");
    assert.equal(failed.runtime.result.spawnedCount, 1);
    assert.equal(failed.runtime.result.unspawnedCount, 0);
    assert.equal(failed.runtime.result.completedRouteCount, 0);
    assert.deepEqual(failed.runtime.result.remainingUnitIds, [0, 1, 2]);
    assert.ok(failed.runtime.result.elapsedTicks >= 7);
    const final = failed.runtime.snapshot();
    assert.deepEqual(failed.runtime.step(), { events: [], result: failed.runtime.result });
    assert.deepEqual(failed.runtime.snapshot(), final);
  }
});

test("runtime composition: admission rejection and cancelled damage publish nested lifecycle, shared consumption and healing prefixes", () => {
  const run = scenario({ cancelled: true });
  run.runtime.step();
  const reached = run.runtime.step();
  const after = run.runtime.snapshot();
  assert.deepEqual(run.rejected, [{
    type: "REJECTED", reason: "ADMISSION_REJECTED", address: { unitId: 1, instanceId: 1 },
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
  assert.deepEqual(after.mechanisms[0].effectSource.state, { remaining: 2, consumed: 1 });
  assert.equal(effect(after, 1, run.receiver).state.uses, 1);
  assert.equal(effect(after, 1, run.marker).id, 2);
  assert.deepEqual(effect(after, 1, run.marker).state, { starts: 1, enables: 1 });
  assert.equal(effect(after, 1, run.marker).parent, null);
  assert.equal(hasStatusFlag(after.units.find((unit) => unit.id === 1), "INVISIBLE"), true);
  assert.equal(resolveAttackPower(1, view(after), run.resources.offense), 18);
  assert.equal(after.units.find((unit) => unit.id === 1).effects.nextInstanceId, 3);
  while (run.runtime.result === null) run.runtime.step();
  const final = run.runtime.snapshot();
  assert.equal(final.result.reason, "SCHEDULE_COMPLETED");
  assert.equal(final.units.find((unit) => unit.id === 1).vitality.hp, 44);
  assert.equal(hasStatusFlag(final.units.find((unit) => unit.id === 1), "INVISIBLE"), true);
  assert.equal(resolveAttackPower(1, view(final), run.resources.offense), 13);
});
