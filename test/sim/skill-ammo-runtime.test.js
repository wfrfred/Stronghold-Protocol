import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { battlefieldView, getUnit } from "../../dist/core/tactical/battle/execution/context.js";
import { createProjectileDefinition } from "../../dist/core/tactical/battlefield/projectile/definition.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import { create as modifier } from "../../dist/core/tactical/contribution/value.js";
import { createOperatorDefinition } from "../../dist/core/tactical/unit/archetype/operator.js";
import { compileAction } from "../../dist/core/tactical/unit/capability/action/compile.js";
import { createEffectDefinition } from "../../dist/core/tactical/unit/capability/effects/definition.js";
import { attack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { createSkillDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";

const hit = createShapeGeometry({
  shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.1 }],
});
const range = createShapeGeometry({
  shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 8 }],
});

function scenario({ ammo = 1, targets = 1, interrupt = false, program } = {}) {
  const resources = new CombatResources();
  const skill = createSkillDefinition({
    id: "runtime-ammo-skill", activation: "MANUAL", spRecovery: "TIME",
    spCost: 1, initialSp: 1, durationTicks: null, ammo,
  });
  const buff = resources.registerEffect(createEffectDefinition({
    id: "runtime-ammo-attack", initialize: () => ({}),
  }), {
    contributions: [attack(() => [modifier({ multiplier: 1 })])],
    ...(interrupt ? { action: { beforeRelease: () => ({ type: "INTERRUPT", recoveryTicks: 15 }) } } : {}),
  });
  resources.skills.register({ definition: skill, activate: (context) => {
    const installed = context.effects.install(context.unitId, buff, {
      source: context.unitId, scopes: [{ type: "SKILL", unitId: context.unitId, activationId: context.activationId }],
    });
    assert.equal(installed.type, "INSTALLED");
    assert.equal(installed.type, "INSTALLED");
    return { type: "ACTIVATED" };
  } });
  const definition = createOperatorDefinition({
    id: "ammo-actor", vitality: { maxHp: 10000 }, offense: { attack: 100 },
    defense: { defense: 0, resistance: 0 }, allegiance: { side: "ALLY" },
    spatial: { layer: "GROUND" }, hit: { geometry: hit }, status: { initialFlags: [] },
    blocker: { capacity: 0, geometry: { radius: 0.1 } }, skill,
    action: { normalAction: {
      triggerBindingId: "main", baseAttackTimeTicks: 100, recoveryTicks: 0, followUps: [],
      targetGroups: [{ id: "main", targeting: {
        type: "DAMAGE", scope: { type: "RANGE", geometry: { type: "SHAPES", geometry: range } },
        canTargetAir: true, includeBlockingRelations: false, preferBlockingRelations: false,
        ignoreTargetFree: false, ignoreInvisible: false, maxTargets: targets,
      }, operations: [{ type: "DAMAGE", power: 1, damageType: "TRUE", powerSource: "SOURCE_ATTACK" }] }],
    } },
  });
  const receiver = {
    id: "ammo-target", vitality: { maxHp: 10000 }, defense: { defense: 0, resistance: 0 },
    allegiance: { side: "ENEMY" }, spatial: { layer: "GROUND" }, hit: { geometry: hit },
    status: { initialFlags: [] },
  };
  const shell = resources.projectiles.register(createProjectileDefinition({
    id: "runtime-ammo-shell", initialize: () => ({}),
    acceptsContact: (_context, unit) => unit.allegiance?.side === "ENEMY",
    contact: (context) => {
      context.operations.damage({
        sourceUnitId: context.projectile.source, targetUnitId: context.targetUnitId,
        tick: context.tick, damageType: "TRUE", operands: createDamageOperands(context.projectile.cachedAtk),
      });
    },
  }));
  const base = createLegacyCombatSpec({ rows: 1, columns: 8, operators: [], enemies: [], maxTicks: 20, seed: 7 });
  const runtime = new BattleRuntime({ ...base,
    initialUnits: [{ definition, position: [0, 0] },
      ...Array.from({ length: targets }, (_, index) => ({ definition: receiver, position: [index + 3, 0] }))],
    schedule: { type: "TIMELINE", spawns: [{
      definition: { id: "future", vitality: { maxHp: 1 }, locomotion: {
        moveSpeedPerTick: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
      } }, tick: 19,
      route: { pathMotionMode: "WALK", startPosition: [0, 7], endPosition: [0, 7],
        spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [], allowDiagonalMove: false,
        visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true },
      timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true,
      notCountInTotal: false,
    }] },
  }, { combat: resources, compileAction: (action, services) => {
    const compiled = compileAction(action, services);
    return program === undefined ? compiled : { ...compiled, program: program(compiled, services, shell) };
  } });
  return runtime;
}

function source(runtime) {
  return runtime.snapshot().units.find(({ id }) => id === 0);
}

function damageEvents(step) {
  return step.events.filter(({ type }) => type === "DAMAGE");
}

function delayed(compiled) {
  return [
    { type: "EXECUTE", run: ({ work }) => ({ work }) },
    { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 2 }) },
    { type: "RELEASE", markerId: "attack" },
    ...compiled.program,
  ];
}

test("ammo runtime: the final EXECUTE buffs every target before ending the skill", () => {
  const runtime = scenario({ targets: 3 });
  const released = runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  assert.deepEqual(damageEvents(released).map(({ targetUnitId, amount }) => [targetUnitId, amount]), [
    [1, 200], [2, 200], [3, 200],
  ]);
  assert.deepEqual(released.events.filter(({ type }) => ["DAMAGE", "SKILL_FINISHED"].includes(type)).map(({ type }) => type), [
    "DAMAGE", "DAMAGE", "DAMAGE", "SKILL_FINISHED",
  ]);
  assert.equal(source(runtime).skill.active, null);
  assert.equal(source(runtime).effects.instances.every(({ finished, participating }) => finished && !participating), true);
  assert.equal(released.events.filter(({ type }) => type === "SKILL_FINISHED").length, 1);
});

