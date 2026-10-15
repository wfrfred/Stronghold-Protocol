import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { attackBuff } from "../helpers/effects.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { fixtureBattlefieldState as fixtureBattlefield } from "../helpers/battlefield.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { createLegacyCombatSpec } from '../../dist/legacy/combat.js';
import { createDefinition } from '../../dist/core/tactical/unit/archetype/operator.js';
import { createDefinition as createSkillDefinition } from '../../dist/core/tactical/unit/capability/skill/capability.js';
import * as skills from '../../dist/core/tactical/unit/capability/skill/operations.js';
import { ref as activationRef } from '../../dist/core/tactical/unit/capability/skill/activation.js';
import { createShapeGeometry } from '../../dist/core/tactical/geometry/shape.js';
import { create as createAttack } from '../../dist/content/tactical/actions/attack.js';
import { Definitions } from '../../dist/core/tactical/unit/action/definitions.js';
import { initialize } from '../../dist/core/tactical/unit/initialize.js';
import { createBattleState, getUnit } from '../../dist/core/tactical/battle/state.js';
import { createDamageOperands } from '../../dist/core/tactical/unit/capability/vitality/damage/contract.js';
import { setDamageReceptionRule } from '../../dist/core/tactical/unit/capability/vitality/capability.js';
import { setHook } from '../../dist/core/tactical/unit/capability/vitality/damage/hook.js';
import { SKIPPED_DAMAGE_RECEPTION } from '../../dist/core/tactical/unit/capability/vitality/damage/contract.js';

const geometry = createShapeGeometry({ shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 5 }] });
const hit = createShapeGeometry({ shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 0.1 }] });
function action(maxTargets = 1, extra = {}) {
  return createAttack({
    id: 'normal', triggerBindingId: 'main', intervalTicks: 1, recoveryTicks: 0, followUps: [],
    targetGroups: [{ id: 'main', targeting: {
      type: 'DAMAGE', scope: { type: 'RANGE', geometry: { type: 'SHAPES', geometry } },
      canTargetAir: true, includeBlockingRelations: false, preferBlockingRelations: false,
      ignoreTargetFree: false, ignoreInvisible: false, maxTargets,
    }, operations: [{ type: 'DAMAGE', power: 1, damageType: 'TRUE', powerSource: 'SOURCE_ATTACK' }] }],
    ...extra,
  });
}
function actor(skill, { attackTargets = 1, windupTicks = 0, activeAction } = {}) {
  let definitions = Definitions.empty().add(action(attackTargets, { windupTicks }));
  if (activeAction !== undefined) definitions = definitions.add(action(2, { id: activeAction, windupTicks }));
  return createDefinition({
    id: 'skill-actor', vitality: { maxHp: 100000 }, offense: { attack: 100 },
    defense: { defense: 0, resistance: 0 }, allegiance: { side: 'ALLY' },
    spatial: { layer: 'GROUND' }, hit: { geometry: hit },
    blocker: { capacity: 0, geometry: { radius: 0.1 } }, action: { definitions, select: (battle, self) => ({ state: battle, value: [self.skill.active !== null ? activeAction ?? 'normal' : 'normal'] }) }, skill,
  });
}
function target() {
  return { id: 'target', vitality: { maxHp: 100000 }, defense: { defense: 0, resistance: 0 },
    allegiance: { side: 'ENEMY' }, spatial: { layer: 'GROUND' }, hit: { geometry: hit } };
}
function scenario(skill, { targets = 1, attackTargets = 1, windupTicks = 0, content, activeAction } = {}) {
  const buff = attackBuff('skill/attack', 100);
  const fault = { enabled: false };
  skill = createSkillDefinition({ ...skill, activation: { ...skill.activation,
    onStart: content ?? ((state, self) => {
      const installed = effects.install(state, self.host, buff, {
        source: self.host.id, scopes: [{ type: 'SKILL', ref: activationRef(self) }],
      });
      if (fault.enabled) throw new Error('skill fault');
      assert.ok(installed.value);
      return installed.state;
    }),
  } });
  const base = createLegacyCombatSpec({ rows: 1, columns: 8, operators: [], enemies: [], maxTicks: 200, seed: 7 });
  const definition = actor(skill, { attackTargets, windupTicks, activeAction });
  const runtime = new BattleRuntime({ ...base,
    initialUnits: [{ definition, position: [0, 0] },
      ...Array.from({ length: targets }, (_, index) => ({ definition: target(), position: [index + 1, 0] }))],
    schedule: { type: 'TIMELINE', spawns: [{
      definition: { id: 'future', vitality: { maxHp: 1 }, locomotion: {
        moveSpeedPerTick: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
      } }, tick: 199,
      route: { pathMotionMode: 'WALK', startPosition: [0, 7], endPosition: [0, 7],
        spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [], allowDiagonalMove: false,
        visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true },
      timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true,
      notCountInTotal: false,
    }] },
  });
  return { runtime, fault };
}
function skill({ trigger = 'MANUAL', recovery = { type: 'TIME', intervalTicks: 30 }, initial = 2, cost = 2, durationTicks = 3 } = {}) {
  return createSkillDefinition({ id: 'test-skill', initialize: () => ({}),
    sp: { initial, capacity: cost, requirement: cost, cost, recovery },
    activation: { trigger, sustain: { type: 'TIME', durationTicks }, initialize: () => ({}) },
  });
}
function source(runtime) { return runtime.snapshot().units.find(({ id }) => id === 0); }

