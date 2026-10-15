import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TacticalDemoPresentation } from '../../dist/legacy/tactical-demo-presentation.js';
import { initialize } from '../../dist/core/tactical/unit/initialize.js';
import { spineEntry } from '../../public/js/assets.js';

const data = { lookup() {} };
const unit = (id, definitionId, side = 'ALLY', skill, fields = {}) => initialize({
  id, position: [id + 1, 4], definition: {
    id: definitionId, allegiance: { side }, spatial: { layer: 'GROUND' },
    vitality: { maxHp: 1000 },
    ...(skill === undefined ? {} : { skill: {
      id: skill, activation: 'MANUAL', spRecovery: 'TIME', spCost: 10,
      initialSp: 0, durationTicks: 30,
    } }), ...fields,
  },
});
const snapshot = (units, fields = {}) => ({
  tickIndex: 1, units, blockingRelations: [],
  actions: { instances: [] }, projectiles: { instances: [] }, ...fields,
});
const metadata = new Map([
  ['char_311_mudrok', { kind: 'op', name: '泥岩', spine: 'char_311_mudrok', avatar: 'char_311_mudrok_2', skillIndex: 1,
    animation: { attack: 'Attack', skillAttack: 'Skill_1', skill: 'ATTACK' } }],
  ['char_208_melan', { kind: 'op', name: '玫兰莎', spine: 'char_208_melan', avatar: 'char_208_melan', skillIndex: 0 }],
  ['enemy_1000_gopro', { kind: 'enemy', name: '猎狗', spine: 'enemy_1000_gopro_2', avatar: 'enemy_1000_gopro_2' }],
  ['enemy_1003_ncbow', { kind: 'enemy', name: '弩手', spine: 'enemy_1003_ncbow', avatar: 'enemy_1003_ncbow' }],
]);
const presentation = () => new TacticalDemoPresentation(data, {
  projectileActions: true,
  unitMetadata: unit => metadata.get(unit.definition.id),
});

test('main-mode metadata supplies renderer identity independently of chess configuration', () => {
  const units = [
    unit(0, 'char_311_mudrok', 'ALLY', 'skchr_mudrok_2'),
    unit(1, 'char_208_melan', 'ALLY', 'skcom_atk_up[1]'),
    unit(2, 'enemy_1000_gopro', 'ENEMY'),
    unit(3, 'enemy_1003_ncbow', 'ENEMY'),
    unit(4, 'unknown-device'),
  ];
  const presented = presentation().units(snapshot(units));
  assert.deepEqual(presented.map(({ info }) => [info.kind, info.name, info.spine, info.skillIndex]), [
    ['op', '泥岩', 'char_311_mudrok', 1],
    ['op', '玫兰莎', 'char_208_melan', 0],
    ['enemy', '猎狗', 'enemy_1000_gopro_2', undefined],
    ['enemy', '弩手', 'enemy_1003_ncbow', undefined],
    ['device', 'unknown-device', 'unknown-device', undefined],
  ]);
  assert.equal(presented[0].info.defId, 'char_311_mudrok');
  assert.equal(presented[0].info.avatar, 'char_311_mudrok_2');
  assert.equal(presented[0].tuple[4], 1000);
  const assets = JSON.parse(readFileSync(new URL('../../data/assets.json', import.meta.url)));
  assert.ok(spineEntry(assets, presented[0].info.spine).animations[presented[0].info.animation.skillAttack]);
});

test('death tombstones preserve main-mode metadata after the unit leaves the battlefield', () => {
  const view = presentation();
  const mudrock = unit(0, 'char_311_mudrok', 'ALLY', 'skchr_mudrok_2');
  const after = snapshot([]);
  assert.deepEqual(view.advance(after, [
    { type: 'UNIT_REMOVED', unitId: 0, unit: mudrock, reason: 'DEATH', tick: 0 },
  ]), [['die', 0, 'killed']]);
  const presented = view.units(after)[0];
  assert.equal(presented.info.kind, 'op');
  assert.equal(presented.info.name, '泥岩');
  assert.equal(presented.info.skillIndex, 1);
  assert.equal(presented.tuple[3], 0);
  assert.equal(presented.tuple[8], 4);
});

test('resumable attacks animate once on release and preserve each AoE damage event', () => {
  const view = presentation();
  const during = snapshot([], {
    actions: { instances: [{ source: { id: 0 }, status: 'RUNNING' }] },
  });
  assert.deepEqual(view.advance(during, [
    { type: 'ACTION', sourceUnitId: 0, targetUnitId: 2, tick: 0 },
  ]), []);
  assert.deepEqual(view.advance(snapshot([]), [
    { type: 'ACTION_RELEASED', sourceUnitId: 0, tick: 1 },
    { type: 'DAMAGE', targetUnitId: 2, amount: 100, damageType: 'PHYSICAL', tick: 1 },
    { type: 'DAMAGE', targetUnitId: 3, amount: 100, damageType: 'PHYSICAL', tick: 1 },
    { type: 'ACTION_FINISHED', sourceUnitId: 0, tick: 1 },
  ]), [['atk', 0, 2, 'none'], ['dmg', 2, 100, 'phys'], ['dmg', 3, 100, 'phys']]);
});

test('projectile releases use their trace target and contacts do not repeat the attack animation', () => {
  const view = presentation();
  const released = snapshot([], {
    projectiles: { instances: [{ source: 3, launchedAtTick: 0, traceTarget: 1 }] },
  });
  assert.deepEqual(view.advance(released, [
    { type: 'ACTION', sourceUnitId: 3, targetUnitId: 0, tick: 0 },
    { type: 'ACTION_RELEASED', sourceUnitId: 3, tick: 0 },
    { type: 'ACTION_FINISHED', sourceUnitId: 3, tick: 0 },
  ]), [['atk', 3, 1, 'none']]);
  assert.deepEqual(view.advance(snapshot([]), [
    { type: 'PROJECTILE_HIT', sourceUnitId: 3, targetUnitId: 1, tick: 1 },
    { type: 'DAMAGE', targetUnitId: 1, amount: 80, damageType: 'PHYSICAL', tick: 1 },
  ]), [['dmg', 1, 80, 'phys']]);
});

