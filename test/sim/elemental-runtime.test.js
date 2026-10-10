import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { createLegacyCombatSpec } from '../../dist/legacy/combat.js';
import { createBattleState, battlefieldView, getUnit } from '../../dist/core/tactical/battle/execution/context.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { createShapeGeometry } from '../../dist/core/tactical/geometry/shape.js';
import { createActionDefinition } from '../../dist/core/tactical/unit/capability/action/capability.js';
import { compileAction } from '../../dist/core/tactical/unit/capability/action/compile.js';
import { createRouteDefinition } from '../../dist/core/tactical/unit/capability/locomotion/route/definition.js';
import { createEffectDefinition } from '../../dist/core/tactical/unit/capability/effects/definition.js';
import { installNewEffect, expireEffects, finalizeFinishedEffects } from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { createSkillDefinition } from '../../dist/core/tactical/unit/capability/skill/capability.js';
import { activateSkill, advanceSkill } from '../../dist/core/tactical/unit/capability/skill/execution.js';
import { gainUnitSkillSp } from '../../dist/core/tactical/battle/execution/skill-sp.js';
import { hasStatusFlag } from '../../dist/core/tactical/unit/capability/status/capability.js';
import { resolveDefense } from '../../dist/core/tactical/unit/capability/defense/query.js';
import { resolveAttackPower } from '../../dist/core/tactical/unit/capability/offense/query.js';
import { attack } from '../../dist/core/tactical/unit/capability/offense/contributions.js';
import { create as modifier } from '../../dist/core/tactical/contribution/value.js';
import { calculateDamage, resolveDamage } from '../../dist/core/tactical/unit/capability/vitality/damage/settlement.js';
import { createDamageOperands } from '../../dist/core/tactical/unit/capability/vitality/damage/contract.js';
import { resolveHealing } from '../../dist/core/tactical/unit/capability/vitality/healing/settlement.js';
import { resolveElementDamage, resolveElementHeal, advanceElementalState } from '../../dist/core/tactical/unit/capability/elemental/execution.js';
import { elementValues } from '../../dist/core/tactical/unit/capability/elemental/capability.js';
import { createArknightsElementalDefinition } from '../../dist/data/arknights/elemental.js';
import { registerArknightsElementalBursts } from '../../dist/data/arknights/elemental-burst.js';
import { effectFixtureWork } from '../helpers/effects.js';

