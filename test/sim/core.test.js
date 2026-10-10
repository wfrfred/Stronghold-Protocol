import { createActionState } from "../../dist/core/tactical/unit/capability/action/capability.js";
// Sim core: rng, grid/pathing, damage formulas, stat aggregation, buffs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRng } from '../../server/sim/rng.js';
import { Grid } from '../../server/sim/grid.js';
import { mitigate } from '../../server/sim/damage.js';
import { Unit } from '../../server/sim/units.js';
import { getDefaultSource, hasGeneratedData } from '../../server/sim/simdata.js';
import { makeBattle, flatStage, chessRec, enemyRec } from '../helpers/battleHarness.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createBattlefieldRuntime } from '../../dist/core/tactical/battlefield/runtime.js';
import { createMechanismDefinition } from '../../dist/core/tactical/battlefield/mechanism.js';
import { createNavigationModifierDefinition, createNavigationModifier } from '../../dist/core/tactical/battlefield/navigation/modifier.js';
import { hasSpatialPresence, isSpatiallyPresent } from '../../dist/core/tactical/unit/capability/presence.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { initializeOffenseState } from '../../dist/core/tactical/unit/capability/offense/capability.js';
import { copyUnitSnapshot } from '../../dist/core/tactical/unit/snapshot.js';
import { hasVitality, initializeVitalityState } from '../../dist/core/tactical/unit/capability/vitality/capability.js';
import { createActionCapabilityDefinition, hasAction } from '../../dist/core/tactical/unit/capability/action/capability.js';
import { hasAllegiance } from '../../dist/core/tactical/unit/capability/allegiance.js';
import { createBlockerDefinition, hasBlockable, hasBlocker, resolveBlockingCapacity } from '../../dist/core/tactical/unit/capability/blocking/capability.js';
import * as contribution from '../../dist/core/tactical/modifier/contribution.js';
import * as modifier from '../../dist/core/tactical/modifier/value.js';
import { createHitDefinition, createSpatialDefinition, hasHit, hasSpatial } from '../../dist/core/tactical/unit/capability/spatial.js';
import { addStatusContribution, copyStatusState, createStatusDefinition, deriveEffectiveStatusFlags, hasStatus, initializeStatusState, removeStatusContribution } from '../../dist/core/tactical/unit/capability/status/capability.js';
import { createBlockGeometry, createRangeGeometry, createShapeGeometry } from '../../dist/core/tactical/geometry/shape.js';
import { geometryContainsPosition, rangeContainsPosition, rangeOverlapsHit } from '../../dist/core/tactical/geometry/intersection.js';
import { updateBlockingRelations } from '../../dist/core/tactical/battlefield/blocking/relations.js';
import { projectUnitsByTile } from '../../dist/core/tactical/battlefield/storage/indexes.js';
import { createLocomotionState, createRoutedLocomotionState, hasLocomotion, hasRoutedLocomotion } from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import { createRouteDefinition } from '../../dist/core/tactical/unit/capability/locomotion/route/definition.js';
import { createRouteState, createRouteTiming } from '../../dist/core/tactical/unit/capability/locomotion/route/state.js';
import { createNavigationState } from '../../dist/core/tactical/battlefield/navigation/state.js';
import { createUnitPlacementDefinition, instantiateUnitPlacement } from '../../dist/core/tactical/battle/creation/placement.js';
import { createDeploymentProfile, createTileBindingDefinition } from '../../dist/core/tactical/unit/capability/deployment.js';
import { createOccupancyState } from '../../dist/core/tactical/unit/capability/occupancy.js';
import { evaluateDeployment } from '../../dist/core/tactical/battlefield/deployment/query.js';

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('rng is deterministic and in [0,1)', () => {
  const a = createRng(123), b = createRng(123), c = createRng(124);
  const xs = Array.from({ length: 50 }, () => a());
  const ys = Array.from({ length: 50 }, () => b());
  assert.deepEqual(xs, ys);
  assert.notDeepEqual(xs, Array.from({ length: 50 }, () => c()));
  for (const x of xs) assert.ok(x >= 0 && x < 1);
  const r = createRng(5);
  for (let i = 0; i < 200; i++) { const v = r.int(7); assert.ok(Number.isInteger(v) && v >= 0 && v < 7); }
});

test('grid: 8-dir A* without corner cutting matches helper path lengths on real stages', () => {
  const ds = getDefaultSource();
  for (const id of ['act2autochess_m01', 'act2autochess_m02', 'act1autochess_m03']) {
    const st = ds.getStage(id);
    const g = new Grid(st, { r0: 9, r1: 12, c0: 0, c1: 10 });
    const helper = st.raw.groundPaths?.['9,10->9,2'] ?? st.raw.groundPathsHelper?.paths?.['9,10->9,2'];
    const p = g.findPath(9, 10, 9, 2);
    assert.ok(p, `path on ${id}`);
    assert.deepEqual(p[0], [9, 10]);
    assert.deepEqual(p[p.length - 1], [9, 2]);
    if (helper) approx(Grid.pathLength(p), Grid.pathLength(helper), 1e-6);
    // no corner cutting: every diagonal step has both orthogonals passable
    for (let i = 1; i < p.length; i++) {
      const [r0, c0] = p[i - 1], [r1, c1] = p[i];
      assert.ok(Math.abs(r1 - r0) <= 1 && Math.abs(c1 - c0) <= 1);
      if (r1 !== r0 && c1 !== c0) {
        assert.ok(g.groundPassable(r0, c1) || (r0 === 9 && c1 === 2));
        assert.ok(g.groundPassable(r1, c0) || (r1 === 9 && c0 === 2));
      }
    }
  }
});

test('grid: obstacles re-route and bump version; blocked entirely ⇒ null unless ignoreObstacles', () => {
  const g = new Grid(flatStage(), { r0: 9, r1: 12, c0: 0, c1: 10 });
  const direct = g.findPath(9, 10, 9, 2);
  assert.equal(direct.length, 9);
  const v0 = g.version;
  g.setObstacle(9, 6, true);
  assert.ok(g.version > v0);
  const around = g.findPath(9, 10, 9, 2);
  assert.ok(!around.some(([r, c]) => r === 9 && c === 6));
  for (let r = 9; r <= 12; r++) g.setObstacle(r, 6, true);
  assert.equal(g.findPath(9, 10, 9, 2), null);
  assert.ok(g.findPath(9, 10, 9, 2, { ignoreObstacles: true }));
});

test('damage formulas: phys/arts/true, ignore, 5% floor', () => {
  approx(mitigate(1000, 'phys', { def: 300 }), 700);
  approx(mitigate(1000, 'phys', { def: 2000 }), 50);
  approx(mitigate(1000, 'phys', { def: 300 }, { defIgnorePct: 0.5, defIgnoreFlat: 50 }), 900);
  approx(mitigate(1000, 'arts', { res: 30 }), 700);
  approx(mitigate(1000, 'arts', { res: 100 }), 50);
  approx(mitigate(1000, 'arts', { res: 40 }, { resIgnorePct: 0.5, resIgnoreFlat: 10 }), 900);
  approx(mitigate(1000, 'true', { def: 9999, res: 100 }), 1000);
});

test('dealDamage applies multipliers, shields and records stats', () => {
  const h = makeBattle({
    defs: { chess: { t_a: chessRec({ id: 't_a', stats: { atk: 1000 } }) }, enemies: { enemy_dummy: enemyRec({ key: 'enemy_dummy', hp: 100000, def: 200, res: 50, speed: 0 }) } },
    units: [{ chessId: 't_a', row: 9, col: 3 }],
    enemies: [{ key: 'enemy_dummy', pos: [11, 8] }],
    content: 'none',
  });
  h.step();
  const op = h.unit('t_a');
  const e = h.enemy('enemy_dummy');
  op.markDirty();
  h.b.addBuff(op, { key: 'dd', mods: { dmgDealtMul: 1.5 } });
  h.b.addBuff(e, { key: 'fr', mods: { dmgTakenMul: 1.2, artsTakenMul: 2 } });
  const hp0 = e.hp;
  const d1 = h.b.dealDamage(op, e, { amount: 1000, type: 'phys' });
  approx(d1, (1000 - 200) * 1.5 * 1.2);
  const d2 = h.b.dealDamage(op, e, { amount: 1000, type: 'arts' });
  approx(d2, 1000 * 0.5 * 1.5 * 1.2 * 2);
  approx(e.hp, hp0 - d1 - d2);
  // shield absorbs
  h.b.addBuff(e, { key: 'sh', shield: 500 });
  const d3 = h.b.dealDamage(null, e, { amount: 300, type: 'true' });
  assert.equal(d3, 0);
  const d4 = h.b.dealDamage(null, e, { amount: 300, type: 'true' });
  approx(d4, 360 - (500 - 360)); // 300×1.2 per hit; the shield absorbed 360 of 500 on the first hit
  assert.equal(e.findBuff('sh'), null, 'depleted shield removed');
  // hit-negating barrier
  h.b.addBuff(e, { key: 'barrier', shieldHits: 1 });
  assert.equal(h.b.dealDamage(null, e, { amount: 5000, type: 'true' }), 0);
  assert.ok(h.b.dealDamage(null, e, { amount: 10, type: 'true' }) > 0);
  assert.ok(op.stats.dmg > 0);
  assert.ok(h.result().perPlayer.p1.damageDealt >= d1 + d2);
});