test('skill runtime: manual buff affects current attacks, locks SP and restores facts at duration end', () => {
  const { runtime } = scenario(skill());
  const first = runtime.step([{ type: 'ACTIVATE_SKILL', unitId: 0 }]);
  assert.equal(first.events.find(({ type }) => type === 'DAMAGE').amount, 200);
  assert.equal(first.events.filter(({ type }) => type === 'SKILL_ACTIVATED').length, 1);
  assert.equal(source(runtime).skill.sp.value, 0);
  runtime.step([{ type: 'ACTIVATE_SKILL', unitId: 0 }]);
  runtime.step();
  const ended = runtime.step();
  assert.equal(ended.events.find(({ type }) => type === 'DAMAGE').amount, 100);
  assert.equal(ended.events.filter(({ type }) => type === 'SKILL_FINISHED').length, 1);
  assert.equal(source(runtime).skill.active, null);
  assert.equal(source(runtime).skill.sp.value, 0);
});

test('skill runtime: TIME gives integer pulses and AUTO starts at full SP', () => {
  const { runtime } = scenario(skill({ trigger: 'AUTO', initial: 0 }));
  const activations = [];
  for (let tick = 0; tick <= 60; tick++) {
    activations.push(...runtime.step().events.filter(({ type }) => type === 'SKILL_ACTIVATED'));
    if (tick === 29) { assert.equal(source(runtime).skill.sp.value, 0); }
    if (tick === 30) { assert.equal(source(runtime).skill.sp.value, 1); }
  }
  assert.deepEqual(activations.map(({ tick }) => tick), [60]);
  assert.equal(source(runtime).skill.sp.value, 0);
});

test('skill runtime: active action is selected from current facts and returns to normal targeting', () => {
  const { runtime } = scenario(skill(), { targets: 2, activeAction: 'active' });
  assert.equal(runtime.step([{ type: 'ACTIVATE_SKILL', unitId: 0 }]).events.filter(({ type }) => type === 'DAMAGE').length, 2);
  runtime.step(); runtime.step();
  assert.equal(runtime.step().events.filter(({ type }) => type === 'DAMAGE').length, 1);
});

test('skill runtime: ACTION recovery counts a multi-target release once', () => {
  const definition = skill({ recovery: { type: 'ACTION', amount: 1 }, initial: 0, cost: 10 });
  const { runtime } = scenario(definition, { targets: 2, attackTargets: 2, windupTicks: 2 });
  runtime.step();
  assert.equal(source(runtime).skill.sp.value, 0);
  runtime.step();
  assert.equal(source(runtime).skill.sp.value, 0);
  runtime.step();
  assert.equal(source(runtime).skill.sp.value, 1);
});

