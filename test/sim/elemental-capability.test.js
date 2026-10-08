import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  ELEMENT_TYPES,
  copyElementalState,
  createElementalDefinition,
  elementValues,
  hasElemental,
  initializeElementalState,
  setElementalImmunity,
} from '../../dist/core/tactical/unit/capability/elemental/capability.js';
import {
  canReceiveElementDamage,
  canReceiveElementHeal,
  elementDamageRatio,
  getCurrentElementType,
} from '../../dist/core/tactical/unit/capability/elemental/query.js';
import {
  advanceElemental,
  receiveElementDamage,
  receiveElementHeal,
} from '../../dist/core/tactical/unit/capability/elemental/settlement.js';
import {
  createArknightsElementalDefinition,
  getArknightsElementalBurstProfile,
  parseElementType,
} from '../../dist/data/arknights/elemental.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { copyUnitSnapshot } from '../../dist/core/tactical/unit/snapshot.js';

const holder = (options = {}, extras = {}) => initializeUnit({
  id: 1,
  position: [0, 0],
  definition: {
    id: 'element-holder',
    allegiance: { side: 'ALLY' },
    elemental: createArknightsElementalDefinition({ receiver: 'CHARACTER', ...options }),
    ...extras,
  },
});
const damage = (unit, type, power, tick = 0, sourceUnitId = 9) => receiveElementDamage(unit, {
  type, power, sourceUnitId, tick,
});
const heal = (unit, power, tick = 0) => receiveElementHeal(unit, { power, tick });

test('Elemental is optional and has its own definition, progress and ownership', () => {
  const ordinary = initializeUnit({ id: 0, position: [0, 0], definition: { id: 'hp-only', vitality: { maxHp: 100 } } });
  assert.equal(hasElemental(ordinary), false);
  assert.equal(canReceiveElementDamage(ordinary), false);
  assert.equal(canReceiveElementHeal(ordinary), false);
  const rejected = damage(ordinary, 'BURN', 100);
  assert.equal(rejected.outcome, 'REJECTED');
  assert.equal(rejected.reason, 'NO_ELEMENTAL');
  assert.equal(rejected.unit, ordinary);
  const definition = createArknightsElementalDefinition({ receiver: 'CHARACTER' });
  const state = initializeElementalState(definition, { tick: 7 });
  assert.deepEqual(state.ep, elementValues(1000));
  assert.equal(state.lastRecoveryTick, 7);
  assert.equal(definition.recoveryPerTick, 0);
  assert.equal(Object.isFrozen(definition.burstDurationsTicks), true);
  const original = holder();
  assert.equal('vitality' in original, false);
  assert.equal(damage(original, 'BURN', 50).unit.elemental.ep.BURN, 950);
  const copy = copyElementalState(state);
  assert.notEqual(copy.ep, state.ep);
  assert.ok(Object.isFrozen(copy.ep));
  assert.equal(copy.lastRecoveryTick, state.lastRecoveryTick);
});

test('four elemental bars are independent and the current element uses lowest EP then the native element order', () => {
  let unit = holder();
  assert.equal(getCurrentElementType(unit), undefined);
  for (const type of ['NECROSIS', 'BURN', 'EROSION', 'NEURAL']) {
    unit = damage(unit, type, 200).unit;
    assert.equal(unit.elemental.ep[type], 800);
  }
  assert.deepEqual(unit.elemental.ep, elementValues(800));
  assert.equal(getCurrentElementType(unit), 'NEURAL');
  unit = damage(unit, 'NECROSIS', 50).unit;
  assert.equal(getCurrentElementType(unit), 'NECROSIS');
  assert.equal(elementDamageRatio(unit), 0.25);
  assert.deepEqual(holder({ receiver: 'ENEMY', boss: true }).elemental.ep, elementValues(2000));
});

test('EP resistance uses the native 5 percent floor and never uses elemental HP damage resistance', () => {
  for (const [elementResistance, expected] of [[0, 100], [50, 50], [100, 5], [500, 5], [-50, 100]]) {
    const unit = holder({ elementResistance, damageResistance: 100 });
    const result = damage(unit, 'EROSION', 100);
    assert.equal(result.amount, expected);
    assert.equal(result.unit.elemental.ep.EROSION, 1000 - expected);
    assert.equal(unit.elemental.ep.EROSION, 1000);
  }
});