test('dodge uses the seeded rng and is deterministic', () => {
  const run = (seed) => {
    const h = makeBattle({ seed, defs: { enemies: { enemy_dummy: enemyRec({ key: 'enemy_dummy', hp: 1e7, speed: 0 }) } }, enemies: [{ key: 'enemy_dummy', pos: [11, 8] }], content: 'none' });
    h.step();
    const e = h.enemy('enemy_dummy');
    h.b.addBuff(e, { key: 'dodge', mods: { dodgePhys: 0.5 } });
    let hits = 0;
    for (let i = 0; i < 400; i++) if (h.b.dealDamage(null, e, { amount: 100, type: 'phys' }) > 0) hits++;
    assert.equal(h.b.dealDamage(null, e, { amount: 100, type: 'phys', canDodge: false }) > 0, true);
    return hits;
  };
  const a = run(9);
  assert.equal(a, run(9));
  assert.ok(a > 150 && a < 250, `~50% hits (${a})`);
});

test('stat aggregation: (base+flat)(1+pct)Πmul, res clamp, aspd clamp, interval, HP ratio kept', () => {
  const u = new Unit({ id: 1, side: 'ally', kind: 'op', base: { maxHp: 1000, atk: 100, def: 50, res: 20, aspd: 100, bat: 1.2 } });
  u.alive = true;
  u.hp = 500;
  u.buffs.push({ key: 'a', stacks: 1, mods: { atkFlat: 50, atkPct: 0.5, atkMul: 1.2, hpPct: 1, resFlat: 200, aspd: 30, batPct: -0.25 } });
  u.buffs.push({ key: 'b', stacks: 2, mods: { atkPct: 0.1, atkMul: 1.1 } });
  u.markDirty();
  const s = u.s;
  approx(s.atk, (100 + 50) * (1 + 0.5 + 0.2) * 1.2 * 1.1 * 1.1);
  assert.equal(s.res, 100);
  assert.equal(s.aspd, 130);
  approx(s.interval, 1.2 * 0.75 * 100 / 130);
  approx(s.maxHp, 2000);
  approx(u.hp, 1000, 1e-6);
  u.buffs.push({ key: 'c', stacks: 1, mods: { aspd: -500 } });
  u.markDirty();
  assert.equal(u.s.aspd, 20, 'ASPD floor 20 (PRTS 数值范围)');
});

test('buffs: replace / extend / stack / independent / keep, expiry and onExpire', () => {
  const h = makeBattle({ defs: { chess: { t_a: chessRec({ id: 't_a' }) } }, units: [{ chessId: 't_a', row: 9, col: 3 }], content: 'none' });
  h.step();
  const u = h.unit('t_a');
  const b = h.b;
  b.addBuff(u, { key: 'r', duration: 2, mods: { atkPct: 0.1 } });
  b.addBuff(u, { key: 'r', duration: 1, mods: { atkPct: 0.3 } });
  assert.equal(u.buffs.filter((x) => x.key === 'r').length, 1);
  approx(u.findBuff('r').timeLeft, 1);
  b.addBuff(u, { key: 'e', duration: 5, refresh: 'extend', mods: { defPct: 0.1 } });
  b.addBuff(u, { key: 'e', duration: 2, refresh: 'extend', mods: { defPct: 0.2 } });
  approx(u.findBuff('e').timeLeft, 5);
  assert.equal(u.findBuff('e').mods.defPct, 0.2);
  for (let i = 0; i < 5; i++) b.addBuff(u, { key: 's', duration: 3, refresh: 'stack', maxStacks: 3, mods: { aspd: 10 } });
  assert.equal(u.findBuff('s').stacks, 3);
  assert.equal(u.s.aspd, 130);
  for (let i = 0; i < 4; i++) b.addBuff(u, { key: 'i', duration: 1 + i, refresh: 'independent', maxStacks: 3, mods: { atkFlat: 1 } });
  assert.equal(u.buffs.filter((x) => x.key === 'i').length, 3);
  b.addBuff(u, { key: 'k', duration: 1, refresh: 'keep', mods: { atkFlat: 5 } });
  b.addBuff(u, { key: 'k', duration: 9, refresh: 'keep', mods: { atkFlat: 50 } });
  assert.equal(u.findBuff('k').mods.atkFlat, 5);
  let expired = 0;
  b.addBuff(u, { key: 'x', duration: 0.5, onExpire: () => expired++ });
  h.run(0.6);
  assert.equal(expired, 1);
  assert.equal(u.findBuff('x'), null);
  assert.ok(u.findBuff('r'), '1 s buff still alive at 0.6 s');
  h.run(3);
  assert.equal(u.findBuff('r'), null, '1 s buff expired');
  assert.equal(u.findBuff('s'), null);
  assert.ok(u.findBuff('e'));
  // interval ticks
  let ticks = 0;
  b.addBuff(u, { key: 'dot', duration: 3, interval: 1, onTick: () => ticks++ });
  h.run(3.05);
  assert.equal(ticks, 3);
});

test('persistent buffs survive death; others are cleared', () => {
  const h = makeBattle({ defs: { chess: { t_a: chessRec({ id: 't_a', stats: { respawnTime: 1, cost: 0 } }) } }, units: [{ chessId: 't_a', row: 9, col: 3 }], content: 'none' });
  h.step();
  const u = h.unit('t_a');
  h.b.addBuff(u, { key: 'keepme', persist: true, mods: { atkPct: 1 } });
  h.b.addBuff(u, { key: 'loseme', mods: { atkPct: 1 } });
  h.b.dealDamage(null, u, { amount: 1e9, type: 'true' });
  assert.equal(u.alive, false);
  assert.ok(u.findBuff('keepme'));
  assert.equal(u.findBuff('loseme'), null);
  h.run(1.5);
  assert.equal(u.alive, true, 'redeployed');
  approx(u.s.atk, 500 * 2);
});

test('simdata normalises real chess, enemy, token, stage and routes', () => {
  assert.ok(hasGeneratedData(), 'tests run against the generated data/*.json');
  const ds = getDefaultSource();
  const c = ds.getChess('chess_char_1_01_a');
  assert.equal(c.subProf, 'fastshot');
  assert.ok(c.skill && c.skill.spCost > 0);
  assert.ok(c.rangeGrid.length > 3);
  const e = ds.getEnemy('enemy_1427_lrnazg');
  assert.ok(e.maxHp > 0 && e.rangeRadius > 0);
  const e2 = ds.getEnemy('1427_lrnazg');
  assert.equal(e2.key, 'enemy_1427_lrnazg');
  const st = ds.getStage('act2autochess_m01');
  assert.equal(st.rows.length, 19);
  assert.equal(st.rows[9][2], 'E');
});

const presenceBattlefield = () => createBattlefieldRuntime({
  map: createBattlefieldMap(1, 5, Array.from({ length: 5 }, () => ({
    heightType: 'LOWLAND', buildableType: 'MELEE', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
  }))),
});

const presenceUnit = (id, position) => ({
  id, definition: Object.freeze({ id: `presence_${id}`, vitality: Object.freeze({ maxHp: 100 }) }), position: Object.freeze(position),
  vitality: initializeVitalityState({maxHp:100}), spatialPresence: { present: true },
});

const presenceNavigationModifier = (id, source, region, costFloor = 1000) => createNavigationModifier({
  id, source, region,
  definition: createNavigationModifierDefinition({
    id: `presence_effect_${id}`, WALK: { denyPassage: false, deniedDepartures: [], costFloor }, FLY: null,
  }),
  active: true, expiresAtTick: null,
});

test('core spatial presence keeps unit identity and isolates state while removing only spatial membership', () => {
  const runtime = presenceBattlefield();
  const unit = presenceUnit(1, [2, 0]);
  const bare = { id: 2, definition: Object.freeze({ id: 'bare' }), position: Object.freeze([2, 0]) };
  assert.equal(hasSpatialPresence(unit), true);
  assert.equal(hasSpatialPresence(bare), false);
  assert.equal(isSpatiallyPresent(bare), true);
  runtime.advance([{ type: 'REGISTER_UNIT', unit }, { type: 'REGISTER_UNIT', unit: bare }]);
  const baseline = runtime.snapshot('draft').navigationMaps;
  const hidden = copyUnitSnapshot(runtime.snapshot('draft').getUnit(1));
  hidden.spatialPresence.present = false;
  assert.equal(runtime.snapshot('draft').getUnit(1).spatialPresence.present, true);
  const result = runtime.advance([{ type: 'UPDATE_UNIT', unit: hidden }]);
  assert.deepEqual(result.removedUnits, []);
  assert.deepEqual(runtime.snapshot('draft').unitIds, [1, 2]);
  assert.deepEqual(runtime.snapshot('draft').unitsAt([0, 2]).map(unit => unit.id), [2]);
  assert.equal(runtime.snapshot('draft').getUnit(1).definition, hidden.definition);
  assert.equal(runtime.snapshot('draft').getUnit(1).vitality.hp, 100);
  assert.equal(runtime.snapshot('draft').navigationMaps, baseline);
  const restored = copyUnitSnapshot(runtime.snapshot('draft').getUnit(1));
  restored.spatialPresence.present = true;
  assert.equal(runtime.snapshot('draft').getUnit(1).spatialPresence.present, false);
  runtime.advance([{ type: 'UPDATE_UNIT', unit: restored }]);
  assert.deepEqual(runtime.snapshot('draft').unitsAt([0, 2]).map(unit => unit.id), [1, 2]);
});

