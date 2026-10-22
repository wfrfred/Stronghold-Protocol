import { damage as damageTargeting, healing as healingTargeting } from "../helpers/targeting.js";
import { damage as dealDamage, parameters } from "../helpers/vitality.js";
import { create as createProjectile } from "../../dist/core/tactical/battlefield/projectile/operations.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { transitionUnit } from "../../dist/core/tactical/battle/state.js";
import { setBeforeReleaseHook, removeBeforeReleaseHook } from "../../dist/core/tactical/unit/capability/action/capability.js";
import { attackBuff } from "../helpers/effects.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import * as tracking from "../../dist/content/tactical/projectiles/tracking.js";

import { create as createAttack } from "../../dist/content/tactical/actions/skill.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import { ref as actionRef } from "../../dist/core/tactical/unit/action/action.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { resolveAttack } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { createDefinition as createSkillDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { ref as activationRef } from "../../dist/core/tactical/unit/capability/skill/activation.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";
import { setHook, removeHook } from "../../dist/core/tactical/battle/damage/hook.js";
import { unit as fixtureUnit, battle as fixtureBattle, actionDefinition } from "../helpers/action-fixture.js";
import { definition as skillDefinition } from "../helpers/skill.js";
import { activate } from "../../dist/core/tactical/unit/capability/skill/operations.js";

const hit = { type: "CIRCLE", offset: [0, 0], radius: 0.1 };
const range = [{ type: "CIRCLE", offset: [0, 0], radius: 8 }];

function scenario({ ammo = 1, targets = 1, interrupt = false, windupTicks = 0, output, actionProgram, hideAfterDamage = false } = {}) {
  const buff = attackBuff("runtime-ammo-attack", 100, {
    onInstall: (state, context) => {
      if (hideAfterDamage) state = transitionUnit(state, context.unit.id, current => ({
        ...current, vitality: setHook(current.vitality, {
          id: "hide-after-damage", stage: "hpApplied", priority: 0,
          accepts: (_state, event) => event.request.source?.id === context.unit.id,
          invoke: (state, context, current) => {
            assert.equal(context.application.hpLoss, 200);
            return { state: transitionUnit(state, context.request.source.id, current => ({
              ...current, spatialPresence: { present: false },
            })), value: current };
          },
        }),
      }));
      if (interrupt) state = transitionUnit(state, context.unit.id, current => ({ ...current, action: setBeforeReleaseHook(current.action, {
        id: "ammo-interrupt", accepts: () => true,
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
    targetGroups: [{ id: "main", targeting: damageTargeting({
      type: "DAMAGE", scope: { type: "RANGE", geometry: range },
      canTargetAir: true, includeBlockingRelations: false, preferBlockingRelations: false,
      ignoreTargetFree: false, ignoreInvisible: false, maxTargets: targets,
    }), operations: [{ type: "DAMAGE", power: 1, damageType: "TRUE", powerSource: "SOURCE_ATTACK" }] }],
    ...(output === undefined ? {} : { output: (state, self) => output(state, self, shell) }),
  });
  const action = actionProgram === undefined ? normal : actionProgram(normal);
  const definition = {
    id: "ammo-actor", spatialPresence: {}, vitality: { maxHp: 10000, defense: 0, resistance: 0 }, offense: { attack: 100 },
    allegiance: { side: "ALLY" },
    layer: { type: "GROUND" }, hitbox: { shape: hit },
    blocker: { capacity: 0, geometry: { radius: 0.1 } }, skill,
    action: { definitions: Definitions.empty().add(action) },
  };
  const receiver = {
    id: "ammo-target", targetable: { restrictions: [] }, vitality: { maxHp: 10000, defense: 0, resistance: 0 }, allegiance: { side: "ENEMY" }, layer: { type: "GROUND" }, hitbox: { shape: hit },
  };
  const shell = {
    id: "runtime-ammo-shell", tracking: true,
    onAdvance: (state, self) => tracking.advance(state, self, (state, self) =>
      tracking.hit(state, self, (state, self, target) =>
        dealDamage(state, { source: self.state.source, target: unitRef(target),
          parameters: parameters(self.state.cachedAtk, "TRUE") }).state)),
    onTerminate: (state, self, reason) => reason === "DISPEL" ? state :
      tracking.hit(state, self, (state, self, target) =>
        dealDamage(state, { source: self.state.source, target: unitRef(target),
          parameters: parameters(self.state.cachedAtk, "TRUE") }).state),
  };
  const base = createLegacyCombatSpec({ rows: 1, columns: 8, operators: [], enemies: [], maxTicks: 20, seed: 7 });
  const runtime = new BattleRuntime({ ...base,
    initialUnits: [{ definition, position: [0, 0] },
      ...Array.from({ length: targets }, (_, index) => ({ definition: receiver, position: [index + 3, 0] }))],
    schedule: { type: "TIMELINE", spawns: [{
      definition: { id: "future", vitality: { maxHp: 1, defense: 0, resistance: 0 }, locomotion: {
        halfBodyWidth: 0, minSpeed: 0, speed: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
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

test("skill attack snapshots its output callback and ammunition cost when created", () => {
  const trace = [];
  const configuration = {
    ...actionDefinition(7).attack,
    afterOutput(state) { trace.push("original"); return state; },
    ammoPerAction: 1,
  };
  const attack = createAttack(configuration);
  const skill = skillDefinition({
    activation: { trigger: "MANUAL", sustain: { type: "AMMO", amount: 3 }, initialize: () => ({}) },
  });
  const actor = fixtureUnit(0, { action: attack, skill });
  let state = fixtureBattle(actor, fixtureUnit(1));
  state = activate(state, unitRef(actor)).state;
  configuration.afterOutput = current => { trace.push("replacement"); return current; };
  configuration.ammoPerAction = 3;
  state = actions.start(state, unitRef(actor), attack).state;
  assert.deepEqual(trace, ["original"]);
  assert.equal(getUnit(state, 1).vitality.hp, 93);
  assert.equal(getUnit(state, 0).skill.active.sustain.remaining, 2);
});


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
  assert.equal(source(runtime).effects.values().toArray().length === 0, true);
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
  assert.equal(source(runtime).effects.values().toArray().length, 0);
  assert.deepEqual(emitted.events.filter(({ type }) => type === "SKILL_FINISHED").map(({ activationId }) => activationId), [0]);
  assert.equal(emitted.events.some(({ type }) => type === "ACTION_CANCELLED"), false);
});

test("ammo runtime: cancellation during windup spends no ammunition", () => {
  const runtime = scenario({ ammo: 3, windupTicks: 2 });
  runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  const ref = actionRef(runtime.snapshot().units.find(unit => unit.id === 0).action.instances.values().toArray()[0]);
  const cancelled = runtime.step([{ type: "CANCEL_ACTION_EXECUTION", ref }]);
  assert.deepEqual(cancelled.events.filter(({ type }) => type === "ACTION_CANCELLED").map(({ reason }) => reason), ["CANCELLED"]);
  assert.deepEqual(damageEvents(cancelled), []);
  assert.equal(source(runtime).skill.active.sustain.remaining, 3);
  assert.deepEqual(runtime.snapshot().units.find(unit => unit.id === 0).action.instances.values().toArray(), []);
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
  assert.ok(source(runtime).action.states.get("normal").cooldown.readyAtTick >= 17);
  assert.deepEqual(runtime.snapshot().units.find(unit => unit.id === 0).action.instances.values().toArray(), []);
});

test("ammo runtime: a content-defined follow-up preserves one ammunition payment across ticks", () => {
  const runtime = scenario({ ammo: 3, targets: 2, actionProgram: (normal) => ({
    ...normal,
    start(state, source, persistent) {
      const initialized = normal.start(state, source, persistent);
      return { state: initialized.state, value: initialized.value === null ? null : { ...initialized.value, finishAtTick: state.tick + 1, emitted: 0 } };
    },
    step(state, self) {
      if (self.state.emitted === 0) {
        state = normal.step(state, self).state;
        const current = actions.get(state, actionRef(self));
        if (current === undefined) return { state, value: true };
        return { state: actions.update(state, actionRef(current), currentState => ({ ...currentState, emitted: 1 })), value: false };
      }
      for (const target of self.state.bindings.main) {
        state = dealDamage(state, { source: { id: self.host.id }, target: { id: target.id }, parameters: parameters(resolveAttack(state, self.host), "TRUE") }).state;
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
  assert.deepEqual(runtime.snapshot().units.find(unit => unit.id === 0).action.instances.values().toArray(), []);
});

test("ammo runtime: the last released projectile survives skill completion and retains buffed attack", () => {
  const runtime = scenario({ output: (state, self, shell) => {
    const actor = getUnit(state, self.host.id);
    const targetUnitId = self.state.bindings.main[0].id;
    const target = getUnit(state, targetUnitId);
    return createProjectile(state, shell, {
      position: actor.position,
      state: {
        source: unitRef(actor), target: unitRef(target), destination: target.position,
        cachedAtk: resolveAttack(state, unitRef(actor)),
        speedPerTick: 1, stopDelayTicks: 0, stopAtTick: null,
        hitAttempted: false, launchedAtTick: state.tick,
      },
    }).state;
  } });
  const launched = runtime.step([{ type: "ACTIVATE_SKILL", unitId: 0 }]);
  assert.deepEqual(damageEvents(launched), []);
  assert.equal(launched.events.filter(({ type }) => type === "SKILL_FINISHED").length, 1);
  assert.equal(source(runtime).skill.active, null);
  assert.equal(source(runtime).effects.values().toArray().length === 0, true);
  assert.equal(runtime.snapshot().projectiles.instances.length, 1);
  assert.equal(runtime.snapshot().projectiles.instances[0].state.cachedAtk, 200);
  assert.deepEqual(runtime.snapshot().projectiles.instances[0].position, [0, 0]);
  runtime.step();
  assert.equal(runtime.snapshot().projectiles.instances.length, 1);
  runtime.step();
  const contacted = runtime.step();
  assert.deepEqual(damageEvents(contacted).map(({ targetUnitId, amount }) => [targetUnitId, amount]), [[1, 200]]);
  assert.equal(runtime.snapshot().units.find(({ id }) => id === 1).vitality.hp, 9800);
  assert.deepEqual(runtime.snapshot().projectiles.instances, []);
});
