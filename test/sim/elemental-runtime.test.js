import { calculateDamage } from "../../dist/core/tactical/battle/damage/calculate.js";
import { damage as dealDamage, parameters } from "../helpers/vitality.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { setAttackContribution } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { setHook } from "../../dist/core/tactical/battle/damage/hook.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { createLegacyCombatSpec } from '../../dist/legacy/combat.js';
import { battlefieldView, getUnit, transitionUnit } from '../../dist/core/tactical/battle/state.js';
import { initialize, placement } from "../helpers/unit.js";
import { createShapeGeometry } from '../../dist/core/tactical/geometry/shape.js';
import { create as createAttack, chooseTargets } from '../../dist/content/tactical/actions/attack.js';
import { Definitions } from '../../dist/core/tactical/unit/action/definitions.js';
import { start } from '../../dist/core/tactical/unit/action/operations.js';
import { ref as unitRef } from '../../dist/core/tactical/unit/query.js';
import { createInput as createRouteDefinition } from '../../dist/core/tactical/battle/creation/route.js';
import { definition as createSkillDefinition } from '../helpers/skill.js';
import { activate as activateSkill, advance as advanceSkill } from '../../dist/core/tactical/unit/capability/skill/operations.js';
import { recover } from '../../dist/core/tactical/unit/capability/skill/sp.js';
import { setHook as setHealingHook } from '../../dist/core/tactical/battle/healing/hook.js';
import { resolveDefense } from '../../dist/core/tactical/unit/capability/vitality/capability.js';
import { resolveAttackPower } from '../../dist/core/tactical/unit/capability/offense/query.js';
import { create as modifier } from '../../dist/core/tactical/unit/contribution/attribute.js';
import { healing } from '../helpers/vitality.js';
import * as elemental from '../../dist/core/tactical/unit/capability/elemental/operations.js';
import { get as getBurst } from '../../dist/core/tactical/unit/capability/elemental/query.js';
import { elementValues, setRule, setContribution, setHook as setElementalHook } from '../../dist/core/tactical/unit/capability/elemental/capability.js';
import { createArknightsElementalDefinition } from '../../dist/data/arknights/elemental.js';
import { invincible } from '../../dist/content/tactical/effects/protection.js';
import { effectFixtureWork } from '../helpers/effects.js';