test('skill runtime: cancelled windup earns no ACTION SP', () => {
  const { runtime } = scenario(skill({ recovery: { type: 'ACTION', amount: 1 }, initial: 0 }), { windupTicks: 2 });
  runtime.step();
  runtime.step([{ type: 'CANCEL_ACTION_EXECUTION', executionId: 0 }]);
  assert.equal(source(runtime).skill.sp.value, 0);
});

test('skill runtime: HIT SP counts zero damage but respects cancellation and ignoreForSp', () => {
  for (const [cancelReception, ignoreForSp, expected] of [[false, false, 1], [false, true, 0], [true, false, 0]]) {
    const definition = actor(skill({ recovery: { type: 'HIT', amount: 1 }, initial: 0 }));
    let receiver = initialize({ id: 0, definition, position: [0, 0] });
    if (cancelReception) receiver = { ...receiver, vitality: setDamageReceptionRule(receiver.vitality, {
      id: 'test-cancel-reception', cancel: () => ({ stage: 'RECEPTION', reason: 'INVINCIBLE' }),
    }) };
    let work = createBattleState(fixtureBattlefield({ unitIds: [0], getUnit: () => receiver, blockerOf: () => undefined, blockedBy: () => [] }));
    work = skills.enter(work, unitRef(receiver));
    work = resolveDamage(work, { sourceUnitId: null, targetUnitId: 0,
      damageType: 'TRUE', operands: createDamageOperands(0), tick: 0, ignoreForSp }).state;
    assert.equal(getUnit(work, 0).skill.sp.value, expected);
    assert.equal(getUnit(work, 0).vitality.hp, 100000);
  }
});

test('skill runtime: failed activation propagates without publishing contribution or progress', () => {
  const { runtime, fault } = scenario(skill());
  const before = runtime.snapshot();
  fault.enabled = true;
  assert.throws(() => runtime.step([{ type: 'ACTIVATE_SKILL', unitId: 0 }]), /skill fault/);
  assert.deepEqual(runtime.snapshot(), before);
});

test('skill runtime: HIT recovery precedes reception Hooks even when they subsequently cancel damage', () => {
  const definition = actor(skill({ recovery: { type: 'HIT', amount: 2 }, initial: 0, cost: 10 }));
  let receiver = initialize({ id: 0, definition, position: [0, 0] });
  receiver = { ...receiver, vitality: setHook(receiver.vitality, {
    id: 'late-shield', stage: 'reception', priority: 0, enabled: () => true,
    invoke(battle, context, pending) {
      assert.equal(getUnit(battle, context.unit.id).skill.sp.value, 2);
      return { state: battle, value: { value: { ...pending, cancellation: { stage: 'RECEPTION', reason: 'SHIELD' } } } };
    },
  }) };
  let battle = createBattleState(fixtureBattlefield([receiver]));
  battle = skills.enter(battle, unitRef(receiver));
  battle = resolveDamage(battle, { sourceUnitId: null, targetUnitId: 0, damageType: 'TRUE', operands: createDamageOperands(10), tick: 0 }).state;
  assert.equal(getUnit(battle, 0).skill.sp.value, 2);
  assert.equal(getUnit(battle, 0).vitality.hp, 100000);
});

test('skill runtime: skipping modifier events still reaches the HIT recovery extension point', () => {
  const receiver = initialize({ id: 0, position: [0, 0], definition: actor(skill({ recovery: { type: 'HIT', amount: 2 }, initial: 0, cost: 10 })) });
  let battle = createBattleState(fixtureBattlefield([receiver]));
  battle = skills.enter(battle, unitRef(receiver));
  battle = resolveDamage(battle, { sourceUnitId: null, targetUnitId: 0, damageType: 'TRUE',
    operands: createDamageOperands(0), tick: 0, receptionPolicy: SKIPPED_DAMAGE_RECEPTION }).state;
  assert.equal(getUnit(battle, 0).skill.sp.value, 2);
});
