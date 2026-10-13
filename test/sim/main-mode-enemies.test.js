import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepare } from '../../dist/data/arknights/enemy.js';
import { createDefinition, compileNormalAction, registerArrow } from '../../dist/content/tactical/enemies.js';
import { initialize } from '../../dist/core/tactical/unit/initialize.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { createBattleState, getUnit, registerUnit } from '../../dist/core/tactical/battle/state.js';
import { create as createBattlefield } from '../../dist/core/tactical/battlefield/state.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { startAction } from '../../dist/core/tactical/unit/capability/action/execution.js';
import { resumeActionExecution } from '../../dist/core/tactical/unit/capability/action/process.js';
import { createProjectileOperations } from '../../dist/core/tactical/battlefield/projectile/operations.js';
import { advanceProjectiles } from '../../dist/core/tactical/battlefield/projectile/settlement.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/arknights/main-mode-units.json', import.meta.url), 'utf8'));
const rawEnemy = id => fixture.enemies.find(entry => entry.Key === id);
const profile = (id, level = 0, overwrittenData) => prepare(rawEnemy(id), { level, overwrittenData });

function emptyBattle() {
  const tile = { heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL', playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null };
  return createBattleState(createBattlefield({ map: createBattlefieldMap(5, 5, Array.from({ length: 25 }, () => tile)) }));
}

function guard(id, position, blockCapacity = 1) {
  return initialize({ id, position, definition: {
    id: 'test-guard', vitality: { maxHp: 1000 }, defense: { defense: 40, resistance: 0 },
    allegiance: { side: 'ALLY' }, spatial: { layer: 'GROUND' },
    hit: { geometry: { shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 0.2 }] } },
    status: { initialFlags: [] }, blocker: { capacity: blockCapacity, geometry: { radius: 0.70709997 } },
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
  assert.equal(advanced.blockWeight, 1);
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
  assert.throws(() => createDefinition({ ...profile('enemy_1000_gopro'), stunImmune: true }, timing), /stun immunity/);
  assert.throws(() => createDefinition(profile('enemy_1003_ncbow'), timing), /projectile configuration/);
});

test('hound factory composes capabilities and attacks its retained blocker with pure state flow', () => {
  const definition = createDefinition(profile('enemy_1000_gopro'), { windupTicks: 0, recoveryTicks: 0, hitRadius: 0.2 });
  const hound = initialize({ id: 1, position: [2, 2.5], definition });
  assert.equal(hound.vitality.hp, 820);
  assert.equal(hound.locomotion.moveSpeed.length, 0);
  assert.equal(definition.locomotion.moveSpeedPerTick, 1.9 / 30);
  const resources = new CombatResources().seal();
  const compiled = compileNormalAction(definition, resources);
  const before = registerUnit(registerUnit(emptyBattle(), guard(0, [2, 2])), hound);
  const after = startAction(before, { sourceUnitId: 1, compiled, tick: 0, mayStart: true }, resources);
  assert.equal(getUnit(after, 0).vitality.hp, 850);
  assert.equal(getUnit(before, 0).vitality.hp, 1000);
  assert.deepEqual(before.events, []);
  assert.ok(after.events.some(event => event.type === 'DAMAGE'));
});

test('crossbow uses explicit windup and arrow speed, then settles damage on contact', () => {
  const resources = new CombatResources();
  const ref = registerArrow(resources);
  const definition = createDefinition(profile('enemy_1003_ncbow'), {
    windupTicks: 1, recoveryTicks: 1, hitRadius: 0.2,
    projectile: { ref, speedPerSecond: 6, contactRadius: 0.1, stopDelayTicks: 0 },
  });
  const compiled = compileNormalAction(definition, resources);
  resources.seal();
  const bow = initialize({ id: 1, position: [2, 3.5], definition });
  const before = registerUnit(registerUnit(emptyBattle(), guard(0, [2, 2], 0)), bow);
  let state = startAction(before, { sourceUnitId: 1, compiled, tick: 0, mayStart: true }, {
    projectileOperations: createProjectileOperations(resources.projectiles, 0),
  });
  assert.equal(state.battlefield.projectiles.size, 0);
  assert.equal(getUnit(state, 0).vitality.hp, 1000);
  state = resumeActionExecution({ ...state, tick: 1 }, {
    executionId: 0, segments: compiled.program, tick: 1,
  }, { projectileOperations: createProjectileOperations(resources.projectiles, 1) }).state;
  assert.equal(state.battlefield.projectiles.size, 1);
  assert.equal(getUnit(state, 0).vitality.hp, 1000);
  for (let tick = 2; tick <= 10; tick++) {
    state = advanceProjectiles({ ...state, tick }, resources, tick, []);
  }
  assert.equal(getUnit(state, 0).vitality.hp, 800);
  assert.ok(state.events.some(event => event.type === 'PROJECTILE_HIT' && event.targetUnitId === 0));
  assert.equal(getUnit(before, 0).vitality.hp, 1000);
  assert.equal(before.battlefield.projectiles.size, 0);
});
