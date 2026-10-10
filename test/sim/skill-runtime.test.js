import { fixtureBattlefield } from "../helpers/battlefield.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { createLegacyCombatSpec } from '../../dist/legacy/combat.js';
import { createOperatorDefinition } from '../../dist/core/tactical/unit/archetype/operator.js';
import { createSkillDefinition } from '../../dist/core/tactical/unit/capability/skill/capability.js';
import { createEffectDefinition } from '../../dist/core/tactical/unit/capability/effects/definition.js';
import { create as modifier } from '../../dist/core/tactical/contribution/value.js';
import { attack } from '../../dist/core/tactical/unit/capability/offense/contributions.js';
import { createShapeGeometry } from '../../dist/core/tactical/geometry/shape.js';
import { compileAction } from '../../dist/core/tactical/unit/capability/action/compile.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { createBattleState, getUnit } from '../../dist/core/tactical/battle/execution/context.js';
import { createDamageOperands } from '../../dist/core/tactical/unit/capability/vitality/damage/contract.js';

const geometry = createShapeGeometry({ shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 5 }] });
const hit = createShapeGeometry({ shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 0.1 }] });
function action(maxTargets = 1) {
  return {
    triggerBindingId: 'main', baseAttackTimeTicks: 1, recoveryTicks: 0, followUps: [],
    targetGroups: [{ id: 'main', targeting: {
      type: 'DAMAGE', scope: { type: 'RANGE', geometry: { type: 'SHAPES', geometry } },
      canTargetAir: true, includeBlockingRelations: false, preferBlockingRelations: false,
      ignoreTargetFree: false, ignoreInvisible: false, maxTargets,
    }, operations: [{ type: 'DAMAGE', power: 1, damageType: 'TRUE', powerSource: 'SOURCE_ATTACK' }] }],
  };
}
function actor(skill) {
  return createOperatorDefinition({
    id: 'skill-actor', vitality: { maxHp: 100000 }, offense: { attack: 100 },
    defense: { defense: 0, resistance: 0 }, allegiance: { side: 'ALLY' },
    spatial: { layer: 'GROUND' }, hit: { geometry: hit }, status: { initialFlags: [] },
    blocker: { capacity: 0, geometry: { radius: 0.1 } }, action: { normalAction: action() }, skill,
  });
}
function target() {
  return { id: 'target', vitality: { maxHp: 100000 }, defense: { defense: 0, resistance: 0 },
    allegiance: { side: 'ENEMY' }, spatial: { layer: 'GROUND' }, hit: { geometry: hit },
    status: { initialFlags: [] } };
}
function scenario(skill, { targets = 1, content, compile } = {}) {
  const resources = new CombatResources();
  const buff = resources.registerEffect(createEffectDefinition({
    id: 'skill/attack', initialize: () => ({}),
  }), { contributions: [attack(() => [modifier({ multiplier: 1 })])] });
  const fault = { enabled: false };
  resources.skills.register({ definition: skill, activate: content ?? ((context) => {
    const installed = context.effects.install(context.unitId, buff.ref, {
      source: context.unitId, scopes: [{ type: 'SKILL', unitId: context.unitId, activationId: context.activationId }],
    });
    if (fault.enabled) { throw new Error('skill fault'); }
    assert.equal(installed.type, 'INSTALLED');
    return { type: 'ACTIVATED' };
  }) });
  const base = createLegacyCombatSpec({ rows: 1, columns: 8, operators: [], enemies: [], maxTicks: 200, seed: 7 });
  const definition = actor(skill);
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
  }, { combat: resources, ...(compile === undefined ? {} : { compileAction: compile }) });
  return { runtime, resources, fault };
}
function skill(overrides = {}) {
  return createSkillDefinition({ id: 'test-skill', activation: 'MANUAL', spRecovery: 'TIME',
    spCost: 2, initialSp: 2, durationTicks: 3, ...overrides });
}
function source(runtime) { return runtime.snapshot().units.find(({ id }) => id === 0); }

