import { launchProjectile } from "../../dist/core/tactical/battlefield/projectile/operations.js";
import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { transitionUnit } from "../../dist/core/tactical/battle/state.js";
import { setBeforeReleaseHook, removeBeforeReleaseHook } from "../../dist/core/tactical/unit/capability/action/capability.js";
import { attackBuff } from "../helpers/effects.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { battlefieldView, getUnit } from "../../dist/core/tactical/battle/state.js";
import { createDefinition as createProjectileDefinition } from "../../dist/core/tactical/battlefield/projectile/definition.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import { createDefinition } from "../../dist/core/tactical/unit/archetype/operator.js";
import { create as createAttack } from "../../dist/content/tactical/actions/attack.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import { ref as actionRef, setState } from "../../dist/core/tactical/unit/action/action.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { createDefinition as createSkillDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { ref as activationRef } from "../../dist/core/tactical/unit/capability/skill/activation.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";
import { setHook, removeHook } from "../../dist/core/tactical/unit/capability/vitality/damage/hook.js";

const hit = createShapeGeometry({
  shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.1 }],
});
const range = createShapeGeometry({
  shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 8 }],
});

function scenario({ ammo = 1, targets = 1, interrupt = false, windupTicks = 0, output, actionProgram, hideAfterDamage = false } = {}) {
  const buff = attackBuff("runtime-ammo-attack", 100, {
    onInstall: (state, context) => {
      if (hideAfterDamage) state = transitionUnit(state, context.unit.id, current => ({
        ...current, vitality: setHook(current.vitality, {
          id: "hide-after-damage", stage: "reaction", priority: 0,
          enabled: context => context.request.sourceUnitId === context.unit.id,
          invoke: (state, context, report) => {
            assert.equal(report.hpLoss, 200);
            return { state: transitionUnit(state, context.unit.id, current => ({
              ...current, spatialPresence: { present: false },
            })), value: undefined };
          },
        }),
      }));
      if (interrupt) state = transitionUnit(state, context.unit.id, current => ({ ...current, action: setBeforeReleaseHook(current.action, {
        id: "ammo-interrupt", enabled: () => true,
        invoke: state => ({ state, value: { type: "INTERRUPT", recoveryTicks: 15 } }),
      }) }));
      return state;
    },
    onEnd: (state, context) => {
      if (hideAfterDamage) state = transitionUnit(state, context.unit.id, current => ({
        ...current, vitality: removeHook(current.vitality, "hide-after-damage"),
      }));
      if (interrupt) state = transitionUnit(state, context.unit.id, current => ({ ...current, action: removeBeforeReleaseHook(current.action, "ammo-interrupt") }));
      return state;
    },
  });
  const skill = createSkillDefinition({
    id: "runtime-ammo-skill", initialize: () => ({}),
    sp: { initial: 1, capacity: 1, requirement: 1, recovery: { type: "TIME", intervalTicks: 30 } },
    activation: { trigger: "MANUAL", sustain: { type: "AMMO", amount: ammo }, initialize: () => ({}),
      onStart: (state, self) => {
        const installed = effects.install(state, self.host, buff, {
          source: self.host.id, scopes: [{ type: "SKILL", ref: activationRef(self) }],
        });
        assert.ok(installed.value);
        return installed.state;
      },
    },
  });
  const normal = createAttack({
    id: "normal", triggerBindingId: "main", intervalTicks: 100, windupTicks, ammoPerAction: 1,
    targetGroups: [{ id: "main", targeting: {
      type: "DAMAGE", scope: { type: "RANGE", geometry: { type: "SHAPES", geometry: range } },
      canTargetAir: true, includeBlockingRelations: false, preferBlockingRelations: false,
      ignoreTargetFree: false, ignoreInvisible: false, maxTargets: targets,
    }, operations: [{ type: "DAMAGE", power: 1, damageType: "TRUE", powerSource: "SOURCE_ATTACK" }] }],
    ...(output === undefined ? {} : { output: (state, self) => output(state, self, shell) }),
  });
  const action = actionProgram === undefined ? normal : actionProgram(normal);
  const definition = createDefinition({
    id: "ammo-actor", vitality: { maxHp: 10000 }, offense: { attack: 100 },
    defense: { defense: 0, resistance: 0 }, allegiance: { side: "ALLY" },
    spatial: { layer: "GROUND" }, hit: { geometry: hit },
    blocker: { capacity: 0, geometry: { radius: 0.1 } }, skill,
    action: { definitions: Definitions.empty().add(action) },
  });
  const receiver = {
    id: "ammo-target", vitality: { maxHp: 10000 }, defense: { defense: 0, resistance: 0 },
    allegiance: { side: "ENEMY" }, spatial: { layer: "GROUND" }, hit: { geometry: hit },
  };
  const shell = createProjectileDefinition({
    id: "runtime-ammo-shell", initialize: () => ({}),
    acceptsContact: (_context, unit) => unit.allegiance?.side === "ENEMY",
    contact: (state, context) => {
      return resolveDamage(state, {
        sourceUnitId: context.projectile.source, targetUnitId: context.targetUnitId,
        tick: context.tick, damageType: "TRUE", operands: createDamageOperands(context.projectile.cachedAtk),
      }, context.call).state;
    },
  });
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
  });
  return runtime;
}