const range = createShapeGeometry({ shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 20 }] });
const hit = createShapeGeometry({ shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 0.1 }] });
function action(interval = 1) {
  return createAttack({ id: 'normal-attack', triggerBindingId: 'primary', intervalTicks: interval, recoveryTicks: 0,
    targetGroups: [{ id: 'primary', targeting: {
      type: 'DAMAGE', scope: { type: 'RANGE', geometry: { type: 'SHAPES', geometry: range } },
      canTargetAir: true, includeBlockingRelations: false, preferBlockingRelations: false,
      ignoreTargetFree: false, ignoreInvisible: false, maxTargets: 1,
    }, operations: [{ type: 'DAMAGE', power: 1, damageType: 'TRUE' }] }], followUps: [] });
}
function definition(receiver = 'CHARACTER', overrides = {}, elementOptions = {}) {
  return { id: `element-${receiver}`, targetable: {}, spatialPresence: {}, vitality: { maxHp: 100000, defense: 500, resistance: 50 },
    offense: { attack: 100 },
    allegiance: { side: receiver === 'CHARACTER' ? 'ALLY' : 'ENEMY' },
    spatial: { layer: 'GROUND' }, hit: { geometry: hit },
    action: { definitions: Definitions.empty().add(action()) },
    elemental: createArknightsElementalDefinition({ receiver, ...elementOptions }), ...overrides };
}
function unit(receiver = 'CHARACTER', overrides = {}, elementOptions = {}) {
  return initialize({ id: 1, position: [1, 0], definition: definition(receiver, overrides, elementOptions) });
}
function element(work, type, tick = work.tick, power = 1000) {
  return elemental.damage({ ...work, tick }, unitRef(getUnit(work, 1)), { type, power, source: { id: 9 } });
}
function advance(work, tick) {
  work = effects.advance({ ...work, tick });
  return elemental.advance(work, unitRef(getUnit(work, 1)));
}
function defense(work) {
  const unit = getUnit(work, 1);
  return resolveDefense(unit.vitality, unit.definition.vitality, { unit, battlefield: battlefieldView(work) });
}
function power(work) {
  return resolveAttackPower(1, battlefieldView(work));
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`); }

test('elemental execution: standard immediate bursts apply class-specific damage after their defense changes and retain only EP origin', () => {
  for (const [receiver, type, expectedHpLoss, expectedDefense, expectedResistance] of [
    ['CHARACTER', 'NEURAL', 1000, 500, 50], ['CHARACTER', 'EROSION', 400, 400, 50],
    ['CHARACTER', 'BURN', 840, 500, 30], ['ENEMY', 'NEURAL', 6000, 500, 50],
    ['ENEMY', 'EROSION', 5000, 380, 50], ['ENEMY', 'BURN', 7000, 500, 30],
  ]) {
    const original = effectFixtureWork(unit(receiver));
    const result = element(original, type);
    const input = result.state;
    assert.equal(result.value.type, 'APPLIED');
    assert.deepEqual(getBurst(result.state, result.value.burst).source, { id: 9 });
    assert.equal(getUnit(input, 1).vitality.hp, 100000 - expectedHpLoss);
    assert.deepEqual(defense(input), { defense: expectedDefense, resistance: expectedResistance });
    const hits = input.events.filter(event => event.type === 'DAMAGE');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sourceUnitId, null);
    assert.equal(hits[0].amount, expectedHpLoss);
    assert.equal(getUnit(original, 1).vitality.hp, 100000);
    assert.deepEqual(getUnit(input, 1).elemental.ep, elementValues(0));
  }
});

test('elemental execution: erosion defense loss survives recovery and stacks on the next burst for both receiver classes', () => {
  for (const [receiver, duration, reduction, secondHpLoss] of [['CHARACTER', 300, 100, 500], ['ENEMY', 240, 120, 5000]]) {
    let firstState = effectFixtureWork(unit(receiver));
    firstState = element(firstState, 'EROSION').state;
    firstState = advance(firstState, duration);
    assert.equal(defense(firstState).defense, 500 - reduction);
    assert.equal(getUnit(firstState, 1).elemental.burst, null);
    const recoveredHp = getUnit(firstState, 1).vitality.hp;
    firstState = element(firstState, 'EROSION', duration).state;
    assert.equal(defense(firstState).defense, 500 - 2 * reduction);
    assert.equal(recoveredHp - getUnit(firstState, 1).vitality.hp, secondHpLoss);
  }
});

test('elemental execution: repeated enemy neural bursts refresh the remaining three paralysis charges', () => {
  let work = element(effectFixtureWork(unit('ENEMY')), 'NEURAL').state;
  const original = getUnit(work, 1).effects.values().find(effect => effect.definition.id.endsWith('/paralysis'));
  assert.equal(original.data.remaining, 3);
  work = advance(work, 300);
  assert.equal(getUnit(work, 1).effects.get(original.id).data.remaining, 3);
  work = element(work, 'NEURAL').state;
  const residual = getUnit(work, 1).effects.values().filter(effect => effect.definition.id.endsWith('/paralysis'));
  assert.equal(residual.length, 1);
  assert.equal(residual[0].id, original.id);
  assert.equal(residual[0].data.remaining, 3);
});

test('elemental execution: burn resistance loss remains during recovery and expires at its deadline', () => {
  for (const receiver of ['CHARACTER', 'ENEMY']) {
    let broken = effectFixtureWork(unit(receiver));
    broken = element(broken, 'BURN').state;
    broken = advance(broken, 299);
    assert.equal(defense(broken).resistance, 30);
    broken = advance(broken, 300);
    assert.equal(defense(broken).resistance, 50);
    assert.deepEqual(getUnit(broken, 1).elemental.ep, elementValues(1000));
  }
});

test('elemental execution: character necrosis settles fifteen magical pulses, drains SP and blocks recovery and activation until recovery ends', () => {
  const skill = createSkillDefinition({ id: 'necrosis-sp', sp: { initial: 20, capacity: 30, requirement: 30, recovery: { type: 'TIME', intervalTicks: 30 } } });
  let work = effectFixtureWork(unit('CHARACTER', { skill }));
  work = element(work, 'NECROSIS').state;
  assert.equal(getUnit(work, 1).vitality.hp, 100000);
  assert.equal(activateSkill(work, unitRef(getUnit(work, 1))).value.type, 'REJECTED');
  work = recover(work, unitRef(getUnit(work, 1)), 'TIME', 3).state;
  assert.equal(getUnit(work, 1).skill.sp.value, 20);
  work = advance(work, 30);
  assert.equal(getUnit(work, 1).vitality.hp, 99950);
  assert.equal(getUnit(work, 1).skill.sp.value, 19);
  work = advanceSkill(work, unitRef(getUnit(work, 1)));
  assert.equal(getUnit(work, 1).skill.sp.value, 19);
  work = advance(work, 450);
  assert.equal(getUnit(work, 1).vitality.hp, 99250);
  assert.equal(getUnit(work, 1).skill.sp.value, 5);
  assert.equal(work.events.filter(event => event.type === 'DAMAGE').length, 15);
  assert.equal(recover(work, unitRef(getUnit(work, 1)), 'TIME', 0).value.type, 'APPLIED');
  work = recover(work, unitRef(getUnit(work, 1)), 'TIME', 3).state;
  assert.equal(getUnit(work, 1).skill.sp.value, 8);
});

test('elemental execution: enemy necrosis damage is elemental and its attack reduction fades before full recovery', () => {
  let work = effectFixtureWork(unit('ENEMY'));
  work = element(work, 'NECROSIS').state;
  assert.equal(power(work), 50);
  work = advance(work, 150);
  near(power(work), 100 * (1 - 0.5 * 10 / 15));
  assert.equal(getUnit(work, 1).vitality.hp, 96000);
  work = advance(work, 300);
  near(power(work), 100 * (1 - 0.5 * 5 / 15));
  work = advance(work, 450);
  assert.equal(power(work), 100);
  assert.equal(getUnit(work, 1).vitality.hp, 88000);
  const damage = work.events.filter(event => event.type === 'DAMAGE');
  assert.equal(damage.length, 15);
  assert.equal(damage.every(event => event.amount === 800 && event.damageType === 'ELEMENTAL'), true);
});

test('elemental execution: paused and accelerated burst time also controls periodic output without changing total pulses', () => {
  let work = effectFixtureWork(unit('ENEMY'));
  work = element(work, 'NECROSIS').state;
  const speed = value => current => ({ ...current, elemental: setContribution(current.elemental, 'burstRecoverySpeed', {
    id: 'burst-speed', value: [modifier({ finalScaler: value })],
  }) });
  work = transitionUnit(work, 1, speed(0));
  work = advance(work, 60);
  assert.equal(getUnit(work, 1).vitality.hp, 100000);
  assert.equal(getUnit(work, 1).elemental.burst.remainingTicks, 450);
  work = transitionUnit(work, 1, speed(2));
  work = advance(work, 210);
  assert.equal(getUnit(work, 1).vitality.hp, 92000);
  near(power(work), 100 * (1 - 0.5 * 5 / 15));
  work = advance(work, 285);
  assert.equal(getUnit(work, 1).elemental.burst, null);
  assert.equal(getUnit(work, 1).vitality.hp, 88000);
  assert.equal(work.events.filter(event => event.type === 'DAMAGE').length, 15);
  assert.equal(power(work), 100);
});

for (const pause of ['spatial absence', 'zero HP']) {
  test(`elemental execution: ${pause} pauses Burst and periodic clocks without catchup on return`, () => {
    let work = element(effectFixtureWork(unit('ENEMY')), 'NECROSIS').state;
    work = transitionUnit(work, 1, current => pause === 'spatial absence'
      ? { ...current, spatialPresence: { present: false } }
      : { ...current, vitality: { ...current.vitality, hp: 0 } });
    work = advance(work, 100);
    assert.equal(getUnit(work, 1).elemental.burst.remainingTicks, 450);
    assert.equal(getUnit(work, 1).elemental.lastAdvancedTick, 100);
    assert.equal(work.events.some(event => event.type === 'DAMAGE'), false);
    work = transitionUnit(work, 1, current => pause === 'spatial absence'
      ? { ...current, spatialPresence: { present: true } }
      : { ...current, vitality: { ...current.vitality, hp: 100000 } });
    work = advance(work, 130);
    assert.equal(getUnit(work, 1).elemental.burst.remainingTicks, 420);
    assert.equal(getUnit(work, 1).vitality.hp, 99200);
    assert.equal(work.events.filter(event => event.type === 'DAMAGE').length, 1);
  });
}

test('elemental execution: temporary burn resistance follows Burst lifetime when recovery speed changes', () => {
  let work = element(effectFixtureWork(unit('ENEMY')), 'BURN').state;
  work = transitionUnit(work, 1, current => ({ ...current, elemental: setContribution(current.elemental, 'burstRecoverySpeed', {
    id: 'burst-speed', value: [modifier({ finalScaler: 2 })],
  }) }));
  work = advance(work, 149);
  assert.equal(defense(work).resistance, 30);
  work = advance(work, 150);
  assert.equal(defense(work).resistance, 50);
  assert.equal(getUnit(work, 1).elemental.burst, null);
});

test('elemental HP damage ignores physical defense, magic resistance, source attack contributions and EP resistance but has its own five percent floor', () => {
  for (const [damageResistance, expected] of [[0, 100], [50, 50], [100, 5], [1000, 5], [-50, 100]]) {
    const source = initialize({ id: 0, position: [0, 0], definition: { id: 'element-source', offense: { attack: 10000 } } });
    const boosted = ({ ...source, offense: setAttackContribution(source.offense, { id: 'attack-buff', value: [modifier({ multiplier: 100 })] }) });
    const input = effectFixtureWork(boosted, unit('ENEMY', { vitality: { maxHp: 100000, defense: 100000, resistance: 99 } }, { damageResistance, elementResistance: 100 }));
    const result = dealDamage(input, { source: { id: 0 }, target: { id: 1 }, parameters: parameters(100, 'ELEMENTAL') });
    near(result.value.application.hpLoss, expected);
    near(result.value.received.amount, expected);
    near(calculateDamage(input, { source: unitRef(boosted), target: { id: 1 }, parameters: parameters(100, 'ELEMENTAL') }).value.amount, expected);
    assert.deepEqual(getUnit(input, 1).elemental.ep, elementValues(1000));
  }
});

test('HP elemental settlement and EP settlement read their distinct current contributions', () => {
  let work = effectFixtureWork(unit('ENEMY'));
  work = transitionUnit(work, 1, current => ({ ...current, elemental: setContribution(
    setContribution(current.elemental, 'damageResistance', { id: 'hp-resistance', value: [modifier({ addition: 50 })] }),
    'elementResistance', { id: 'ep-resistance', value: [modifier({ addition: 100 })] },
  ) }));
  const hp = dealDamage(work, { source: null, target: { id: 1 }, parameters: parameters(100, 'ELEMENTAL') });
  assert.equal(hp.value.application.hpLoss, 50);
  const ep = element(hp.state, 'BURN', 0, 100);
  near(ep.value.amount, 5);
  assert.equal(getUnit(ep.state, 1).vitality.hp, 99950);
  assert.equal(getUnit(ep.state, 1).elemental.ep.BURN, 995);
});

test('elemental healing receives every EP bar independently from HP healing and refuses the shared burst lock', () => {
  let receiver = unit('CHARACTER');
  receiver = { ...receiver, vitality: setHealingHook(receiver.vitality, {
    id: 'hp-healing-refused', stage: 'receiving', priority: 0,
    invoke: (state, _context, pending) => ({ state, value: { ...pending, cancellation: { reason: 'CONTENT_REJECTS_HEALING' } } }),
  }) };
  receiver = { ...receiver, vitality: { ...receiver.vitality, hp: 99000 } };
  let work = effectFixtureWork(receiver);
  work = element(work, 'BURN', 0, 200).state;
  work = element(work, 'NEURAL', 0, 80).state;
  const hp = healing(work, { source: null, target: { id: 1 }, parameters: { power: 100, multiplier: 1 } });
  work = hp.state;
  assert.equal(hp.value.kind, 'CANCELLED');
  assert.equal(hp.value.received.amount, 100);
  const healed = elemental.heal(work, unitRef(getUnit(work, 1)), { power: 100, source: null });
  work = healed.state;
  assert.equal(healed.value.type, 'APPLIED');
  assert.equal(Object.values(healed.value.amounts).reduce((sum, amount) => sum + amount, 0), 180);
  assert.equal(getUnit(work, 1).vitality.hp, 99000);
  assert.deepEqual(getUnit(work, 1).elemental.ep, { NEURAL: 1000, EROSION: 1000, BURN: 900, NECROSIS: 1000 });
  let broken = work;
  broken = element(broken, 'BURN').state;
  assert.equal(elemental.heal(broken, unitRef(getUnit(broken, 1)), { power: 1000, source: null }).value.type, 'REJECTED');
  let immune = effectFixtureWork(unit('CHARACTER'));
  immune = element(immune, 'BURN', 0, 100).state;
  immune = transitionUnit(immune, 1, current => ({ ...current, elemental: setRule(current.elemental, { id: 'immune', allowsDamage: () => false }) }));
  assert.equal(elemental.heal(immune, unitRef(getUnit(immune, 1)), { power: 100, source: null }).value.type, 'APPLIED');
});

test('invincibility observes incoming EP damage, permits EP healing and removes its Rule when the Effect ends', () => {
  const seen = [];
  let work = element(effectFixtureWork(unit()), 'BURN', 0, 200).state;
  work = transitionUnit(work, 1, current => ({ ...current, elemental: setElementalHook(current.elemental, 'received', {
    id: 'received', invoke: (battle, { event }) => { seen.push(event.request.power); return { state: battle, value: undefined }; },
  }) }));
  const installed = effects.install(work, unitRef(getUnit(work, 1)), invincible);
  const denied = element(installed.state, 'BURN', 0, 100);
  assert.equal(denied.value.type, 'REJECTED');
  assert.deepEqual(seen, [100]);
  assert.equal(getUnit(denied.state, 1).elemental.ep.BURN, 800);
  work = elemental.heal(denied.state, unitRef(getUnit(denied.state, 1)), { source: null, power: 50 }).state;
  assert.equal(getUnit(work, 1).elemental.ep.BURN, 850);
  work = effects.end(work, installed.value, 'EXPLICIT');
  const accepted = element(work, 'BURN', 0, 100);
  assert.equal(accepted.value.type, 'APPLIED');
  assert.equal(getUnit(accepted.state, 1).elemental.ep.BURN, 750);
});

test('elemental attacks select EP receivers without Vitality', () => {
  const healingAction = createAttack({ id: 'healing', triggerBindingId: 'primary', intervalTicks: 30,
    targetGroups: [{ id: 'primary', targeting: { type: 'HEAL', geometry: { type: 'SHAPES', geometry: range },
      includeSelf: false, ignoreAllyTargetFree: false, ignoreHealFree: false, maxTargets: 1 },
      operations: [{ type: 'ELEMENT_HEAL', power: 100 }] }],
  });
  const damageAction = createAttack({ ...action().attack, id: 'damage', targetGroups: [{ ...action().attack.targetGroups[0],
    operations: [{ type: 'ELEMENT_DAMAGE', elementType: 'NEURAL', power: 100 }] }],
  });
  const healer = initialize({ id: 0, position: [0, 0], definition: definition('CHARACTER', {
    action: { definitions: Definitions.empty().add(healingAction).add(damageAction) },
  }) });
  const { vitality: omitted, ...receiverDefinition } = definition('CHARACTER');
  let receiver = initialize({ id: 1, position: [1, 0], definition: receiverDefinition });
  let work = effectFixtureWork(healer, receiver);
  work = element(work, 'BURN', 0, 200).state;
  assert.deepEqual(chooseTargets(work, unitRef(healer), healingAction.attack).primary.map(ref => ref.id), [1]);
  work = start(work, unitRef(healer), healingAction).state;
  receiver = getUnit(work, 1);
  assert.equal('vitality' in receiver, false);
  assert.equal(receiver.elemental.ep.BURN, 900);
  assert.equal(work.events.filter(event => event.type === 'ELEMENT_HEAL').length, 1);
  const hostileReceiver = { ...receiver, allegiance: { side: 'ENEMY' } };
  work = effectFixtureWork(healer, hostileReceiver);
  assert.deepEqual(chooseTargets(work, unitRef(healer), damageAction.attack).primary.map(ref => ref.id), [1]);
  work = start(work, unitRef(healer), damageAction).state;
  assert.equal(getUnit(work, 1).elemental.ep.NEURAL, 900);
});

test('elemental attack targeting uses current request-specific reception Rules', () => {
  const attackFor = type => createAttack({ ...action().attack, id: `element-${type}`, targetGroups: [{
    ...action().attack.targetGroups[0],
    operations: [{ type: 'ELEMENT_DAMAGE', elementType: type, power: 100 }],
  }] });
  const neural = attackFor('NEURAL');
  const burn = attackFor('BURN');
  const caster = initialize({ id: 0, position: [0, 0], definition: definition('CHARACTER', {
    action: { definitions: Definitions.empty().add(neural).add(burn) },
  }) });
  const receiver = unit('ENEMY');
  let work = effectFixtureWork(caster, receiver);
  work = transitionUnit(work, 1, current => ({ ...current, elemental: setRule(current.elemental, {
    id: 'only-burn', allowsDamage: (_battle, _self, request) => request.type === 'BURN',
  }) }));
  assert.deepEqual(chooseTargets(work, unitRef(caster), neural.attack).primary, []);
  assert.deepEqual(chooseTargets(work, unitRef(caster), burn.attack).primary.map(ref => ref.id), [1]);
  assert.deepEqual(work.events, []);
});

function route() {
  return createRouteDefinition({ pathMotionMode: 'WALK', startPosition: [0, 3], endPosition: [0, 7],
    spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [], allowDiagonalMove: false,
    visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true });
}
function spawn(definition, tick) {
  return { definition, route: route(), tick, timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true, notCountInTotal: false };
}
function battle(receiver, type, { moving = false, targetStates } = {}) {
  const casterAttack = createAttack({ ...action(10000).attack,
    targetGroups: [{ ...action().attack.targetGroups[0], operations: [
      { type: 'ELEMENT_DAMAGE', elementType: type, power: 1000 },
      ...action().attack.targetGroups[0].operations,
    ] }],
  });
  const caster = definition('CHARACTER', { id: 'caster', allegiance: { side: 'ALLY' },
    action: { definitions: Definitions.empty().add(casterAttack) } });
  const victim = definition(receiver, { id: 'victim', allegiance: { side: 'ENEMY' },
    action: { definitions: Definitions.empty().add(action(1)) },
    ...(moving ? { locomotion: { halfBodyWidth: 0, minSpeed: 0, speed: 0.001, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } }, blockable: { volume: 1 } } : {}) });
  const base = createLegacyCombatSpec({ rows: 1, columns: 8, operators: [], enemies: [], maxTicks: 600, seed: 7 });
  const keepOpen = { id: 'future', vitality: { maxHp: 1, defense: 0, resistance: 0 }, locomotion: { halfBodyWidth: 0, minSpeed: 0, speed: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } } };
  const runtime = new BattleRuntime({ ...base,
    initialUnits: [{ definition: caster, position: [0, 0] }, ...(moving ? [] : [placement({ definition: victim, position: [1, 0], ...(targetStates === undefined ? {} : { states: targetStates(victim) }) })])],
    schedule: { type: 'TIMELINE', spawns: [...(moving ? [spawn(victim, 0)] : []), spawn(keepOpen, 599)] },
  });
  return { runtime };
}
function victim(runtime) { return runtime.snapshot().units.find(entry => entry.id === 1); }

test('elemental runtime: character neural stun prevents ordinary attacks and route movement until recovery ends', () => {
  const { runtime } = battle('CHARACTER', 'NEURAL', { moving: true });
  const first = runtime.step();
  assert.equal(first.events.filter(event => event.type === 'DAMAGE' && event.sourceUnitId === 1).length, 0);
  const frozenPosition = [...victim(runtime).position];
  for (let tick = 1; tick < 300; tick++) {
    const step = runtime.step();
    assert.equal(step.events.some(event => event.type === 'DAMAGE' && event.sourceUnitId === 1), false);
    assert.deepEqual(victim(runtime).position, frozenPosition);
  }
  const restored = runtime.step();
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
  const { runtime } = battle('CHARACTER', 'BURN', {
    targetStates: selected => {
      const target = initialize({ id: 1, position: [1, 0], definition: selected });
      const changed = ({ ...target, vitality: setHook(target.vitality, {
        id: 'elemental-fault', stage: 'receiving', priority: 100,
        accepts: () => true,
        invoke: () => { throw new Error('nested burst failed'); },
      }) });
      return { vitality: changed.vitality };
    },
  });
  const initial = runtime.snapshot();
  assert.throws(() => runtime.step(), /nested burst failed/);
  assert.deepEqual(runtime.snapshot(), initial);
});