test('the first zero bar starts one unit recovery and discards overflow and all other elemental progress', () => {
  const original = damage(holder(), 'NEURAL', 400).unit;
  const broken = damage(original, 'BURN', 1500, 4, 42);
  assert.equal(broken.outcome, 'BURST');
  assert.equal(broken.amount, 1000);
  assert.deepEqual(broken.unit.elemental.ep, elementValues(0));
  assert.deepEqual(broken.burst, {
    type: 'BURN', receiver: 'CHARACTER', sourceUnitId: 42,
    targetUnitId: 1, startedAtTick: 4, endsAtTick: 304,
  });
  assert.equal(original.elemental.ep.NEURAL, 600);
  for (const type of ELEMENT_TYPES) {
    const result = damage(broken.unit, type, 1500, 4);
    assert.equal(result.outcome, 'REJECTED');
    assert.equal(result.reason, 'RECOVERING');
    assert.equal(result.unit, broken.unit);
  }
  assert.equal(heal(broken.unit, 1000, 4).reason, 'RECOVERING');
});

test('burst recovery is progressive, idempotent at a tick, independently copyable and restores every bar at its deadline', () => {
  const broken = damage(holder(), 'NECROSIS', 1000, 2).unit;
  const snapshot = copyUnitSnapshot(broken);
  const half = advanceElemental(broken, 227);
  assert.deepEqual(half.unit.elemental.ep, elementValues(500));
  assert.equal(half.recovered, false);
  assert.equal(half.burst.type, 'NECROSIS');
  assert.equal(canReceiveElementHeal(half.unit), false);
  assert.equal(advanceElemental(half.unit, 227).unit, half.unit);
  const restored = advanceElemental(half.unit, 452);
  assert.equal(restored.recovered, true);
  assert.equal(restored.burst.sourceUnitId, 9);
  assert.equal(restored.unit.elemental.recovery, null);
  assert.deepEqual(restored.unit.elemental.ep, elementValues(1000));
  assert.deepEqual(advanceElemental(snapshot, 452), advanceElemental(broken, 452));
  assert.deepEqual(snapshot.elemental.ep, elementValues(0));
  assert.equal(damage(restored.unit, 'EROSION', 1000, 452).outcome, 'BURST');
});

test('ordinary elemental healing applies its full value to every bar, clamps each and reports the actual amounts', () => {
  let unit = damage(holder({}, { vitality: { maxHp: 100 } }), 'NEURAL', 200).unit;
  unit = damage(unit, 'EROSION', 80).unit;
  unit = damage(unit, 'NECROSIS', 300).unit;
  const result = heal(unit, 150);
  assert.equal(result.outcome, 'APPLIED');
  assert.deepEqual(result.amounts, { NEURAL: 150, EROSION: 80, BURN: 0, NECROSIS: 150 });
  assert.equal(result.amount, 380);
  assert.deepEqual(result.unit.elemental.ep, { NEURAL: 950, EROSION: 1000, BURN: 1000, NECROSIS: 850 });
  assert.equal(result.unit.vitality.hp, 100);
  assert.equal(heal(holder(), 500).amount, 0);
});

test('global elemental immunity rejects damage and healing without resetting progress; HP HEAL_FREE is independent', () => {
  const raw = holder({}, { status: { initialFlags: ['HEAL_FREE'] } });
  const damaged = damage(raw, 'BURN', 100).unit;
  assert.equal(heal(damaged, 50).amount, 50);
  const immune = setElementalImmunity(damaged, true);
  assert.equal(damage(immune, 'BURN', 50).reason, 'IMMUNE');
  assert.equal(heal(immune, 50).reason, 'IMMUNE');
  assert.equal(immune.elemental.ep.BURN, 900);
  assert.equal(setElementalImmunity(immune, true), immune);
  const enabled = setElementalImmunity(immune, false);
  assert.equal(heal(enabled, 50).unit.elemental.ep.BURN, 950);
});