const range = createShapeGeometry({ shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 20 }] });
const hit = createShapeGeometry({ shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 0.1 }] });
function action(interval = 1) {
  return createActionDefinition({ triggerBindingId: 'primary', baseAttackTimeTicks: interval, recoveryTicks: 0,
    targetGroups: [{ id: 'primary', targeting: {
      type: 'DAMAGE', scope: { type: 'RANGE', geometry: { type: 'SHAPES', geometry: range } },
      canTargetAir: true, includeBlockingRelations: false, preferBlockingRelations: false,
      ignoreTargetFree: false, ignoreInvisible: false, maxTargets: 1,
    }, operations: [{ type: 'DAMAGE', power: 1, damageType: 'TRUE' }] }], followUps: [] });
}
function definition(receiver = 'CHARACTER', overrides = {}, elementOptions = {}) {
  return { id: `element-${receiver}`, vitality: { maxHp: 100000 },
    defense: { defense: 500, resistance: 50 }, offense: { attack: 100 },
    allegiance: { side: receiver === 'CHARACTER' ? 'ALLY' : 'ENEMY' },
    spatial: { layer: 'GROUND' }, hit: { geometry: hit }, status: { initialFlags: [] },
    action: { normalAction: action() },
    elemental: createArknightsElementalDefinition({ receiver, ...elementOptions }), ...overrides };
}
function unit(receiver = 'CHARACTER', overrides = {}, elementOptions = {}) {
  return initializeUnit({ id: 1, position: [1, 0], definition: definition(receiver, overrides, elementOptions) });
}
function resources() {
  const result = new CombatResources();
  registerArknightsElementalBursts(result);
  return result;
}
function element(work, type, supplied, tick = 0, power = 1000) {
  return resolveElementDamage(work, { type, power, sourceUnitId: 9, targetUnitId: 1, tick }, supplied);
}
function advance(work, tick, supplied) {
  advanceElementalState(work, 1, tick, supplied);
  expireEffects(work, tick, supplied);
  finalizeFinishedEffects(work, 1, supplied, tick);
}
function defense(work, supplied) {
  return resolveDefense(1, battlefieldView(work), supplied.computations);
}
function power(work, supplied) {
  return resolveAttackPower(1, battlefieldView(work), supplied.computations);
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`); }

test('elemental execution: standard immediate bursts apply class-specific damage after their defense changes and retain only EP origin', () => {
  for (const [receiver, type, expectedHpLoss, expectedDefense, expectedResistance] of [
    ['CHARACTER', 'NEURAL', 1000, 500, 50], ['CHARACTER', 'EROSION', 400, 400, 50],
    ['CHARACTER', 'BURN', 840, 500, 30], ['ENEMY', 'NEURAL', 6000, 500, 50],
    ['ENEMY', 'EROSION', 5000, 380, 50], ['ENEMY', 'BURN', 7000, 500, 30],
  ]) {
    const supplied = resources();
    const input = effectFixtureWork(unit(receiver));
    const result = element(input, type, supplied);
    assert.equal(result.outcome, 'BURST');
    assert.equal(result.burst.sourceUnitId, 9);
    assert.equal(getUnit(input, 1).vitality.hp, 100000 - expectedHpLoss);
    assert.deepEqual(defense(input, supplied), { defense: expectedDefense, resistance: expectedResistance });
    const hits = input.events.filter(event => event.type === 'DAMAGE');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sourceUnitId, null);
    assert.equal(hits[0].amount, expectedHpLoss);
    assert.equal(input.battlefield.snapshot("state").getUnit(1).vitality.hp, 100000);
    assert.deepEqual(getUnit(input, 1).elemental.ep, elementValues(0));
  }
});

test('elemental execution: erosion defense loss survives recovery and stacks on the next burst for both receiver classes', () => {
  for (const [receiver, duration, reduction, secondHpLoss] of [['CHARACTER', 300, 100, 500], ['ENEMY', 240, 120, 5000]]) {
    const supplied = resources();
    const firstState = effectFixtureWork(unit(receiver));
    element(firstState, 'EROSION', supplied);
    advance(firstState, duration, supplied);
    assert.equal(defense(firstState, supplied).defense, 500 - reduction);
    assert.equal(getUnit(firstState, 1).elemental.recovery, null);
    const recoveredHp = getUnit(firstState, 1).vitality.hp;
    element(firstState, 'EROSION', supplied, duration);
    assert.equal(defense(firstState, supplied).defense, 500 - 2 * reduction);
    assert.equal(recoveredHp - getUnit(firstState, 1).vitality.hp, secondHpLoss);
  }
});

test('elemental execution: burn resistance loss remains during recovery and expires at its deadline', () => {
  for (const receiver of ['CHARACTER', 'ENEMY']) {
    const supplied = resources();
    const broken = effectFixtureWork(unit(receiver));
    element(broken, 'BURN', supplied);
    advance(broken, 299, supplied);
    assert.equal(defense(broken, supplied).resistance, 30);
    advance(broken, 300, supplied);
    assert.equal(defense(broken, supplied).resistance, 50);
    assert.deepEqual(getUnit(broken, 1).elemental.ep, elementValues(1000));
  }
});

test('elemental execution: character necrosis settles fifteen magical pulses, drains SP and blocks recovery and activation until recovery ends', () => {
  const supplied = resources();
  const skill = createSkillDefinition({ id: 'necrosis-sp', activation: 'MANUAL', spRecovery: 'TIME', spCost: 30, initialSp: 20, durationTicks: 30 });
  supplied.skills.register({ definition: skill, activate: () => ({ type: 'ACTIVATED' }) });
  const work = effectFixtureWork(unit('CHARACTER', { skill }));
  element(work, 'NECROSIS', supplied);
  assert.equal(getUnit(work, 1).vitality.hp, 100000);
  assert.equal(activateSkill(work, { unitId: 1, tick: 0 }, supplied).result.type, 'REJECTED');
  gainUnitSkillSp(work, 1, 'TIME', 3);
  assert.equal(getUnit(work, 1).skill.sp, 20);
  advance(work, 30, supplied);
  assert.equal(getUnit(work, 1).vitality.hp, 99950);
  assert.equal(getUnit(work, 1).skill.sp, 19);
  advanceSkill(work, 1, 30, supplied);
  assert.equal(getUnit(work, 1).skill.sp, 19);
  advance(work, 450, supplied);
  assert.equal(getUnit(work, 1).vitality.hp, 99250);
  assert.equal(getUnit(work, 1).skill.sp, 5);
  assert.equal(work.events.filter(event => event.type === 'DAMAGE').length, 15);
  assert.equal(hasStatusFlag(getUnit(work, 1), 'SP_RECOVERY_BLOCKED'), false);
  gainUnitSkillSp(work, 1, 'TIME', 3);
  assert.equal(getUnit(work, 1).skill.sp, 8);
});

test('elemental execution: enemy necrosis damage is elemental and its attack reduction fades before full recovery', () => {
  const supplied = resources();
  const work = effectFixtureWork(unit('ENEMY'));
  element(work, 'NECROSIS', supplied);
  assert.equal(power(work, supplied), 50);
  advance(work, 150, supplied);
  near(power(work, supplied), 100 * (1 - 0.5 * 10 / 15));
  assert.equal(getUnit(work, 1).vitality.hp, 96000);
  advance(work, 300, supplied);
  near(power(work, supplied), 100 * (1 - 0.5 * 5 / 15));
  advance(work, 450, supplied);
  assert.equal(power(work, supplied), 100);
  assert.equal(getUnit(work, 1).vitality.hp, 88000);
  const damage = work.events.filter(event => event.type === 'DAMAGE');
  assert.equal(damage.length, 15);
  assert.equal(damage.every(event => event.amount === 800 && event.damageType === 'ELEMENTAL'), true);
});

test('elemental HP damage ignores physical defense, magic resistance, source attack contributions and EP resistance but has its own five percent floor', () => {
  for (const [damageResistance, expected] of [[0, 100], [50, 50], [100, 5], [1000, 5], [-50, 100]]) {
    const supplied = resources();
    const source = initializeUnit({ id: 0, position: [0, 0], definition: { id: 'element-source', offense: { attack: 10000 } } });
    const attackBuff = supplied.registerEffect(createEffectDefinition({ id: `source-attack-${damageResistance}`, initialize: () => ({}) }),
      { contributions: [attack(() => [modifier({ multiplier: 100 })])] });
    let input = effectFixtureWork(source, unit('ENEMY', { defense: { defense: 100000, resistance: 99 } }, { damageResistance, elementResistance: 100 }));
    installNewEffect(input, 0, attackBuff, { source: 0, scopes: [{ type: "UNIT", unitId: 0 }] }, supplied, 0);
    const result = resolveDamage(input, { sourceUnitId: 0, targetUnitId: 1, damageType: 'ELEMENTAL', operands: createDamageOperands(100), tick: 0 }, supplied);
    assert.equal(result.hpLoss, expected);
    assert.equal(result.formulaDamage, expected);
    assert.equal(calculateDamage(100, 'ELEMENTAL', { defense: 100000, resistance: 99 }, damageResistance), expected);
    assert.deepEqual(getUnit(input, 1).elemental.ep, elementValues(1000));
  }
});

test('elemental healing receives every EP bar independently from HP healing and refuses the shared burst lock', () => {
  const supplied = resources();
  let receiver = unit('CHARACTER', { status: { initialFlags: ['HEAL_FREE'] } });
  receiver = { ...receiver, vitality: { ...receiver.vitality, hp: 99000 } };
  const work = effectFixtureWork(receiver);
  element(work, 'BURN', supplied, 0, 200);
  element(work, 'NEURAL', supplied, 0, 80);
  const hp = resolveHealing(
    work,
    { sourceUnitId: null, targetUnitId: 1, power: 100, tick: 0 },
    supplied,
  );
  assert.equal(hp.amount, 0);
  const healed = resolveElementHeal(work, { power: 100, sourceUnitId: null, targetUnitId: 1, tick: 0 });
  assert.equal(healed.outcome, 'APPLIED');
  assert.equal(healed.amount, 180);
  assert.equal(getUnit(work, 1).vitality.hp, 99000);
  assert.deepEqual(getUnit(work, 1).elemental.ep, { NEURAL: 1000, EROSION: 1000, BURN: 900, NECROSIS: 1000 });
  const broken = work;
  element(broken, 'BURN', supplied);
  assert.deepEqual(resolveElementHeal(broken, { power: 1000, sourceUnitId: null, targetUnitId: 1, tick: 0 }), { amount: 0, outcome: 'REJECTED' });
  const immune = effectFixtureWork(unit('CHARACTER', {}, { immune: true }));
  assert.equal(resolveElementHeal(immune, { power: 100, sourceUnitId: null, targetUnitId: 1, tick: 0 }).outcome, 'REJECTED');
});

test('elemental compiled actions select EP receivers without Vitality and keep element healing independent from HEAL_FREE', () => {
  const supplied = resources();
  const healingAction = createActionDefinition({ triggerBindingId: 'primary', baseAttackTimeTicks: 30, recoveryTicks: 0,
    targetGroups: [{ id: 'primary', targeting: { type: 'HEAL', geometry: { type: 'SHAPES', geometry: range },
      includeSelf: false, ignoreAllyTargetFree: false, ignoreHealFree: false, maxTargets: 1 },
    operations: [{ type: 'ELEMENT_HEAL', power: 100 }] }], followUps: [] });
  const healer = initializeUnit({ id: 0, position: [0, 0], definition: definition('CHARACTER', { action: { normalAction: healingAction } }) });
  const { vitality: omitted, ...receiverDefinition } = definition('CHARACTER', { status: { initialFlags: ['HEAL_FREE'] } });
  let receiver = initializeUnit({ id: 1, position: [1, 0], definition: receiverDefinition });
  let work = effectFixtureWork(healer, receiver);
  element(work, 'BURN', supplied, 0, 200);
  const compiled = compileAction(healingAction, supplied);
  const bindings = compiled.bind({ source: healer, battlefield: battlefieldView(work) });
  assert.deepEqual(bindings.get('primary'), [1]);
  compiled.program[0].run({ work, sourceUnitId: 0, executionId: 0, acceptedAtTick: 0,
    inputTargetUnitId: 1, tick: 0, bindings, samples: {} });
  receiver = getUnit(work, 1);
  assert.equal('vitality' in receiver, false);
  assert.equal(receiver.elemental.ep.BURN, 900);
  assert.equal(work.events.filter(event => event.type === 'ELEMENT_HEAL').length, 1);

  const damageAction = createActionDefinition({ ...action(), targetGroups: [{ ...action().targetGroups[0],
    operations: [{ type: 'ELEMENT_DAMAGE', elementType: 'NEURAL', power: 100 }] }] });
  const hostileReceiver = { ...receiver, allegiance: { side: 'ENEMY' } };
  work = effectFixtureWork(healer, hostileReceiver);
  const damaging = compileAction(damageAction, supplied);
  const damageBindings = damaging.bind({ source: healer, battlefield: battlefieldView(work) });
  assert.deepEqual(damageBindings.get('primary'), [1]);
  damaging.program[0].run({ work, sourceUnitId: 0, executionId: 1, acceptedAtTick: 0,
    inputTargetUnitId: 1, tick: 0, bindings: damageBindings, samples: {} });
  assert.equal(getUnit(work, 1).elemental.ep.NEURAL, 900);
});

function route() {
  return createRouteDefinition({ pathMotionMode: 'WALK', startPosition: [0, 3], endPosition: [0, 7],
    spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [], allowDiagonalMove: false,
    visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true });
}
function spawn(definition, tick) {
  return { definition, route: route(), tick, timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true, notCountInTotal: false };
}
function battle(receiver, type, { moving = false, content, targetStates, prepare } = {}) {
  const supplied = resources();
  prepare?.(supplied);
  const caster = definition('CHARACTER', { id: 'caster', allegiance: { side: 'ALLY' }, action: { normalAction: action(10000) } });
  const victim = definition(receiver, { id: 'victim', allegiance: { side: 'ENEMY' },
    ...(moving ? { locomotion: { moveSpeedPerTick: 0.001, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } }, blockable: { weight: 1 } } : {}) });
  const base = createLegacyCombatSpec({ rows: 1, columns: 8, operators: [], enemies: [], maxTicks: 600, seed: 7 });
  const keepOpen = { id: 'future', vitality: { maxHp: 1 }, locomotion: { moveSpeedPerTick: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } } };
  const runtime = new BattleRuntime({ ...base,
    initialUnits: [{ definition: caster, position: [0, 0] }, ...(moving ? [] : [{ definition: victim, position: [1, 0], ...(targetStates === undefined ? {} : { states: targetStates(supplied, victim) }) }])],
    schedule: { type: 'TIMELINE', spawns: [...(moving ? [spawn(victim, 0)] : []), spawn(keepOpen, 599)] },
  }, { combat: supplied, compileAction: (selected, services) => {
    const compiled = compileAction(selected, services);
    if (selected === caster.action.normalAction) {
      return { ...compiled, program: [{ type: 'EXECUTE', run: context => {
        if (content === undefined) {
          resolveElementDamage(context.work, { type, power: 1000, sourceUnitId: context.sourceUnitId, targetUnitId: 1, tick: context.tick }, supplied);
        } else {
          content(context, supplied);
        }
      } }, ...compiled.program] };
    }
    return { ...compiled, program: [{ type: 'RELEASE', markerId: 'normal' }, ...compiled.program] };
  } });
  return { runtime, supplied };
}
function victim(runtime) { return runtime.snapshot().units.find(entry => entry.id === 1); }

test('elemental runtime: character neural stun prevents ordinary attacks and route movement until recovery ends', () => {
  const { runtime } = battle('CHARACTER', 'NEURAL', { moving: true });
  const first = runtime.step();
  assert.equal(first.events.filter(event => event.type === 'DAMAGE' && event.sourceUnitId === 1).length, 0);
  assert.equal(hasStatusFlag(victim(runtime), 'STUNNED'), true);
  const frozenPosition = [...victim(runtime).position];
  for (let tick = 1; tick < 300; tick++) {
    const step = runtime.step();
    assert.equal(step.events.some(event => event.type === 'DAMAGE' && event.sourceUnitId === 1), false);
    assert.deepEqual(victim(runtime).position, frozenPosition);
  }
  const restored = runtime.step();
  assert.equal(hasStatusFlag(victim(runtime), 'STUNNED'), false);
  assert.equal(restored.events.some(event => event.type === 'DAMAGE' && event.sourceUnitId === 1), true);
  assert.notDeepEqual(victim(runtime).position, frozenPosition);
});

test('elemental runtime: enemy neural paralysis consumes exactly three ordinary releases and then permits attacks', () => {
  const { runtime } = battle('ENEMY', 'NEURAL');
  const events = [];
  for (let tick = 0; tick <= 50; tick++) { events.push(...runtime.step().events); }
  const cancelled = events.filter(event => event.type === 'ACTION_CANCELLED' && event.sourceUnitId === 1 && event.reason === 'INTERRUPTED');
  assert.equal(cancelled.length, 3);
  const hits = events.filter(event => event.type === 'DAMAGE' && event.sourceUnitId === 1);
  assert.equal(hits.length > 0, true);
  assert.equal(hits[0].tick >= 45, true);
  assert.equal(cancelled.every(event => event.tick < hits[0].tick), true);
});

test('elemental runtime: nested burst damage failure publishes neither EP progress, HP, effects nor tick', () => {
  let faultRef;
  const { runtime } = battle('CHARACTER', 'BURN', {
    prepare: supplied => {
      faultRef = supplied.registerEffect(createEffectDefinition({ id: 'elemental-fault', initialize: () => ({}) }),
        { damage: { reception: { priority: 100, apply: () => { throw new Error('nested burst failed'); } } } });
    },
    targetStates: (supplied, selected) => {
      const target = initializeUnit({ id: 1, position: [1, 0], definition: selected });
      const installedState = effectFixtureWork(target);
      installNewEffect(installedState, 1, faultRef, { source: null, scopes: [{ type: "UNIT", unitId: 1 }] }, supplied, 0);
      return { effects: getUnit(installedState, 1).effects };
    },
  });
  const initial = runtime.snapshot();
  assert.throws(() => runtime.step(), /nested burst failed/);
  assert.deepEqual(runtime.snapshot(), initial);
});