test('core removal facts share the latest unit while updates preserve retained battlefield snapshots', () => {
  const runtime = presenceBattlefield();
  const unit = presenceUnit(1, [2, 0]);
  runtime.advance([{ type: 'REGISTER_UNIT', unit }]);
  const retained = runtime.snapshot('draft');
  const snapshot = copyUnitSnapshot(runtime.snapshot('draft').getUnit(1));
  snapshot.vitality.hp = 0;
  snapshot.spatialPresence.present = false;
  assert.deepEqual(retained.getUnit(1), unit);
  assert.equal(unit.vitality.hp, 100);
  assert.equal(unit.spatialPresence.present, true);
  const updated = { ...runtime.snapshot('draft').getUnit(1), position: [3, 0], vitality: {...runtime.snapshot('draft').getUnit(1).vitality, hp: 20} };
  const removed = runtime.advance([
    { type: 'UPDATE_UNIT', unit: updated },
    { type: 'REMOVE_UNIT', unitId: 1, reason: 'DEATH' },
  ]);
  assert.deepEqual(removed.removedUnits, [{ unitId: 1, reason: 'DEATH', unit: {
    ...updated, position: Object.freeze([3, 0]),
  } }]);
  assert.equal(removed.removedUnits[0].unit.definition, unit.definition);
  assert.equal(removed.removedUnits[0].unit, updated);
  assert.deepEqual(runtime.snapshot('draft').unitIds, []);
  assert.equal(retained.getUnit(1), unit);
  assert.equal(removed.removedUnits[0].unit.vitality.hp, 20);
});

test('core hidden navigation modifier sources and anchors suspend contributions without removing effects', () => {
  const runtime = presenceBattlefield();
  const source = presenceUnit(1, [0, 0]), anchor = presenceUnit(2, [2, 0]);
  const bare = { id: 3, definition: Object.freeze({ id: 'bare' }), position: Object.freeze([4, 0]) };
  const fixed = position => ({ type: 'FIXED', position, range: [[0, 0]], direction: 'RIGHT' });
  runtime.advance([
    { type: 'REGISTER_UNIT', unit: source }, { type: 'REGISTER_UNIT', unit: anchor },
    { type: 'REGISTER_UNIT', unit: bare },
    { type: 'REGISTER_MECHANISM', mechanism: { id: 1, definition: createMechanismDefinition({ id: 'presence_mechanism' }), active: true } },
    { type: 'ADD_NAVIGATION_MODIFIER', navigationModifier: presenceNavigationModifier(1, { type: 'UNIT', unitId: 1 }, fixed([0, 1])) },
    { type: 'ADD_NAVIGATION_MODIFIER', navigationModifier: presenceNavigationModifier(2, { type: 'MECHANISM', mechanismId: 1 },
      { type: 'FOLLOW_UNIT', unitId: 2, range: [[0, 0]], direction: 'RIGHT' }) },
    { type: 'ADD_NAVIGATION_MODIFIER', navigationModifier: presenceNavigationModifier(3, { type: 'UNIT', unitId: 3 }, fixed([0, 4]), 2000) },
  ]);
  const fly = runtime.snapshot('draft').navigationMaps.FLY;
  assert.deepEqual(runtime.snapshot('draft').navigationMaps.WALK.cells.map(cell => cell.moveCost), [1, 1000, 1000, 1, 2000]);
  const hiddenSource = { ...source, spatialPresence: { present: false } };
  const hiddenAnchor = { ...anchor, spatialPresence: { present: false } };
  const hidden = runtime.advance([{ type: 'UPDATE_UNIT', unit: hiddenSource }, { type: 'UPDATE_UNIT', unit: hiddenAnchor }]);
  assert.deepEqual(hidden.removedNavigationModifiers, []);
  assert.deepEqual(hidden.changedNavigationModes, ['WALK']);
  assert.deepEqual(runtime.snapshot('draft').navigationModifierIds, [1, 2, 3]);
  assert.equal(runtime.snapshot('draft').getNavigationModifier(1).active, true);
  assert.deepEqual(runtime.snapshot('draft').navigationModifiersFrom({ type: 'UNIT', unitId: 1 }), [1]);
  assert.deepEqual(runtime.snapshot('draft').navigationModifiersFollowing(2), [2]);
  assert.deepEqual(runtime.snapshot('draft').navigationModifiersAt([0, 1]), []);
  assert.deepEqual(runtime.snapshot('draft').navigationModifiersAt([0, 2]), []);
  assert.deepEqual(runtime.snapshot('draft').navigationMaps.WALK.cells.map(cell => cell.moveCost), [1, 1, 1, 1, 2000]);
  const dormant = runtime.snapshot('draft').navigationMaps;
  runtime.advance([{ type: 'SET_POSITION_AND_RELEASE_BLOCKING', unitId: 2, position: Object.freeze([3, 0]) }]);
  assert.equal(runtime.snapshot('draft').navigationMaps, dormant);
  assert.deepEqual(runtime.snapshot('draft').unitsAt([0, 3]), []);
  const movedAnchor = copyUnitSnapshot(runtime.snapshot('draft').getUnit(2));
  movedAnchor.spatialPresence.present = true;
  runtime.advance([{ type: 'UPDATE_UNIT', unit: source }, { type: 'UPDATE_UNIT', unit: movedAnchor }]);
  assert.deepEqual(runtime.snapshot('draft').navigationModifiersAt([0, 3]), [2]);
  assert.deepEqual(runtime.snapshot('draft').unitsAt([0, 3]).map(unit => unit.id), [2]);
  assert.deepEqual(runtime.snapshot('draft').navigationMaps.WALK.cells.map(cell => cell.moveCost), [1, 1000, 1, 1000, 2000]);
  assert.equal(runtime.snapshot('draft').navigationMaps.FLY, fly);
  runtime.advance([{ type: 'SET_MECHANISM_ACTIVE', mechanismId: 1, active: false }]);
  const inactive = runtime.snapshot('draft').navigationMaps;
  runtime.advance([{ type: 'UPDATE_UNIT', unit: { ...movedAnchor, spatialPresence: { present: false } } }]);
  runtime.advance([{ type: 'UPDATE_UNIT', unit: movedAnchor }]);
  assert.equal(runtime.snapshot('draft').navigationMaps, inactive);
  assert.deepEqual(runtime.snapshot('draft').navigationModifiersAt([0, 3]), []);
});

test('core failed presence updates restore spatial membership and projected maps atomically', () => {
  const runtime = presenceBattlefield();
  const unit = presenceUnit(1, [2, 0]);
  runtime.advance([
    { type: 'REGISTER_UNIT', unit },
    { type: 'ADD_NAVIGATION_MODIFIER', navigationModifier: presenceNavigationModifier(1, { type: 'UNIT', unitId: 1 },
      { type: 'FOLLOW_UNIT', unitId: 1, range: [[0, 0]], direction: 'RIGHT' }) },
  ]);
  runtime.apply();
  const maps = runtime.snapshot('draft').navigationMaps;
  assert.throws(() => {
    try {
      const hidden = copyUnitSnapshot(runtime.snapshot('draft').getUnit(1));
      hidden.spatialPresence.present = false;
      runtime.advance([{ type: 'UPDATE_UNIT', unit: hidden }]);
      assert.deepEqual(runtime.snapshot('draft').unitsAt([0, 2]), []);
      assert.deepEqual(runtime.snapshot('draft').navigationModifiersAt([0, 2]), []);
      assert.notEqual(runtime.snapshot('draft').navigationMaps, maps);
      throw new Error('abort presence');
    } finally {
      runtime.drop();
    }
  }, /abort presence/);
  assert.equal(runtime.snapshot('draft').navigationMaps, maps);
  assert.equal(runtime.snapshot('draft').getUnit(1).spatialPresence.present, true);
  assert.deepEqual(runtime.snapshot('draft').unitsAt([0, 2]).map(unit => unit.id), [1]);
  assert.deepEqual(runtime.snapshot('draft').navigationModifiersAt([0, 2]), [1]);
});

test('core placement owns and initializes occupancy through capability states', () => {
  const states = { occupancy: { claims: [{ position: [0, 1], slot: 'DEPLOYMENT', type: 'RESERVATION' }] } };
  const placement = { definition: { id: 'placement' }, position: [0, 0], states };
  const execution = { rngState: 1, nextUnitId: 0, nextNavigationRequestId: 0, nextMechanismId: 0, nextNavigationModifierId: 0, nextProjectileId: 0 };
  const direct = instantiateUnitPlacement(placement, execution, 0).unit;
  const normalized = createUnitPlacementDefinition(placement);
  states.occupancy.claims[0].position[1] = 2;
  assert.equal(direct.occupancy.claims[0].position[1], 1);
  assert.equal(instantiateUnitPlacement(normalized, execution, 0).unit.occupancy.claims[0].position[1], 1);
});