test('neutral, absent and dead receivers are ordinary rejections while invalid numbers still throw', () => {
  for (const unit of [
    holder({}, { allegiance: { side: 'NEUTRAL' } }),
    { ...holder(), spatialPresence: { present: false } },
    { ...holder({}, { vitality: { maxHp: 100 } }), vitality: { hp: 0, maxHp: { entries: [] } } },
  ]) {
    const result = damage(unit, 'BURN', 100);
    assert.equal(result.outcome, 'REJECTED');
    assert.equal(result.amount, 0);
    assert.equal(result.unit, unit);
    assert.equal(heal(unit, 100).outcome, 'REJECTED');
  }
  assert.throws(() => damage(holder(), 'BURN', Infinity), RangeError);
  assert.throws(() => heal(holder(), -1), RangeError);
  assert.throws(() => advanceElemental(holder(), -1), RangeError);
  const advanced = advanceElemental(holder({ recoveryPerSecond: 30 }), 5).unit;
  assert.throws(() => damage(advanced, 'BURN', 1, 4), RangeError);
});

test('natural EP recovery is explicit, affects all bars and does not accumulate an idle healing budget', () => {
  const unit = holder({ recoveryPerSecond: 30 });
  let damaged = damage(unit, 'BURN', 100, 10).unit;
  damaged = damage(damaged, 'NEURAL', 20, 10).unit;
  const recovered = advanceElemental(damaged, 40).unit;
  assert.equal(recovered.elemental.ep.BURN, 930);
  assert.equal(recovered.elemental.ep.NEURAL, 1000);
  assert.equal(advanceElemental(recovered, 40).unit, recovered);
  const newDamage = damage(advanceElemental(unit, 1000).unit, 'BURN', 100, 1000).unit;
  assert.equal(advanceElemental(newDamage, 1001).unit.elemental.ep.BURN, 901);
  const standard = damage(holder(), 'BURN', 100).unit;
  assert.equal(advanceElemental(standard, 1000).unit, standard);
});

test('raw element identities preserve the four supported native types and reject NONE, ANGER and guessed aliases', () => {
  for (const [index, raw, type] of [
    [1, 'SANITY', 'NEURAL'], [2, 'WATER', 'EROSION'], [3, 'FIRE', 'BURN'], [4, 'DARK', 'NECROSIS'],
  ]) {
    assert.equal(parseElementType(index), type);
    assert.equal(parseElementType(raw), type);
  }
  for (const value of [0, 5, 'NONE', 'ANGER', 'fire', 'BURN']) assert.throws(() => parseElementType(value), TypeError);
});

test('standard burst profiles distinguish receiver class, boss threshold, ordinary damage and elemental HP damage', () => {
  const character = ELEMENT_TYPES.map(type => getArknightsElementalBurstProfile('CHARACTER', type));
  const enemy = ELEMENT_TYPES.map(type => getArknightsElementalBurstProfile('ENEMY', type));
  assert.deepEqual(character.map(p => p.durationTicks), [300, 300, 300, 450]);
  assert.deepEqual(enemy.map(p => p.durationTicks), [300, 240, 300, 450]);
  assert.deepEqual(character.map(p => p.burstDamage), [
    { type: 'TRUE', power: 1000 }, { type: 'PHYSICAL', power: 800 }, { type: 'ARTS', power: 1200 }, null,
  ]);
  assert.deepEqual(enemy.map(p => p.burstDamage), [
    { type: 'ELEMENTAL', power: 6000 }, { type: 'ELEMENTAL', power: 5000 }, { type: 'ELEMENTAL', power: 7000 }, null,
  ]);
  assert.equal(character[1].defReduction, 100);
  assert.equal(enemy[1].defReduction, 120);
  assert.equal(character[2].resReduction, 20);
  assert.equal(enemy[2].resReduction, 20);
  assert.equal(character[0].stunTicks, 300);
  assert.equal(enemy[0].paralysisStacks, 3);
  assert.deepEqual(character[3].damagePerSecond, { type: 'ARTS', power: 100 });
  assert.deepEqual(enemy[3].damagePerSecond, { type: 'ELEMENTAL', power: 800 });
  assert.equal(character[3].spDrainPerSecond, 1);
  assert.equal(character[3].blocksSkill, true);
  assert.equal(character[3].blocksSpRecovery, true);
  assert.equal(enemy[3].attackReductionRatio, 0.5);
  assert.equal(holder({ receiver: 'ENEMY', boss: true }).definition.elemental.maxEp, 2000);
  assert.equal(holder({ receiver: 'CHARACTER', boss: true }).definition.elemental.maxEp, 1000);
  assert.equal(holder({ receiver: 'ENEMY' }, { allegiance: { side: 'ALLY' } }).definition.elemental.receiver, 'ENEMY');
  assert.ok(Object.isFrozen(enemy[0].burstDamage));
  assert.throws(() => createElementalDefinition({
    receiver: 'CHARACTER', maxEp: 0, burstDurationsTicks: elementValues(300),
  }), RangeError);
});