test('skill runtime: manual buff affects current attacks, locks SP and restores facts at duration end', () => {
  const { runtime } = scenario(skill());
  const first = runtime.step([{ type: 'ACTIVATE_SKILL', unitId: 0 }]);
  assert.equal(first.events.find(({ type }) => type === 'DAMAGE').amount, 200);
  assert.equal(first.events.filter(({ type }) => type === 'SKILL_ACTIVATED').length, 1);
  assert.equal(source(runtime).skill.sp, 0);
  runtime.step([{ type: 'ACTIVATE_SKILL', unitId: 0 }]);
  runtime.step();
  const ended = runtime.step();
  assert.equal(ended.events.find(({ type }) => type === 'DAMAGE').amount, 100);
  assert.equal(ended.events.filter(({ type }) => type === 'SKILL_FINISHED').length, 1);
  assert.equal(source(runtime).skill.active, null);
  assert.equal(source(runtime).skill.sp, 0);
});

test('skill runtime: TIME gives integer pulses and AUTO starts at full SP', () => {
  const { runtime } = scenario(skill({ activation: 'AUTO', initialSp: 0 }));
  const activations = [];
  for (let tick = 0; tick <= 60; tick++) {
    activations.push(...runtime.step().events.filter(({ type }) => type === 'SKILL_ACTIVATED'));
    if (tick === 29) { assert.equal(source(runtime).skill.sp, 0); }
    if (tick === 30) { assert.equal(source(runtime).skill.sp, 1); }
  }
  assert.deepEqual(activations.map(({ tick }) => tick), [60]);
  assert.equal(source(runtime).skill.sp, 0);
});

test('skill runtime: active action is selected from current facts and returns to normal targeting', () => {
  const { runtime } = scenario(skill({ activeAction: action(2) }), { targets: 2 });
  assert.equal(runtime.step([{ type: 'ACTIVATE_SKILL', unitId: 0 }]).events.filter(({ type }) => type === 'DAMAGE').length, 2);
  runtime.step(); runtime.step();
  assert.equal(runtime.step().events.filter(({ type }) => type === 'DAMAGE').length, 1);
});

test('skill runtime: ATTACK recovery counts a multi-target release once, before projectile contact', () => {
  const definition = skill({ spRecovery: 'ATTACK', initialSp: 0, spCost: 10 });
  const { runtime } = scenario(definition, { targets: 2, compile: (definition, resources) => ({
    ...compileAction(definition, resources), program: [
      { type: 'WAIT', resolve: () => ({ type: 'FOR_TICKS', ticks: 2 }) },
      { type: 'RELEASE', markerId: 'attack' },
      ...compileAction(definition, resources).program,
    ],
  }) });
  runtime.step();
  assert.equal(source(runtime).skill.sp, 0);
  runtime.step();
  assert.equal(source(runtime).skill.sp, 0);
  runtime.step();
  assert.equal(source(runtime).skill.sp, 1);
});

test('skill runtime: cancelled windup earns no ATTACK SP', () => {
  const { runtime } = scenario(skill({ spRecovery: 'ATTACK', initialSp: 0 }), {
    compile: (definition, resources) => ({ ...compileAction(definition, resources), program: [
      { type: 'WAIT', resolve: () => ({ type: 'FOR_TICKS', ticks: 2 }) },
      { type: 'RELEASE', markerId: 'attack' }, ...compileAction(definition, resources).program,
    ] }),
  });
  runtime.step();
  runtime.step([{ type: 'CANCEL_ACTION_EXECUTION', executionId: 0 }]);
  assert.equal(source(runtime).skill.sp, 0);
});

test('skill runtime: HIT SP counts zero damage but respects cancellation and ignoreForSp', () => {
  for (const [flags, ignoreForSp, expected] of [[[], false, 1], [[], true, 0], [['INVINCIBLE'], false, 0]]) {
    const resources = new CombatResources();
    const definition = actor(skill({ spRecovery: 'HIT', initialSp: 0 }));
    const receiver = initializeUnit({ id: 0, definition: { ...definition, status: { initialFlags: flags } }, position: [0, 0] });
    const work = createBattleState(fixtureBattlefield({ unitIds: [0], getUnit: () => receiver, blockerOf: () => undefined, blockedBy: () => [] }));
    resources.settleDamage(work, { sourceUnitId: null, targetUnitId: 0,
      damageType: 'TRUE', operands: createDamageOperands(0), tick: 0, ignoreForSp });
    assert.equal(getUnit(work, 0).skill.sp, expected);
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