function source(runtime) {
  return runtime.snapshot().units.find(({ id }) => id === 0);
}

function damageEvents(step) {
  return step.events.filter(({ type }) => type === "DAMAGE");
}


test("ammo runtime: the final ordinary attack buffs every target before ending the skill", () => {
  const runtime = scenario({ targets: 3 });
  const released = runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  assert.deepEqual(damageEvents(released).map(({ targetUnitId, amount }) => [targetUnitId, amount]), [
    [1, 200], [2, 200], [3, 200],
  ]);
  assert.deepEqual(released.events.filter(({ type }) => ["DAMAGE", "SKILL_FINISHED"].includes(type)).map(({ type }) => type), [
    "DAMAGE", "DAMAGE", "DAMAGE", "SKILL_FINISHED",
  ]);
  assert.equal(source(runtime).skill.active, null);
  assert.equal(source(runtime).effects.values().length === 0, true);
  assert.equal(released.events.filter(({ type }) => type === "SKILL_FINISHED").length, 1);
});

test("ammo runtime: preparation and delayed release preserve ammunition until output finishes", () => {
  const runtime = scenario({ ammo: 3, windupTicks: 2 });
  const started = runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  assert.deepEqual(damageEvents(started), []);
  assert.equal(source(runtime).skill.active.sustain.remaining, 3);
  const waiting = runtime.step();
  assert.equal(waiting.events.some(({ type }) => type === "ACTION_RELEASED"), false);
  assert.equal(source(runtime).skill.active.sustain.remaining, 3);
  const released = runtime.step();
  assert.deepEqual(damageEvents(released).map(({ amount }) => amount), [200]);
  assert.equal(source(runtime).skill.active.sustain.remaining, 2);
});

test("ammo runtime: hiding the source after damage still pays for the sampled activation", () => {
  const runtime = scenario({ hideAfterDamage: true });
  const emitted = runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);

  assert.deepEqual(damageEvents(emitted).map(({ amount }) => amount), [200]);
  assert.equal(source(runtime).spatialPresence.present, false);
  assert.equal(source(runtime).skill.active, null);
  assert.equal(source(runtime).effects.values().length, 0);
  assert.deepEqual(emitted.events.filter(({ type }) => type === "SKILL_FINISHED").map(({ activationId }) => activationId), [0]);
  assert.equal(emitted.events.some(({ type }) => type === "ACTION_CANCELLED"), false);
});