test('standard elemental profiles match the extracted client EPBreakBuffDB, BuffData and prefab damage nodes', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/arknights-elemental-buffs.json', import.meta.url), 'utf8'));
  const rawDamageType = { PURE: 'TRUE', PHYSICAL: 'PHYSICAL', MAGICAL: 'ARTS', ELEMENT: 'ELEMENTAL' };
  const blackboard = key => new Map(fixture.buffData[key].blackboard.map(entry => [entry.key, entry.value]));
  const damageNode = key => fixture.buffTemplates.find(entry => entry.record.templateKey === key).record.eventToActions._items
    .flatMap(entry => JSON.parse(entry.value.SerializedState))
    .find(node => node.$type === 'Torappu.Battle.Action.Nodes+NoSourceDamage');
  for (const [raw, type] of [['SANITY', 'NEURAL'], ['WATER', 'EROSION'], ['FIRE', 'BURN'], ['DARK', 'NECROSIS']]) {
    const breakData = fixture.epBreakData[raw];
    for (const receiver of ['CHARACTER', 'ENEMY']) {
      const selected = getArknightsElementalBurstProfile(receiver, type);
      const suffix = receiver === 'CHARACTER' ? 'char' : 'enemy';
      const buffKey = `${breakData.elementBuffs[0]}_${suffix}`;
      const values = blackboard(buffKey);
      assert.equal(selected.durationTicks, 30 * breakData[receiver === 'CHARACTER' ? 'elementBreakDuration' : 'enemyElementBreakDuration']);
      if (raw !== 'DARK') {
        const node = damageNode(buffKey);
        assert.deepEqual(selected.burstDamage, { type: rawDamageType[node._damageType], power: values.get(node._damageKey) });
        assert.equal(node._ignoreForSp, false);
      } else {
        const node = damageNode(receiver === 'CHARACTER' ? 'periodic_magic_damage' : 'periodic_element_damage');
        assert.deepEqual(selected.damagePerSecond, { type: rawDamageType[node._damageType], power: values.get('damage') / values.get('interval') });
        assert.equal(node._ignoreForSp, true);
      }
    }
  }
  assert.equal(getArknightsElementalBurstProfile('CHARACTER', 'NEURAL').stunTicks, 30 * blackboard('ep_break_sanity_char').get('stun'));
  assert.equal(getArknightsElementalBurstProfile('ENEMY', 'NEURAL').paralysisStacks, blackboard('ep_break_sanity_enemy').get('palsy_stack_cnt'));
  assert.equal(getArknightsElementalBurstProfile('CHARACTER', 'EROSION').defReduction, -blackboard('ep_break_water_char').get('def'));
  assert.equal(getArknightsElementalBurstProfile('ENEMY', 'EROSION').defReduction, -fixture.buffData.ep_break_water_enemy.attributes.attributeModifiers[0].value);
  assert.equal(fixture.buffData.ep_break_water_enemy.isDurableBuff, true);
  assert.equal(getArknightsElementalBurstProfile('CHARACTER', 'BURN').resReduction, -blackboard('ep_break_fire_char').get('magic_resistance'));
  assert.equal(getArknightsElementalBurstProfile('ENEMY', 'BURN').resReduction, -fixture.buffData.ep_break_fire_enemy.attributes.attributeModifiers[0].value);
  assert.equal(getArknightsElementalBurstProfile('CHARACTER', 'NECROSIS').spDrainPerSecond, -blackboard('ep_break_dark_char').get('sp'));
  assert.equal(getArknightsElementalBurstProfile('ENEMY', 'NECROSIS').attackReductionRatio, -blackboard('ep_break_dark_enemy').get('atk_down'));
});