test("ammo runtime: preparation and delayed RELEASE preserve ammunition until output finishes", () => {
  const runtime = scenario({ ammo: 3, program: delayed });
  const started = runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  assert.deepEqual(damageEvents(started), []);
  assert.equal(source(runtime).skill.active.remainingAmmo, 3);
  const waiting = runtime.step();
  assert.equal(waiting.events.some(({ type }) => type === "ACTION_RELEASED"), false);
  assert.equal(source(runtime).skill.active.remainingAmmo, 3);
  const released = runtime.step();
  assert.deepEqual(damageEvents(released).map(({ amount }) => amount), [200]);
  assert.equal(source(runtime).skill.active.remainingAmmo, 2);
});

test("ammo runtime: cancellation during windup spends no ammunition", () => {
  const runtime = scenario({ ammo: 3, program: delayed });
  runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  const executionId = runtime.snapshot().actionExecution.executions[0].id;
  const cancelled = runtime.step([{ type: "CANCEL_ACTION_EXECUTION", executionId }]);
  assert.deepEqual(cancelled.events.filter(({ type }) => type === "ACTION_CANCELLED").map(({ reason }) => reason), ["CANCELLED"]);
  assert.deepEqual(damageEvents(cancelled), []);
  assert.equal(source(runtime).skill.active.remainingAmmo, 3);
  assert.deepEqual(runtime.snapshot().actionExecution.executions, []);
  assert.equal(runtime.step().events.some(({ type }) => type === "ACTION_RELEASED"), false);
  assert.equal(source(runtime).skill.active.remainingAmmo, 3);
});

test("ammo runtime: release interruption cancels windup without spending ammunition", () => {
  const runtime = scenario({ ammo: 3, interrupt: true, program: delayed });
  runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  runtime.step();
  const interrupted = runtime.step();
  assert.deepEqual(interrupted.events.filter(({ type }) => type === "ACTION_CANCELLED").map(({ reason }) => reason), ["INTERRUPTED"]);
  assert.equal(interrupted.events.some(({ type }) => type === "ACTION_RELEASED"), false);
  assert.deepEqual(damageEvents(interrupted), []);
  assert.equal(source(runtime).skill.active.remainingAmmo, 3);
  assert.equal(source(runtime).action.recoveryUntilTick, 17);
  assert.deepEqual(runtime.snapshot().actionExecution.executions, []);
});

test("ammo runtime: explicit releases with multiple EXECUTEs consume once across a wait", () => {
  const runtime = scenario({ ammo: 3, targets: 2, program: (compiled) => [
    { type: "RELEASE", markerId: "first" },
    ...compiled.program,
    { type: "WAIT", resolve: () => ({ type: "FOR_TICKS", ticks: 1 }) },
    { type: "RELEASE", markerId: "follow-up" },
    ...compiled.program,
  ] });
  const first = runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  assert.deepEqual(damageEvents(first).map(({ amount }) => amount), [200, 200]);
  assert.equal(source(runtime).skill.active.remainingAmmo, 2);
  const followUp = runtime.step();
  assert.deepEqual(damageEvents(followUp).map(({ amount }) => amount), [200, 200]);
  assert.equal(source(runtime).skill.active.remainingAmmo, 2);
  assert.equal(followUp.events.filter(({ type }) => type === "ACTION_FINISHED").length, 1);
  assert.deepEqual(runtime.snapshot().actionExecution.executions, []);
});

test("ammo runtime: the last released projectile survives skill completion and retains buffed attack", () => {
  const runtime = scenario({ program: (_compiled, services, shell) => [
    { type: "RELEASE", markerId: "shell" },
    { type: "EXECUTE", run: (context) => {
      const actor = getUnit(context.work, context.sourceUnitId);
      const targetUnitId = context.bindings.get("main")[0];
      const target = getUnit(context.work, targetUnitId);
      context.projectiles.launch(shell.ref, {
        source: actor.id, traceTarget: targetUnitId, position: actor.position, destination: target.position,
        cachedAtk: resolveAttackPower(actor.id, battlefieldView(context.work), services.computations),
        speedPerTick: 1, contactRange: { type: "SHAPES", geometry: hit }, stopDelayTicks: 0,
      });

    } },
  ] });
  const launched = runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  assert.deepEqual(damageEvents(launched), []);
  assert.equal(launched.events.filter(({ type }) => type === "SKILL_FINISHED").length, 1);
  assert.equal(source(runtime).skill.active, null);
  assert.equal(source(runtime).effects.instances.every(({ finished, participating }) => finished && !participating), true);
  assert.equal(runtime.snapshot().projectiles.instances.length, 1);
  assert.equal(runtime.snapshot().projectiles.instances[0].cachedAtk, 200);
  assert.deepEqual(runtime.snapshot().projectiles.instances[0].position, [0, 0]);
  runtime.step();
  assert.equal(runtime.snapshot().projectiles.instances.length, 1);
  runtime.step();
  const contacted = runtime.step();
  assert.deepEqual(damageEvents(contacted).map(({ targetUnitId, amount }) => [targetUnitId, amount]), [[1, 200]]);
  assert.equal(runtime.snapshot().units.find(({ id }) => id === 1).vitality.hp, 9800);
  assert.deepEqual(runtime.snapshot().projectiles.instances, []);
});