const catalogDefinition = () => Object.freeze({
  id: 'catalog_unit',
  vitality: Object.freeze({ maxHp: 100 }),
  locomotion: Object.freeze({
    moveSpeedPerTick: 0.1,
    steeringParameters: Object.freeze({ steeringFactor: 1, maxSteeringForce: 100 }),
  }),
  allegiance: Object.freeze({ side: 'ALLY' }),
  action: createActionCapabilityDefinition({ normalAction: {
    triggerBindingId: 'primary',
    baseAttackTimeTicks: 3, recoveryTicks: 0, followUps: [],
    targetGroups: [{ id: 'primary',
      operations: [{ type: 'DAMAGE', power: 10, damageType: 'PHYSICAL' }],
      targeting: { type: 'DAMAGE', scope: { type: 'RANGE', geometry: {
        type: 'SHAPES', geometry: { shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 1 }] },
      } }, canTargetAir: false, includeBlockingRelations: false, preferBlockingRelations: false,
        ignoreTargetFree: false, ignoreInvisible: false, maxTargets: 1 },
    }],
  } }),
  spatial: createSpatialDefinition({ layer: 'GROUND' }),
  hit: createHitDefinition({ geometry: { shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 0.25 }] } }),
  status: createStatusDefinition({ initialFlags: ['HEAL_FREE'] }),
  blocker: createBlockerDefinition({ capacity: 2, geometry: { radius: 0.7 } }),
  blockable: Object.freeze({ weight: 1 }),
  defense: Object.freeze({ defense: 20, resistance: 10 }),
});

function catalogRoutedState() {
  const definition = createRouteDefinition({
    pathMotionMode: 'WALK', startPosition: [0, 0], endPosition: [0, 4],
    spawnOffset: [0, 0], spawnRandomRange: [0, 0],
    checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: 10 }],
    allowDiagonalMove: false, visitEveryTileCenter: false,
    visitEveryNodeCenter: false, visitEveryCheckPoint: false,
  });
  const route = createRouteState(definition,
    createRouteTiming({ waveStartedAtTick: 0, fragmentStartedAtTick: 0 }), true);
  route.progress = { phase: 'CHECKPOINTS', checkpointIndex: 0,
    checkpoint: { type: 'WAIT', remainingTicks: 9 } };
  const locomotion = createRoutedLocomotionState({ route, navigation: createNavigationState('WALK', [0, 0]) });
  locomotion.alternativeRoute = locomotion.mainRoute;
  return locomotion;
}

test('core unit initialization uses prepared states and separates configuration from runtime-only capabilities', () => {
  const definition = catalogDefinition();
  const vitality = {...initializeVitalityState(definition.vitality), hp: 25};
  const action = { ...createActionState(), readyAtTick: 9, recoveryUntilTick: 10 };
  const locomotion = catalogRoutedState();
  const unit = initializeUnit({ id: 1, definition, position: [2, 0], tick: 17,
    states: { vitality, action, locomotion, spatialPresence: { present: false } } });

  assert.equal(unit.definition, definition);
  assert.deepEqual(unit.vitality, vitality);
  assert.deepEqual(unit.action, action);
  assert.equal(hasRoutedLocomotion(unit), true);
  assert.equal(unit.locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 9);
  assert.equal(unit.spatialPresence.present, false);
  assert.equal(Object.hasOwn(unit, 'defense'), true);
  assert.deepEqual(unit.blocker, { capacity: contribution.create(), geometry: { radius: 0.7 }, enabled: true });
  assert.equal(resolveBlockingCapacity(unit.definition.blocker, unit.blocker), 2);
  assert.deepEqual(unit.blockable, { weight: 1, enabled: true });

  vitality.hp = 0;
  action.readyAtTick = 99;
  locomotion.mainRoute.route.progress.checkpoint.remainingTicks = 0;
  assert.equal(unit.vitality.hp, 25);
  assert.equal(unit.action.readyAtTick, 9);
  assert.equal(unit.locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 9);
  assert.equal(initializeUnit({ id: 2, definition, position: [0, 0], tick: 17 }).action.readyAtTick, 17);

  const bare = initializeUnit({ id: 3, definition: Object.freeze({ id: 'presence_only' }),
    position: [0, 0], states: { spatialPresence: { present: false } } });
  assert.equal(hasSpatialPresence(bare), true);
  assert.equal(hasVitality(bare), false);
  assert.throws(() => initializeUnit({ id: 4, definition: { id: 'bare' }, position: [0, 0],
    states: { locomotion: createLocomotionState() } }));
});

test('core definitions acquire immutable ownership once and snapshots share it', () => {
  for (const shallowFrozen of [false, true]) {
    const definition = { id: 'owned-definition', vitality: { maxHp: 100 }, metadata: { labels: ['a'] } };
    if (shallowFrozen) Object.freeze(definition);
    const unit = initializeUnit({ id: 1, definition, position: [0, 0] });
    definition.vitality.maxHp = 999;
    definition.metadata.labels.push('changed');
    assert.equal(unit.definition.vitality.maxHp, 100);
    assert.deepEqual(unit.definition.metadata.labels, ['a']);
    const snapshot = copyUnitSnapshot(unit);
    assert.equal(snapshot.definition, unit.definition);
    assert.throws(() => { snapshot.definition.vitality.maxHp = 0; }, TypeError);
    assert.throws(() => snapshot.definition.metadata.labels.push('x'), TypeError);
    const another = initializeUnit({ id: 2, definition, position: [0, 0] });
    assert.equal(another.definition.vitality.maxHp, 999);
  }
  const definition = Object.freeze({ id: 'already-owned', metadata: Object.freeze({ labels: Object.freeze(['a']) }) });
  assert.equal(initializeUnit({ id: 1, definition, position: [0, 0] }).definition, definition);
  assert.throws(() => initializeUnit({ id: 1, definition: { id: 'behavior', run: () => {} }, position: [0, 0] }), /data-only/);
  let reads = 0;
  const accessor = Object.freeze({ id: 'accessor', get payload() { reads++; return 1; } });
  assert.throws(() => initializeUnit({ id: 1, definition: accessor, position: [0, 0] }), /accessors/);
  assert.equal(reads, 0);
  const sparse = Object.freeze({ id: 'sparse', labels: Object.freeze(new Array(2)) });
  assert.throws(() => initializeUnit({ id: 1, definition: sparse, position: [0, 0] }), /dense/);

  const mutable = { id: 'manual', vitality: { maxHp: 50 } };
  const manual = { id: 1, definition: mutable, position: [0, 0], vitality: initializeVitalityState(mutable.vitality) };
  const copied = copyUnitSnapshot(manual);
  mutable.vitality.maxHp = 99;
  assert.equal(copied.definition.vitality.maxHp, 50);
});

test('core prepared states preserve supported state shapes', () => {
  const definition = { id: 'state-shapes', offense: { attack: 10 } };
  const unit = initializeUnit({ id: 1, definition, position: [0, 0], states: {
    offense: { ...initializeOffenseState(), marker: 'discarded' },
  } });
  assert.equal(Object.hasOwn(unit.offense, 'marker'), false);
});

test('core capability guards inspect composition while explicit unit snapshots isolate state', () => {
  const unit = initializeUnit({ id: 1, definition: catalogDefinition(), position: [0, 0],
    states: { locomotion: catalogRoutedState() } });
  for (const [key, guard] of [
    ['vitality', hasVitality], ['locomotion', hasLocomotion], ['allegiance', hasAllegiance],
    ['action', hasAction], ['spatial', hasSpatial], ['hit', hasHit], ['status', hasStatus], ['blocker', hasBlocker],
    ['blockable', hasBlockable],
  ]) {
    const missingState = { ...unit };
    delete missingState[key];
    assert.equal(guard(missingState), false, `${key}: configuration alone is not a runtime capability`);

    const definition = { ...unit.definition };
    delete definition[key];
    const missingConfiguration = { ...unit, definition };
    assert.equal(guard(missingConfiguration), false, `${key}: state alone is not a configured capability`);
    if (key === 'locomotion') assert.equal(hasRoutedLocomotion(missingConfiguration), false);
  }

  assert.equal(hasRoutedLocomotion({ ...unit, locomotion: createLocomotionState() }), false);
  assert.equal(hasRoutedLocomotion(unit), true);
  const presence = { id: 2, definition: Object.freeze({ id: 'presence' }), position: [0, 0],
    spatialPresence: { present: false } };
  assert.deepEqual(copyUnitSnapshot(presence).spatialPresence, { present: false });


});

