import { damage as damageElement } from "../../dist/core/tactical/unit/capability/elemental/operations.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepare } from '../../dist/data/arknights/enemy.js';
import { create as createHound } from '../../dist/content/tactical/enemies/hound.js';
import { create as createCrossbowman, createArrow } from '../../dist/content/tactical/enemies/crossbowman.js';
import { initialize } from "../helpers/unit.js";

import { createBattleState, getUnit, registerUnit } from '../../dist/core/tactical/battle/state.js';
import { create as createBattlefield } from '../../dist/core/tactical/battlefield/state.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { start as startAction } from '../../dist/core/tactical/unit/action/operations.js';
import { ref as unitRef } from '../../dist/core/tactical/unit/query.js';
import { advance as advanceAction } from '../../dist/core/tactical/unit/action/advance.js';
import { advanceProjectiles } from '../../dist/core/tactical/battlefield/projectile/settlement.js';
import { setOverlay } from '../../dist/core/tactical/battlefield/navigation/state.js';
import { advance as advanceLocomotion } from '../../dist/core/tactical/unit/capability/locomotion/operations.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/arknights/main-mode-units.json', import.meta.url), 'utf8'));
const rawEnemy = id => fixture.enemies.find(entry => entry.Key === id);
const profile = (id, level = 0, overwrittenData) => prepare(rawEnemy(id), { level, overwrittenData });

function emptyBattle() {
  const tile = { heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL', playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null };
  return createBattleState(createBattlefield({ map: createBattlefieldMap(5, 5, Array.from({ length: 25 }, () => tile)) }));
}

function guard(id, position, blockCapacity = 1) {
  return initialize({ id, position, definition: {
    id: 'test-guard', targetable: { restrictions: [] }, vitality: { maxHp: 1000, defense: 40, resistance: 0 }, allegiance: { side: 'ALLY' }, spatial: { layer: 'GROUND' },
    hit: { geometry: { shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 0.2 }] } },
    blocker: { capacity: blockCapacity, geometry: { radius: 0.70709997 } },
  } });
}

test('main-mode enemy levels inherit individual defined fields and apply stage overrides last', () => {
  const base = profile('enemy_1000_gopro');
  const advanced = profile('enemy_1000_gopro', 1, { attributes: {
    maxHp: { m_defined: true, m_value: 4000 },
    atk: { m_defined: false, m_value: 9999 },
    moveSpeed: { m_defined: true, m_value: 1.1 },
  } });
  assert.equal(base.maxHp, 820);
  assert.equal(base.attack, 190);
  assert.equal(advanced.maxHp, 4000);
  assert.equal(advanced.attack, 400);
  assert.equal(advanced.resistance, 30);
  assert.equal(advanced.baseAttackTime, 1.4);
  assert.equal(advanced.moveSpeedPerSecond, 1.1);
  assert.equal(advanced.blockVolume, 1);
  assert.deepEqual(advanced.tags, ['infection']);
  assert.equal(rawEnemy('enemy_1000_gopro').Value[0].enemyData.attributes.maxHp.m_value, 820);
  assert.throws(() => profile('enemy_1000_gopro', 2), /exactly one level 2/);
});

test('defined zero is preserved and both selected handbook entries specify physical damage', () => {
  const bow = profile('enemy_1003_ncbow', 1);
  assert.equal(bow.attackSpeed, 0);
  assert.equal(bow.rangeRadius, 1.9);
  assert.equal(bow.attack, 310);
  assert.deepEqual(bow.tags, []);
  for (const id of ['enemy_1000_gopro', 'enemy_1003_ncbow']) {
    assert.deepEqual(fixture.enemyHandbook[id].damageType, ['PHYSIC']);
  }
});

test('unimplemented enemy mechanisms are rejected at the table and content boundaries', () => {
  assert.throws(() => profile('enemy_1000_gopro', 0, {
    attributes: { hpRecoveryPerSec: { m_defined: true, m_value: 20 } },
  }), /unsupported enemy attribute hpRecoveryPerSec/);
  assert.throws(() => profile('enemy_1000_gopro', 0, { skills: [{ prefabKey: 'unimplemented' }] }), /unsupported enemy skills/);
  const timing = { windupTicks: 0, recoveryTicks: 0, hitRadius: 0.2 };

  assert.throws(() => createHound({ ...profile('enemy_1000_gopro'), stunImmune: true }, timing, 0.2), /stun immunity/);
  assert.throws(() => createHound(profile('enemy_1003_ncbow'), timing, 0.2), /Hound content/);
  assert.throws(() => createCrossbowman(profile('enemy_1000_gopro'), {
    ...timing, projectile: { definition: createArrow(), speedPerSecond: 6, contactRadius: 0.1, stopDelayTicks: 0 },
  }, 0.2), /Crossbowman content/);
});