test("ammo runtime: cancellation during windup spends no ammunition", () => {
  const runtime = scenario({ ammo: 3, windupTicks: 2 });
  runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  const executionId = runtime.snapshot().actions.instances[0].id;
  const cancelled = runtime.step([{ type: "CANCEL_ACTION_EXECUTION", executionId }]);
  assert.deepEqual(cancelled.events.filter(({ type }) => type === "ACTION_CANCELLED").map(({ reason }) => reason), ["CANCELLED"]);
  assert.deepEqual(damageEvents(cancelled), []);
  assert.equal(source(runtime).skill.active.sustain.remaining, 3);
  assert.deepEqual(runtime.snapshot().actions.instances, []);
  assert.equal(runtime.step().events.some(({ type }) => type === "ACTION_RELEASED"), false);
  assert.equal(source(runtime).skill.active.sustain.remaining, 3);
});

test("ammo runtime: release interruption cancels windup without spending ammunition", () => {
  const runtime = scenario({ ammo: 3, interrupt: true, windupTicks: 2 });
  runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  runtime.step();
  const interrupted = runtime.step();
  assert.deepEqual(interrupted.events.filter(({ type }) => type === "ACTION_CANCELLED").map(({ reason }) => reason), ["INTERRUPTED"]);
  assert.equal(interrupted.events.some(({ type }) => type === "ACTION_RELEASED"), false);
  assert.deepEqual(damageEvents(interrupted), []);
  assert.equal(source(runtime).skill.active.sustain.remaining, 3);
  assert.ok(source(runtime).action.cooldowns.get("normal").readyAtTick >= 17);
  assert.deepEqual(runtime.snapshot().actions.instances, []);
});

test("ammo runtime: a content-defined follow-up preserves one ammunition payment across ticks", () => {
  const runtime = scenario({ ammo: 3, targets: 2, actionProgram: (normal) => ({
    ...normal,
    start(state, source) {
      const initialized = normal.start(state, source);
      return { state: initialized.state, value: initialized.value === null ? null : { ...initialized.value, finishAtTick: state.tick + 1, emitted: 0 } };
    },
    step(state, self) {
      if (self.state.emitted === 0) {
        state = normal.step(state, self).state;
        const current = actions.get(state, actionRef(self));
        if (current === undefined) return { state, value: true };
        return { state: actions.replace(state, setState(current, { ...current.state, emitted: 1 })), value: false };
      }
      for (const target of self.state.bindings.main) {
        state = resolveDamage(state, { sourceUnitId: self.source.id, targetUnitId: target.id,
          tick: state.tick, damageType: "TRUE", operands: createDamageOperands(resolveAttackPower(self.source.id, battlefieldView(state))) }).state;
      }
      return { state, value: true };
    },
  }) });
  const first = runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  assert.deepEqual(damageEvents(first).map(({ amount }) => amount), [200, 200]);
  assert.equal(source(runtime).skill.active.sustain.remaining, 2);
  const followUp = runtime.step();
  assert.deepEqual(damageEvents(followUp).map(({ amount }) => amount), [200, 200]);
  assert.equal(source(runtime).skill.active.sustain.remaining, 2);
  assert.equal(followUp.events.filter(({ type }) => type === "ACTION_FINISHED").length, 1);
  assert.deepEqual(runtime.snapshot().actions.instances, []);
});

test("ammo runtime: the last released projectile survives skill completion and retains buffed attack", () => {
  const runtime = scenario({ output: (state, self, shell) => {
    const actor = getUnit(state, self.source.id);
    const targetUnitId = self.state.bindings.main[0].id;
    const target = getUnit(state, targetUnitId);
    return launchProjectile(state, shell, {
      source: actor.id, traceTarget: targetUnitId, position: actor.position, destination: target.position,
      cachedAtk: resolveAttackPower(actor.id, battlefieldView(state)),
      speedPerTick: 1, contactRange: { type: "SHAPES", geometry: hit }, stopDelayTicks: 0,
    }, state.tick).state;
  } });
  const launched = runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  assert.deepEqual(damageEvents(launched), []);
  assert.equal(launched.events.filter(({ type }) => type === "SKILL_FINISHED").length, 1);
  assert.equal(source(runtime).skill.active, null);
  assert.equal(source(runtime).effects.values().length === 0, true);
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