test('core snapshots isolate capability state and both routed contexts while sharing immutable definitions', () => {
  const unit = initializeUnit({ id: 1, definition: catalogDefinition(), position: Object.freeze([2, 0]),
    states: { locomotion: catalogRoutedState(), spatialPresence: { present: true } } });
  const snapshot = copyUnitSnapshot(unit);
  assert.equal(snapshot.definition, unit.definition);
  assert.equal(snapshot.position, unit.position);

  snapshot.vitality.hp = 0;
  snapshot.allegiance.side = 'ENEMY';
  snapshot.action.readyAtTick = 7;
  assert.equal(snapshot.hit.geometry, unit.hit.geometry);
  assert.equal(snapshot.blocker.geometry, unit.blocker.geometry);
  assert.equal(snapshot.blocker.capacity.entries, unit.blocker.capacity.entries);
  assert.equal(snapshot.status.contributions, unit.status.contributions);
  snapshot.spatial.layer = 'AIR';
  snapshot.hit.geometry = createShapeGeometry({ shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 2 }] });
  snapshot.status.contributions = [];
  snapshot.blocker.capacity = contribution.create([{ id: 'snapshot-only-capacity', sequence: 0,
    kind: "SAMPLED",
    participating: true, values: [modifier.create({ finalScaler: 0 })] }]);
  snapshot.blocker.geometry = createBlockGeometry({ radius: 2 });
  snapshot.blockable.weight = 2;
  snapshot.spatialPresence.present = false;
  snapshot.locomotion.moving = true;
  snapshot.locomotion.steering.lastVelocity = [1, 0];
  snapshot.locomotion.mainRoute.route.progress.checkpoint.remainingTicks = 1;
  snapshot.locomotion.mainRoute.navigation.execution.visits.visitedCenters.push([0, 1]);
  assert.notEqual(snapshot.locomotion.mainRoute.navigation.execution.activity,
    unit.locomotion.mainRoute.navigation.execution.activity);
  snapshot.locomotion.mainRoute.navigation.execution.activity = { type: 'IDLE' };
  assert.equal(snapshot.locomotion.alternativeRoute.route.progress.checkpoint.remainingTicks, 9);
  assert.deepEqual(snapshot.locomotion.alternativeRoute.navigation.execution.visits.visitedCenters, []);
  snapshot.locomotion.alternativeRoute.route.progress.checkpoint.remainingTicks = 2;
  snapshot.locomotion.alternativeRoute.navigation.execution.locatorOffset = [0.5, 0];

  assert.equal(unit.vitality.hp, 100);
  assert.equal(unit.allegiance.side, 'ALLY');
  assert.equal(unit.action.readyAtTick, 0);
  assert.equal(unit.spatial.layer, 'GROUND');
  assert.equal(unit.hit.geometry.shapes[0].radius, 0.25);
  assert.deepEqual([...deriveEffectiveStatusFlags(unit.status)], ['HEAL_FREE']);
  assert.deepEqual(unit.blocker.capacity.entries, []);
  assert.equal(resolveBlockingCapacity(unit.definition.blocker, unit.blocker), 2);
  assert.equal(unit.blocker.geometry.radius, 0.7);
  assert.equal(unit.blockable.weight, 1);
  assert.equal(unit.spatialPresence.present, true);
  assert.equal(unit.locomotion.moving, false);
  assert.deepEqual(unit.locomotion.steering.lastVelocity, [0, 0]);
  for (const control of [unit.locomotion.mainRoute, unit.locomotion.alternativeRoute]) {
    assert.equal(control.route.progress.checkpoint.remainingTicks, 9);
    assert.deepEqual(control.navigation.execution.visits.visitedCenters, []);
    assert.deepEqual(control.navigation.execution.locatorOffset, [0, 0]);
    assert.equal(control.navigation.execution.activity.type, 'IDLE');
  }
});

test('core geometry boundaries own shape values and share them across snapshots', () => {
  const circle = { type: 'CIRCLE', offset: [0.25, 0], radius: 0.125 };
  const box = { type: 'BOX', offset: [0, 1], halfExtents: [0.5, 0.25] };
  const geometry = createShapeGeometry({ shapes: [circle, box] });
  circle.radius = 10;
  circle.offset[0] = 10;
  box.halfExtents[0] = 10;
  assert.deepEqual(geometry.shapes, [
    { type: 'CIRCLE', offset: [0.25, 0], radius: 0.125 },
    { type: 'BOX', offset: [0, 1], halfExtents: [0.5, 0.25] },
  ]);
  assert.equal(createShapeGeometry(geometry), geometry);
  assert.equal(Object.isFrozen(geometry.shapes), true);
  assert.equal(Object.isFrozen(geometry.shapes[0].offset), true);
  assert.equal(Object.isFrozen(geometry.shapes[1].halfExtents), true);
  assert.throws(() => createShapeGeometry({ shapes: Array(1) }), /dense/);
  assert.throws(() => createShapeGeometry({ shapes: [] }), /at least one/);
  assert.throws(() => createBlockGeometry({ radius: -1 }), /nonnegative/);

  const definition = Object.freeze({ id: 'shared_geometry', hit: createHitDefinition({ geometry }) });
  const first = initializeUnit({ id: 1, definition, position: [0, 0] });
  const second = initializeUnit({ id: 2, definition, position: [1, 0] });
  const snapshot = copyUnitSnapshot(first);
  assert.equal(snapshot.hit.geometry, geometry);
  assert.equal(second.hit.geometry, geometry);
  assert.notEqual(first.hit, second.hit);
  assert.notEqual(snapshot.hit, first.hit);
});

test('core range geometry includes tangent contacts and excludes circle-box corner gaps', () => {
  const shapes = shape => createShapeGeometry({ shapes: [shape] });
  const circle = radius => shapes({ type: 'CIRCLE', offset: [0, 0], radius });
  const box = (halfWidth, halfHeight) => shapes({ type: 'BOX', offset: [0, 0], halfExtents: [halfWidth, halfHeight] });
  const range = geometry => createRangeGeometry({ type: 'SHAPES', geometry });
  assert.equal(rangeOverlapsHit(range(circle(1)), [0, 0], [1.25, 0], circle(0.25)), true);
  assert.equal(rangeOverlapsHit(range(circle(1)), [0, 0], [1.251, 0], circle(0.25)), false);
  assert.equal(rangeOverlapsHit(range(box(0.5, 0.5)), [0, 0], [0.875, 1], circle(0.625)), true);
  assert.equal(rangeOverlapsHit(range(box(0.5, 0.5)), [0, 0], [1, 1], circle(0.625)), false);
  assert.equal(rangeOverlapsHit(range(circle(0.625)), [1, 1], [0, 0], box(0.5, 0.5)), false);
  assert.equal(rangeOverlapsHit(range(box(0.5, 0.5)), [0, 0], [0.75, 0.75], box(0.25, 0.25)), true);
  assert.equal(rangeOverlapsHit(range(box(0.5, 0.5)), [0, 0], [0.751, 0.75], box(0.25, 0.25)), false);
  assert.equal(rangeOverlapsHit(range(circle(1)), [0, 0], [4, 0], shapes({
    type: 'CIRCLE', offset: [-3, 0], radius: 0.125,
  })), true);
  assert.equal(geometryContainsPosition(shapes({ type: 'CIRCLE', offset: [0.5, -0.5], radius: 1 }),
    [2, 3], [3.5, 2.5]), true);
  assert.equal(geometryContainsPosition(box(0.5, 0.5), [2, 3], [2.5, 3.5]), true);
});

test('core grid ranges rotate all four directions around continuous source positions', () => {
  const source = [0.25, 0.25];
  const hit = createShapeGeometry({ shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 0.125 }] });
  for (const [direction, axis] of [['RIGHT', [1, 0]], ['UP', [0, 1]], ['LEFT', [-1, 0]], ['DOWN', [0, -1]]]) {
    const range = createRangeGeometry({ type: 'GRID', offsets: [[0, 1], [0, 3]], direction });
    const at = distance => source.map((value, index) => value + axis[index] * distance);
    assert.equal(rangeOverlapsHit(range, source, at(1.625), hit), true, `${direction}: tangent`);
    assert.equal(rangeOverlapsHit(range, source, at(1.626), hit), false, `${direction}: beyond edge`);
    assert.equal(rangeOverlapsHit(range, source, at(2), hit), false, `${direction}: gap in union`);
    assert.equal(rangeContainsPosition(range, source, at(3)), true, `${direction}: second box`);
  }
  const originCell = createRangeGeometry({ type: 'GRID', offsets: [[0, 0]], direction: 'RIGHT' });
  assert.equal(rangeOverlapsHit(originCell, source, [0.875, 0.25], hit), true);
  assert.equal(rangeOverlapsHit(originCell, [0, 0], [0.875, 0.25], hit), false);
  assert.equal(rangeContainsPosition(originCell, source, [0.75, 0.25]), true);
  assert.equal(rangeContainsPosition(originCell, [0, 0], [0.75, 0.25]), false);
});