test('hound factory composes capabilities and attacks its retained blocker with pure state flow', () => {

  const { definition, action: attack } = createHound(profile('enemy_1000_gopro'), { windupTicks: 0, recoveryTicks: 0, hitRadius: 0.2 }, 0.2);
  const hound = initialize({ id: 1, position: [2, 2.5], definition });
  assert.equal(hound.vitality.hp, 820);
  assert.equal(hound.locomotion.speed.length, 0);
  assert.equal(definition.locomotion.speed, 1.9 / 30);

  const before = registerUnit(registerUnit(emptyBattle(), guard(0, [2, 2])), hound);
  const damaged = damageElement(before, unitRef(hound), { source: null, type: 'BURN', power: 100 });
  assert.equal(getUnit(damaged.state, 1).elemental.ep.BURN, 900);
  assert.equal(getUnit(damaged.state, 1).vitality.hp, 820);
  const after = startAction(before, unitRef(hound), attack).state;
  assert.equal(getUnit(after, 0).vitality.hp, 850);
  assert.equal(getUnit(before, 0).vitality.hp, 1000);
  assert.deepEqual(before.events, []);
  assert.ok(after.events.some(event => event.type === 'DAMAGE'));
});

test('crossbow uses explicit windup and arrow speed, then settles damage on contact', () => {

  const projectileDefinition = createArrow();
  const { definition, action: attack } = createCrossbowman(profile('enemy_1003_ncbow'), {
    windupTicks: 1, recoveryTicks: 1, hitRadius: 0.2,
    projectile: { definition: projectileDefinition, speedPerSecond: 6, contactRadius: 0.1, stopDelayTicks: 0 },
  }, 0.2);

  const bow = initialize({ id: 1, position: [2, 3.5], definition });
  const before = registerUnit(registerUnit(emptyBattle(), guard(0, [2, 2], 0)), bow);
  const started = startAction(before, unitRef(bow), attack);
  let state = started.state;
  assert.equal(state.battlefield.projectiles.size, 0);
  assert.equal(getUnit(state, 0).vitality.hp, 1000);
  state = advanceAction({ ...state, tick: 1 }, started.value.ref);
  assert.equal(state.battlefield.projectiles.size, 1);
  assert.equal(getUnit(state, 0).vitality.hp, 1000);
  for (let tick = 2; tick <= 10; tick++) {
    state = advanceProjectiles({ ...state, tick }, tick, []);
  }
  assert.equal(getUnit(state, 0).vitality.hp, 800);
  assert.ok(state.events.some(event => event.type === 'PROJECTILE_HIT' && event.targetUnitId === 0));
  assert.equal(getUnit(before, 0).vitality.hp, 1000);
  assert.equal(before.battlefield.projectiles.size, 0);
});

test('different crossbow configurations share an arrow definition in one battle', () => {

  const projectile = { definition: createArrow(), speedPerSecond: 6, contactRadius: 0.1, stopDelayTicks: 0 };
  const base = createCrossbowman(profile('enemy_1003_ncbow'), {
    windupTicks: 1, recoveryTicks: 1, hitRadius: 0.2, projectile,
  }, 0.2);
  const advanced = createCrossbowman(profile('enemy_1003_ncbow', 1), {
    windupTicks: 2, recoveryTicks: 1, hitRadius: 0.2, projectile,
  }, 0.2);

  assert.strictEqual(base.definition.elemental.bursts.BURN, advanced.definition.elemental.bursts.BURN);
  assert.equal(base.definition.offense.attack, 240);
  assert.equal(advanced.definition.offense.attack, 310);
  assert.equal(base.action.attack.windupTicks, 1);
  assert.equal(advanced.action.attack.windupTicks, 2);
  assert.strictEqual(base.definition.attackTiming.projectile.definition, advanced.definition.attackTiming.projectile.definition);
});

test('enemy content keeps hit radius and terrain avoidance width independent', () => {
  const timing = { windupTicks: 0, recoveryTicks: 0, hitRadius: 0.4 };
  const hound = createHound(profile('enemy_1000_gopro'), timing, 0.15).definition;
  const crossbowman = createCrossbowman(profile('enemy_1003_ncbow'), {
    ...timing,
    projectile: { definition: createArrow(), speedPerSecond: 6, contactRadius: 0.1, stopDelayTicks: 0 },
  }, 0.25).definition;

  for (const [definition, halfBodyWidth] of [[hound, 0.15], [crossbowman, 0.25]]) {
    const unit = initialize({ id: 1, position: [2, 2], definition });
    assert.equal(unit.definition.hit.geometry.shapes[0].radius, 0.4);
    assert.equal(unit.definition.locomotion.halfBodyWidth, halfBodyWidth);
  }

  const move = definition => {
    const initial = emptyBattle();
    const navigation = setOverlay(initial.battlefield.navigation, 'WALK', {
      id: 0, cells: [[3, 3]], denyPassage: true, denyDepartures: [],
    });
    const before = registerUnit({ ...initial, battlefield: { ...initial.battlefield, navigation } },
      initialize({ id: 1, position: [2.1, 2.4], definition }));
    const goal = [2.1, 4];
    return getUnit(advanceLocomotion(before, { id: 1 }, { nextPoint: goal, goal }, {
      mode: 'WALK', speedMultiplier: 1,
    }), 1);
  };
  const narrow = move(hound);
  const changedHit = move(createHound(profile('enemy_1000_gopro'), { ...timing, hitRadius: 0.05 }, 0.15).definition);
  const wider = move(createHound(profile('enemy_1000_gopro'), timing, 0.35).definition);
  assert.deepEqual(changedHit.position, narrow.position);
  assert.deepEqual(changedHit.locomotion.velocity, narrow.locomotion.velocity);
  assert.ok(wider.position[0] < narrow.position[0], 'only the wider movement body begins avoiding this corner');
});