test('immediate melee actions do not wait for a release marker they never produce', () => {
  const view = presentation();
  assert.deepEqual(view.advance(snapshot([]), [
    { type: 'ACTION', sourceUnitId: 0, targetUnitId: 2, tick: 0 },
    { type: 'DAMAGE', targetUnitId: 2, amount: 100, damageType: 'PHYSICAL', tick: 0 },
    { type: 'ACTION_FINISHED', sourceUnitId: 0, tick: 0 },
  ]), [['atk', 0, 2, 'none'], ['dmg', 2, 100, 'phys']]);
});

test('an attack skill projects one skill attack without a toggle that interrupts its animation', () => {
  const animation = { skill: 'ATTACK', attack: 'Attack', skillAttack: 'Skill_1' };
  const view = new TacticalDemoPresentation(data, {
    projectileActions: true,
    unitMetadata: unit => ({ ...metadata.get(unit.definition.id), animation }),
  });
  const mudrock = unit(0, 'char_311_mudrok', 'ALLY', 'skchr_mudrok_2');
  const after = snapshot([mudrock]);
  assert.deepEqual(view.advance(after, [
    { type: 'SKILL_ACTIVATED', unitId: 0, tick: 0 },
    { type: 'ACTION', sourceUnitId: 0, targetUnitId: 2, tick: 0 },
    { type: 'ACTION_RELEASED', sourceUnitId: 0, tick: 0 },
    { type: 'DAMAGE', targetUnitId: 2, amount: 100, damageType: 'PHYSICAL', tick: 0 },
    { type: 'SKILL_FINISHED', unitId: 0, tick: 0 },
    { type: 'ACTION_FINISHED', sourceUnitId: 0, tick: 0 },
  ]), [['atk', 0, 2, 'none', { skill: true }], ['dmg', 2, 100, 'phys']]);
  assert.strictEqual(view.units(after)[0].info.animation, animation);
  assert.deepEqual(view.advance(after, [
    { type: 'ACTION', sourceUnitId: 0, targetUnitId: 2, tick: 1 },
    { type: 'ACTION_FINISHED', sourceUnitId: 0, tick: 1 },
  ]), [['atk', 0, 2, 'none']]);

  const active = { ...mudrock, skill: { ...mudrock.skill,
    active: { id: 0, startedAtTick: 0, endsAtTick: null }, nextActivationId: 1,
  } };
  const presented = view.units(snapshot([active], { tickIndex: 2 }))[0];
  assert.equal(presented.info.skillActive, false);
  assert.equal(presented.tuple[7] & 16, 0);
});

test('a buff skill keeps its status but only actual actions project attack events', () => {
  const view = new TacticalDemoPresentation(data, {
    projectileActions: true,
    unitMetadata: unit => ({ ...metadata.get(unit.definition.id), animation: { skill: 'BUFF' } }),
  });
  const melantha = unit(1, 'char_208_melan', 'ALLY', 'skcom_atk_up[1]');
  const active = { ...melantha, skill: { ...melantha.skill,
    active: { id: 0, startedAtTick: 0, endsAtTick: 30 }, nextActivationId: 1,
  } };
  const after = snapshot([active]);
  assert.deepEqual(view.advance(after, [
    { type: 'SKILL_ACTIVATED', unitId: 1, tick: 0 },
  ]), [['skill', 1, true]]);
  const presented = view.units(after)[0];
  assert.equal(presented.info.skillActive, true);
  assert.equal(presented.tuple[7] & 16, 16);
  assert.deepEqual(view.advance(after, []), []);
  assert.deepEqual(view.advance(after, [
    { type: 'ACTION', sourceUnitId: 1, targetUnitId: 2, tick: 1 },
    { type: 'ACTION_FINISHED', sourceUnitId: 1, tick: 1 },
  ]), [['atk', 1, 2, 'none']]);
});

test('walk animation follows position changes rather than a stale locomotion moving flag', () => {
  const view = presentation();
  const crossbowman = unit(3, 'enemy_1003_ncbow', 'ENEMY', undefined, {
    locomotion: {
      moveSpeedPerTick: 0.02,
      steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
    },
  });
  const moving = { ...crossbowman, locomotion: { ...crossbowman.locomotion, moving: true } };
  const before = snapshot([crossbowman], { tickIndex: 1 });
  assert.equal(view.units(before)[0].tuple[8], 0);
  const walked = { ...moving, position: [moving.position[0] + 0.02, moving.position[1]] };
  const movingSnapshot = snapshot([walked], { tickIndex: 2 });
  assert.equal(view.units(movingSnapshot)[0].tuple[8], 1);
  assert.equal(view.units(movingSnapshot)[0].tuple[8], 1);
  const waiting = snapshot([walked], {
    tickIndex: 3,
    actions: { instances: [{ source: { id: 3 }, status: 'RUNNING', state: { releaseAtTick: 9 } }] },
  });
  assert.equal(view.units(waiting)[0].tuple[8], 0);
  assert.equal(walked.locomotion.moving, true);
  assert.deepEqual(before.units[0].position, crossbowman.position);
  const spawned = { ...moving, id: 4 };
  assert.equal(view.units(snapshot([walked, spawned], { tickIndex: 4 }))[1].tuple[8], 1);
});