test('core status contributions retain overlapping flags and isolate sources and unit snapshots', () => {
  assert.throws(() => createStatusDefinition({ initialFlags: new Array(1) }), /missing status flag/);
  const initialFlags = ['INVINCIBLE'];
  const definition = createStatusDefinition({ initialFlags });
  initialFlags.push('HEAL_FREE');
  let state = initializeStatusState(definition);
  const baseline = state.contributions[0];
  const flags = ['HEAL_FREE'];
  state = addStatusContribution(state, { id: 'source-a', flags });
  flags.push('INVISIBLE');
  state = addStatusContribution(state, { id: 'source-b', flags: ['HEAL_FREE'] });
  assert.equal(state.contributions[0], baseline);
  assert.equal(deriveEffectiveStatusFlags(state).has('INVISIBLE'), false);
  assert.throws(() => addStatusContribution(state, { id: 'source-a', flags: [] }), /duplicate/);
  const copy = copyStatusState(state);
  assert.notEqual(copy, state);
  assert.equal(copy.contributions, state.contributions);
  copy.contributions = [];
  assert.equal(deriveEffectiveStatusFlags(state).has('HEAL_FREE'), true);
  state = removeStatusContribution(state, 'source-a');
  assert.equal(deriveEffectiveStatusFlags(state).has('HEAL_FREE'), true);
  state = removeStatusContribution(state, 'source-b');
  assert.deepEqual([...deriveEffectiveStatusFlags(state)], ['INVINCIBLE']);
  assert.throws(() => removeStatusContribution(state, baseline.id), /cannot be removed/);

  const unitDefinition = Object.freeze({ id: 'shared_status_definition', status: definition });
  const first = initializeUnit({ id: 1, definition: unitDefinition, position: [0, 0] });
  const second = initializeUnit({ id: 2, definition: unitDefinition, position: [0, 0] });
  first.status = addStatusContribution(first.status, { id: 'source-a', flags: ['HEAL_FREE'] });
  assert.equal(deriveEffectiveStatusFlags(second.status).has('HEAL_FREE'), false);
  assert.equal(deriveEffectiveStatusFlags(first.status).has('HEAL_FREE'), true);
});

test('core blocking uses current state radius and includes center-distance equality', () => {
  const map = createBattlefieldMap(1, 3, Array.from({ length: 3 }, () => deploymentTile()));
  const blocker = initializeUnit({ id: 1, definition: Object.freeze({ id: 'radius_blocker',
    allegiance: { side: 'ALLY' }, blocker: createBlockerDefinition({ capacity: 1, geometry: { radius: 0.5 } }),
  }), position: [0, 0] });
  const blocked = initializeUnit({ id: 2, definition: Object.freeze({ id: 'radius_enemy',
    allegiance: { side: 'ENEMY' }, blockable: { weight: 1 }, spatial: { layer: 'GROUND' },
    hit: createHitDefinition({ geometry: { shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 10 }] } }),
  }), position: [1, 0] });
  const update = current => {
    const units = new Map([[1, current], [2, blocked]]);
    return updateBlockingRelations(map, units, [], projectUnitsByTile(map, units).unitsByTile);
  };
  assert.deepEqual(update(blocker), []);
  const enlarged = { ...blocker, blocker: { ...blocker.blocker, geometry: createBlockGeometry({ radius: 1 }) } };
  assert.deepEqual(update(enlarged), [{ blockerUnitId: 1, blockedUnitId: 2 }]);
  assert.deepEqual(update({ ...enlarged, blocker: { ...enlarged.blocker, geometry: createBlockGeometry({ radius: 0.999 }) } }), []);
  assert.equal(enlarged.definition.blocker.geometry.radius, 0.5);
});

test('core unit updates preserve definition identity and fail atomically while presence stays dynamic', () => {
  const runtime = presenceBattlefield();
  const unit = initializeUnit({ id: 1, definition: catalogDefinition(), position: [2, 0] });
  runtime.advance([{ type: 'REGISTER_UNIT', unit }]);
  const maps = runtime.snapshot('draft').navigationMaps;
  for (const invalid of [{ ...unit, definition: Object.freeze({ ...unit.definition }) }]) {
    assert.throws(() => runtime.advance([
      { type: 'SET_POSITION_AND_RELEASE_BLOCKING', unitId: 1, position: [3, 0] },
      { type: 'UPDATE_UNIT', unit: invalid },
    ]));
    assert.deepEqual(runtime.snapshot('draft').getUnit(1).position, [2, 0]);
    assert.deepEqual(runtime.snapshot('draft').unitsAt([0, 2]).map(value => value.id), [1]);
    assert.equal(runtime.snapshot('draft').navigationMaps, maps);
  }

  const bare = initializeUnit({ id: 2, definition: Object.freeze({ id: 'bare' }), position: [0, 0] });
  runtime.advance([{ type: 'REGISTER_UNIT', unit: bare }]);
  assert.throws(() => runtime.advance([{ type: 'UPDATE_UNIT', unit: {
    ...bare, definition: Object.freeze({ ...bare.definition, vitality: { maxHp: 1 } }), vitality: initializeVitalityState({ maxHp: 1 }),
  } }]));

  const hidden = { ...runtime.snapshot('draft').getUnit(1), spatialPresence: { present: false } };
  runtime.advance([{ type: 'UPDATE_UNIT', unit: hidden }]);
  assert.deepEqual(runtime.snapshot('draft').unitsAt([0, 2]), []);
  const restored = copyUnitSnapshot(runtime.snapshot('draft').getUnit(1));
  delete restored.spatialPresence;
  runtime.advance([{ type: 'UPDATE_UNIT', unit: restored }]);
  assert.deepEqual(runtime.snapshot('draft').unitsAt([0, 2]).map(value => value.id), [1]);
});

test('core initializer types preserve definition unions, prepared refinements and guard context', async () => {
  const { default: ts } = await import('typescript');
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-unit-types-'));
  const sourceModule = name => JSON.stringify(fileURLToPath(
    new URL(`../../src/core/tactical/unit/${name}.js`, import.meta.url)));
  const imports = `
import { initializeUnit, type InitializedUnit } from ${sourceModule('initialize')};
import type { Unit, UnitDefinition } from ${sourceModule('unit')};
import type { ImmutableData } from ${sourceModule('../../common/immutable-data')};
import { initializeOffenseState } from ${sourceModule('capability/offense/capability')};
import type { EnemyDefinition } from ${sourceModule('archetype/enemy')};
import { hasVitality, type VitalityDefinition } from ${sourceModule('capability/vitality/capability')};
import { hasRoutedLocomotion, type LocomotionState, type RoutedLocomotionState } from ${sourceModule('capability/locomotion/capability')};
import { createBattlefieldRuntime } from ${sourceModule('../battlefield/runtime')};
import type { BattlefieldView } from ${sourceModule('../battlefield/contract')};
import type { BattlefieldMap } from ${sourceModule('../battlefield/map/map')};
import { createUnitPlacementDefinition, instantiateUnitPlacement, type UnitPlacementDefinition } from ${sourceModule('../battle/creation/placement')};
import type { BattleExecutionState } from ${sourceModule('../battle/execution/state')};
import { withProjectileOperations } from ${sourceModule('../battlefield/projectile/operations')};
import type { ProjectileView } from ${sourceModule('../battlefield/projectile/state')};
import type { ProjectileResources } from ${sourceModule('../battlefield/projectile/resources')};
import type { Occupancy, OccupancyState } from ${sourceModule('capability/occupancy')};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
interface EnemyProbe extends EnemyDefinition { readonly kind: 'enemy'; readonly enemyCode: 17; }
interface DeviceProbe extends UnitDefinition { readonly kind: 'device'; readonly deviceCode: 29; }
interface OptionalProbe extends UnitDefinition { readonly vitality?: VitalityDefinition; }
declare const enemyDefinition: EnemyProbe;
declare const unionDefinition: EnemyProbe | DeviceProbe;
declare const routed: RoutedLocomotionState;
declare const battlefieldMap: BattlefieldMap;
declare const execution: BattleExecutionState;
declare const projectileBattlefield: ProjectileView;
declare const projectileResources: ProjectileResources;
declare const placement: { readonly definition: EnemyProbe; readonly position: readonly [number, number]; readonly states: { readonly occupancy: OccupancyState } }
  | { readonly definition: DeviceProbe; readonly position: readonly [number, number] };
`;
  const compile = (name, source) => {
    const path = join(directory, `${name}.mts`);
    writeFileSync(path, imports + source);
    const program = ts.createProgram([path], {
      noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
      skipLibCheck: true, types: [],
    });
    return ts.getPreEmitDiagnostics(program).map(diagnostic => ({
      file: diagnostic.file?.fileName,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }));
  };

  try {
    const positive = compile('positive', `
type Distributed = Assert<Equal<InitializedUnit<EnemyProbe | DeviceProbe>, InitializedUnit<EnemyProbe> | InitializedUnit<DeviceProbe>>>;
type OptionalHasNoRequiredCapabilities = Assert<Equal<RequiredKeys<InitializedUnit<OptionalProbe>>, 'id' | 'definition' | 'position'>>;
type WideHasNoRequiredCapabilities = Assert<Equal<RequiredKeys<InitializedUnit<UnitDefinition>>, 'id' | 'definition' | 'position'>>;
function initializeGeneric<D extends EnemyDefinition>(definition: D): InitializedUnit<D> {
  return initializeUnit({ id: 0, definition, position: [0, 0] });
}
const enemy = initializeUnit({ id: 1, definition: enemyDefinition, position: [0, 0] });
type PlainDefinition = Assert<Equal<typeof enemy.definition, ImmutableData<EnemyProbe>>>;
type PlainUnit = Assert<Equal<typeof enemy, InitializedUnit<EnemyProbe>>>;
const union = initializeUnit({ id: 2, definition: unionDefinition, position: [0, 0] });
type UnionUnit = Assert<Equal<typeof union, InitializedUnit<EnemyProbe | DeviceProbe>>>;
const placed = instantiateUnitPlacement(placement, execution, 0);
type PlacementDefinition = Assert<Equal<typeof placed.unit.definition, ImmutableData<EnemyProbe | DeviceProbe>>>;
type ExpectedPlacement = (InitializedUnit<EnemyProbe> & Occupancy) | InitializedUnit<DeviceProbe>;
type PlacementCapabilities = Assert<typeof placed.unit extends ExpectedPlacement ? true : false>;
type PlacementInput = Assert<ExpectedPlacement extends typeof placed.unit ? true : false>;
const normalizedPlacement = createUnitPlacementDefinition(placement);
const normalizedPlaced = instantiateUnitPlacement(normalizedPlacement, execution, 0);
type NormalizedPlacementCapabilities = Assert<typeof normalizedPlaced.unit extends ExpectedPlacement ? true : false>;
type NormalizedPlacementInput = Assert<ExpectedPlacement extends typeof normalizedPlaced.unit ? true : false>;
const requiredPlacement = createUnitPlacementDefinition({
  definition: unionDefinition, position: [0, 0], states: { occupancy: { claims: [] } }, extra: 31,
});
const requiredPlaced = instantiateUnitPlacement(requiredPlacement, execution, 0);
requiredPlaced.unit.occupancy.claims;
type RequiredPlacementCapabilities = Assert<typeof requiredPlaced.unit extends InitializedUnit<EnemyProbe | DeviceProbe> & Occupancy ? true : false>;
type RequiredPlacementInput = Assert<InitializedUnit<EnemyProbe | DeviceProbe> & Occupancy extends typeof requiredPlaced.unit ? true : false>;
type NormalizedPlacementFields = Assert<Equal<keyof typeof requiredPlacement, 'definition' | 'position' | 'states' | 'navigationModifiers'>>;
if (union.definition.kind === 'enemy') { const code: 17 = union.definition.enemyCode; }
else { const code: 29 = union.definition.deviceCode; }
const prepared = initializeUnit({ id: 3, definition: enemyDefinition, position: [0, 0],
  states: { locomotion: routed, spatialPresence: { present: false } } });
type PreparedDefinition = Assert<Equal<typeof prepared.definition, ImmutableData<EnemyProbe>>>;
type PreparedLocomotion = Assert<typeof prepared.locomotion extends RoutedLocomotionState ? true : false>;
type PreparedLocomotionShape = Assert<RoutedLocomotionState extends typeof prepared.locomotion ? true : false>;
prepared.locomotion.mainRoute.route.definition;
prepared.spatialPresence.present;
declare const optionalStates: Partial<{ locomotion: RoutedLocomotionState }>;
const optionalPrepared = initializeUnit({ id: 4, definition: enemyDefinition, position: [0, 0], states: optionalStates });
type OptionalPreparedLocomotion = Assert<typeof optionalPrepared.locomotion extends LocomotionState ? true : false>;
type OptionalPreparedLocomotionShape = Assert<LocomotionState extends typeof optionalPrepared.locomotion ? true : false>;
optionalPrepared.locomotion.moving;
declare const guarded: Unit<EnemyProbe> & { readonly extra: 23 };
if (hasVitality(guarded)) {
  const extra: 23 = guarded.extra;
  const kind: 'enemy' = guarded.definition.kind;
  guarded.vitality.hp;
}
if (hasRoutedLocomotion(guarded)) {
  const extra: 23 = guarded.extra;
  const code: 17 = guarded.definition.enemyCode;
  guarded.locomotion.mainRoute.route.definition;
}
const battlefield = createBattlefieldRuntime({ map: battlefieldMap });
type PublicFactory = Assert<Equal<Extract<keyof typeof battlefield, 'commit'>, never>>;
type RuleCache = Assert<Equal<Extract<keyof BattlefieldView['fieldCache'], 'invalidate' | 'clear'>, never>>;
const projectileResult = withProjectileOperations(projectileBattlefield, execution.nextProjectileId, projectileResources, 0, () => 23 as const);
type ProjectileLiteral = Assert<Equal<typeof projectileResult.result, 23>>;
const projectileVoid = withProjectileOperations(projectileBattlefield, execution.nextProjectileId, projectileResources, 0, () => {});
type ProjectileVoid = Assert<Equal<typeof projectileVoid.result, undefined>>;
`);
    assert.deepEqual(positive, []);

    for (const [name, source] of [
      ['async-projectile-operation', `withProjectileOperations(projectileBattlefield, execution.nextProjectileId, projectileResources, 0, async () => 1);`],
      ['async-void-projectile-operation', `withProjectileOperations<void>(projectileBattlefield, execution.nextProjectileId, projectileResources, 0, async () => {});`],
      ['promise-union-projectile-operation', `declare const mixed: number | Promise<number>; withProjectileOperations(projectileBattlefield, execution.nextProjectileId, projectileResources, 0, () => mixed);`],
      ['state-extra-field', `initializeUnit({ id: 1, definition: { id: 'offense', offense: { attack: 1 } }, position: [0, 0], states: { offense: { ...initializeOffenseState(), marker: 'extra' as const } } }).offense.marker;`],
      ['normalized-state-extra', `instantiateUnitPlacement(createUnitPlacementDefinition({ definition: { id: 'offense', offense: { attack: 1 } }, position: [0, 0], states: { offense: { ...initializeOffenseState(), marker: 'extra' as const } } }), execution, 0).unit.offense.marker;`],
      ['mutable-definition', `initializeUnit({ id: 1, definition: { id: 'mutable', vitality: { maxHp: 10 } }, position: [0, 0] }).definition.vitality.maxHp = 99;`],
      ['unconfigured', `initializeUnit({ id: 1, definition: { id: 'bare' }, position: [0, 0], states: { locomotion: routed } });`],
      ['optional', `declare const optionalDefinition: OptionalProbe; initializeUnit({ id: 1, definition: optionalDefinition, position: [0, 0] }).vitality.hp;`],
      ['wide', `declare const wideDefinition: UnitDefinition; initializeUnit({ id: 1, definition: wideDefinition, position: [0, 0] }).locomotion.moving;`],
      ['optional-refinement', `declare const optionalStates: Partial<{ locomotion: RoutedLocomotionState }>; initializeUnit({ id: 1, definition: enemyDefinition, position: [0, 0], states: optionalStates }).locomotion.mainRoute;`],
      ['optional-normalized-occupancy', `declare const optionalPlacement: UnitPlacementDefinition<EnemyProbe>; instantiateUnitPlacement(createUnitPlacementDefinition(optionalPlacement), execution, 0).unit.occupancy.claims;`],
      ['normalized-union-occupancy', `instantiateUnitPlacement(createUnitPlacementDefinition(placement), execution, 0).unit.occupancy.claims;`],
      ['normalized-unknown-field', `createUnitPlacementDefinition({ definition: enemyDefinition, position: [0, 0], extra: 31 }).extra;`],
    ]) {
      const diagnostics = compile(name, source);
      assert.ok(diagnostics.some(diagnostic => diagnostic.file === join(directory, `${name}.mts`)),
        `${name} must reject unsupported capability inference: ${JSON.stringify(diagnostics)}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const deploymentTile = (overrides = {}) => ({
  heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
  playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null, ...overrides,
});

const deploymentUnit = (id, position, definition, claims, present = true) => initializeUnit({
  id, position, definition: Object.freeze({ id: `deployment_${id}`, ...definition }),
  states: { occupancy: createOccupancyState({ claims }), spatialPresence: { present } },
});

test('core deployment uses buildability, side and terrain independently of navigation passability', () => {
  const map = createBattlefieldMap(1, 8, [
    deploymentTile({ buildableType: 'MELEE' }),
    deploymentTile({ buildableType: 'RANGED', heightType: 'HIGHLAND' }),
    deploymentTile({ passableMask: 'FLY_ONLY' }),
    deploymentTile({ buildableType: 'NONE' }),
    deploymentTile({ playerSideMask: 'SIDE_B' }),
    deploymentTile({ playerSideMask: 'NONE' }),
    deploymentTile({ terrain: 'HOLE', buildableType: 'NONE' }),
    deploymentTile({ advancedBuildableMask: 2, mechanism: { type: 'DEEPSEA', params: {
      damagePerTick: 1, attackSpeedModifier: -60, moveSpeedMultiplier: 0.6,
    } } }),
  ]);
  const runtime = createBattlefieldRuntime({ map });
  const query = (type, column, playerSide = 'SIDE_A') => evaluateDeployment(runtime.snapshot('draft'), {
    profile: createDeploymentProfile({ buildableType: type }), tile: [0, column], playerSide,
  });
  for (const [type, column, allowed] of [
    ['MELEE', 0, true], ['RANGED', 0, false], ['ALL', 0, true],
    ['MELEE', 1, false], ['RANGED', 1, true], ['ALL', 1, true],
    ['MELEE', 2, true], ['RANGED', 2, true],
  ]) {
    assert.deepEqual(query(type, column), allowed
      ? { type: 'ALLOWED', supportUnitId: null }
      : { type: 'DENIED', reason: 'BUILDABLE_TYPE' });
  }
  assert.equal(runtime.snapshot('draft').navigationMaps.WALK.cells[2].passable, false);
  for (const [column, reason] of [[3, 'BUILDABLE_TYPE'], [4, 'PLAYER_SIDE'], [5, 'PLAYER_SIDE'],
    [6, 'BUILDABLE_TYPE'], [7, 'TERRAIN'], [8, 'OUTSIDE_MAP'], [-1, 'OUTSIDE_MAP']]) {
    assert.deepEqual(query('ALL', column), { type: 'DENIED', reason });
  }
  assert.deepEqual(query('ALL', 4, 'SIDE_B'), { type: 'ALLOWED', supportUnitId: null });
  assert.deepEqual(evaluateDeployment(runtime.snapshot('draft'), {
    profile: createDeploymentProfile({ buildableType: 'ALL', advancedBuildableMask: 2 }),
    tile: [0, 7], playerSide: 'SIDE_A',
  }), { type: 'ALLOWED', supportUnitId: null });
  assert.deepEqual(evaluateDeployment(runtime.snapshot('draft'), {
    profile: createDeploymentProfile({ buildableType: 'ALL', advancedBuildableMask: 3 }),
    tile: [0, 7], playerSide: 'SIDE_A',
  }), { type: 'ALLOWED', supportUnitId: null });
});

test('core occupancy separates present claims, reservations and geometric membership', () => {
  const runtime = createBattlefieldRuntime({ map: createBattlefieldMap(1, 4,
    Array.from({ length: 4 }, () => deploymentTile())) });
  const present = deploymentUnit(1, [1, 0], {}, [
    { position: [0, 1], slot: 'DEPLOYMENT', type: 'PRESENT' },
  ], false);
  const reserved = deploymentUnit(2, [2, 0], {}, [
    { position: [0, 2], slot: 'DEPLOYMENT', type: 'RESERVATION' },
  ], false);
  const enemy = initializeUnit({ id: 3, definition: Object.freeze({ id: 'enemy_without_claim' }), position: [1, 0] });
  runtime.advance([present, reserved, enemy].map(unit => ({ type: 'REGISTER_UNIT', unit })));
  assert.deepEqual(runtime.snapshot('draft').unitsAt([0, 1]).map(unit => unit.id), [3]);
  assert.deepEqual(runtime.snapshot('draft').occupancyAt([0, 1], 'DEPLOYMENT'), []);
  assert.deepEqual(runtime.snapshot('draft').occupancyAt([0, 2], 'DEPLOYMENT'), [2]);
  const profile = createDeploymentProfile({ buildableType: 'ALL' });
  assert.equal(evaluateDeployment(runtime.snapshot('draft'), { profile, tile: [0, 1], playerSide: 'SIDE_A' }).type, 'ALLOWED');
  assert.deepEqual(evaluateDeployment(runtime.snapshot('draft'), { profile, tile: [0, 2], playerSide: 'SIDE_A' }),
    { type: 'DENIED', reason: 'OCCUPIED' });

  const restored = copyUnitSnapshot(runtime.snapshot('draft').getUnit(1));
  restored.spatialPresence.present = true;
  runtime.advance([{ type: 'UPDATE_UNIT', unit: restored }]);
  assert.deepEqual(runtime.snapshot('draft').occupancyAt([0, 1], 'DEPLOYMENT'), [1]);
  assert.deepEqual(runtime.snapshot('draft').unitsAt([0, 1]).map(unit => unit.id), [1, 3]);
  const snapshot = copyUnitSnapshot(runtime.snapshot('draft').getUnit(1));
  snapshot.occupancy.claims[0].slot = 'SUPPORT';
  snapshot.occupancy.claims.push({ position: [0, 3], slot: 'DEPLOYMENT', type: 'RESERVATION' });
  assert.deepEqual(runtime.snapshot('draft').getUnit(1).occupancy.claims,
    [{ position: [0, 1], slot: 'DEPLOYMENT', type: 'PRESENT' }]);
});

test('core support allows a platform and occupant to coexist without treating the platform as the occupant', () => {
  const runtime = createBattlefieldRuntime({ map: createBattlefieldMap(1, 3, [
    deploymentTile(), deploymentTile({ buildableType: 'NONE' }), deploymentTile(),
  ]) });
  const platform = deploymentUnit(1, [1, 0], {
    vitality: Object.freeze({ maxHp: 100 }),
    tileBinding: createTileBindingDefinition({ buildableType: 'RANGED', heightType: 'HIGHLAND' }),
  }, [{ position: [0, 1], slot: 'SUPPORT', type: 'PRESENT' }]);
  runtime.advance([{ type: 'REGISTER_UNIT', unit: platform }]);
  const profile = createDeploymentProfile({ buildableType: 'RANGED' });
  assert.deepEqual(evaluateDeployment(runtime.snapshot('draft'), { profile, tile: [0, 1], playerSide: 'SIDE_A' }),
    { type: 'ALLOWED', supportUnitId: 1 });
  const occupant = deploymentUnit(2, [1, 0], { deployment: profile }, [
    { position: [0, 1], slot: 'DEPLOYMENT', type: 'PRESENT' },
  ]);
  runtime.advance([{ type: 'REGISTER_UNIT', unit: occupant }, { type: 'SET_SUPPORT_RELATIONS',
    relations: [{ supportedUnitId: 2, supportUnitId: 1 }] }]);
  assert.deepEqual(runtime.snapshot('draft').unitsAt([0, 1]).map(unit => unit.id), [1, 2]);
  assert.deepEqual(runtime.snapshot('draft').occupancyAt([0, 1], 'SUPPORT'), [1]);
  assert.deepEqual(runtime.snapshot('draft').occupancyAt([0, 1], 'DEPLOYMENT'), [2]);
  assert.equal(runtime.snapshot('draft').supportOf(2), 1);
  assert.deepEqual(runtime.snapshot('draft').supportedBy(1), [2]);
  assert.deepEqual(evaluateDeployment(runtime.snapshot('draft'), { profile, tile: [0, 1], playerSide: 'SIDE_A' }),
    { type: 'DENIED', reason: 'OCCUPIED' });
  assert.deepEqual(evaluateDeployment(runtime.snapshot('draft'), { profile, tile: [0, 1], playerSide: 'SIDE_A', relocatingUnitId: 2 }),
    { type: 'ALLOWED', supportUnitId: 1 });
  const retained = runtime.snapshot('draft');
  const removed = runtime.advance([{ type: 'REMOVE_UNIT', unitId: 1, reason: 'SCRIPT' }]);
  assert.deepEqual(removed.lostSupports, [{ supportedUnitId: 2, supportUnitId: 1 }]);
  assert.equal(retained.supportOf(2), 1);
  assert.deepEqual(retained.supportRelations, [{ supportedUnitId: 2, supportUnitId: 1 }]);
  assert.equal(runtime.snapshot('draft').supportOf(2), undefined);
  assert.deepEqual(runtime.snapshot('draft').supportedBy(1), []);
  assert.deepEqual(runtime.snapshot('draft').supportRelations, []);
  assert.equal(runtime.snapshot('draft').getUnit(2).id, 2);
  assert.deepEqual(runtime.snapshot('draft').occupancyAt([0, 1], 'DEPLOYMENT'), [2]);
});

test('core navigation definitions are owned once and shared across copied observations', () => {
  const definition = { id: 'owned-navigation', WALK: { denyPassage: false, deniedDepartures: ['LEFT'], costFloor: 1000 }, FLY: null };
  const placement = createUnitPlacementDefinition({ definition: { id: 'source' }, position: [0, 0],
    navigationModifiers: [{ definition, range: [[0, 1]], direction: 'RIGHT' }] });
  const runtime = presenceBattlefield();
  const ownedDefinition = createNavigationModifierDefinition(definition);
  const modifier = { ...presenceNavigationModifier(1, { type: 'UNIT', unitId: 1 },
    { type: 'FIXED', position: [0, 1], range: [[0, 0]], direction: 'RIGHT' }), definition: ownedDefinition };
  runtime.advance([{ type: 'REGISTER_UNIT', unit: presenceUnit(1, [0, 0]) },
    { type: 'ADD_NAVIGATION_MODIFIER', navigationModifier: modifier }]);
  const maps = runtime.snapshot('draft').navigationMaps;
  const owned = runtime.snapshot('draft').getNavigationModifier(1).definition;
  assert.equal(owned, ownedDefinition);
  definition.WALK.costFloor = 1;
  definition.WALK.denyPassage = true;
  definition.WALK.deniedDepartures.push('RIGHT');
  assert.equal(owned.WALK.costFloor, 1000);
  assert.deepEqual(owned.WALK.deniedDepartures, ['LEFT']);
  assert.equal(placement.navigationModifiers[0].definition.WALK.costFloor, 1000);
  assert.equal(runtime.snapshot('draft').getNavigationModifier(1).definition, owned);
  assert.equal(runtime.snapshot('draft').navigationMaps, maps);
  assert.equal(maps.WALK.cells[1].passable, true);
});
