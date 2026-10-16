import { fixtureBattle, fixtureDefinition } from "../helpers/unit.js";
import { Definitions } from '../../dist/core/tactical/unit/action/definitions.js';
import { create as createAttack } from '../../dist/content/tactical/actions/attack.js';
import { Effects } from "../../dist/core/tactical/unit/effect/effects.js";
import { initialize as initializeActionState } from "../../dist/core/tactical/unit/capability/action/capability.js";
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
import { create as createFieldState, transition as transitionBattlefield } from '../../dist/core/tactical/battlefield/state.js';
import { view as viewBattlefield } from '../../dist/core/tactical/battlefield/view.js';
import { createMechanismDefinition } from '../../dist/core/tactical/battlefield/mechanism.js';
import { createNavigationModifierDefinition, createNavigationModifier } from '../../dist/core/tactical/battlefield/navigation/modifier.js';
import { hasSpatialPresence, isSpatiallyPresent } from '../../dist/core/tactical/unit/capability/presence/capability.js';
import { initialize } from "../helpers/unit.js";
import { initialize as initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { initialize as initializeOffenseState } from '../../dist/core/tactical/unit/capability/offense/capability.js';
import { copy } from '../../dist/core/tactical/unit/snapshot.js';
import { hasVitality, initialize as initializeVitalityState } from '../../dist/core/tactical/unit/capability/vitality/capability.js';
import { createDefinition as createActionCapabilityDefinition, hasAction } from '../../dist/core/tactical/unit/capability/action/capability.js';
import { hasAllegiance } from '../../dist/core/tactical/unit/capability/allegiance/capability.js';
import { createDefinition as createBlockerDefinition, hasBlocker, resolveCapacity } from '../../dist/core/tactical/unit/capability/blocking/blocker.js';
import { hasBlockable } from '../../dist/core/tactical/unit/capability/blocking/blockable.js';
import * as modifier from '../../dist/core/tactical/unit/contribution/value.js';
import { createHitDefinition, hasHit, hasSpatial } from '../../dist/core/tactical/unit/capability/spatial/capability.js';
import { initialize as initializeTargetableState, hasTargetable, setRule as setTargetableRule, removeRule as removeTargetableRule, allowsTarget } from '../../dist/core/tactical/unit/capability/targetable/capability.js';
import { setHealingReceptionRule, removeHealingReceptionRule } from '../../dist/core/tactical/unit/capability/vitality/capability.js';
import { canReceiveHealing } from '../../dist/core/tactical/unit/capability/vitality/healing/reception.js';
import { createBlockGeometry, createRangeGeometry, createShapeGeometry } from '../../dist/core/tactical/geometry/shape.js';
import { geometryContainsPosition, rangeContainsPosition, rangeOverlapsHit } from '../../dist/core/tactical/geometry/intersection.js';
import { updateBlockingRelations } from '../../dist/core/tactical/battlefield/blocking/relations.js';
import { projectUnitsByTile } from '../../dist/core/tactical/battlefield/storage/indexes.js';
import { initialize as createLocomotionState, createRoutedLocomotionState, hasLocomotion, hasRoutedLocomotion } from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import { createRouteDefinition } from '../../dist/core/tactical/unit/capability/locomotion/route/definition.js';
import { createRouteState, createRouteTiming } from '../../dist/core/tactical/unit/capability/locomotion/route/state.js';
import { createNavigationState } from '../../dist/core/tactical/battlefield/navigation/state.js';
import { createUnitPlacementDefinition, instantiateUnitPlacement } from '../../dist/core/tactical/battle/creation/placement.js';
import { createDefinition as createDeployableDefinition } from '../../dist/core/tactical/unit/capability/deployable/capability.js';
import { createDefinition as createTileBindingDefinition } from '../../dist/core/tactical/unit/capability/tile-binding/capability.js';
import { validateState as validateOccupancyState } from '../../dist/core/tactical/unit/capability/occupancy/capability.js';
import { createDefinition as createOperatorDefinition } from '../../dist/core/tactical/unit/archetype/operator.js';
import { createCombatDefinition } from '../../dist/core/tactical/unit/archetype/enemy.js';
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

const presenceBattlefield = () => createFieldState({
  map: createBattlefieldMap(1, 5, Array.from({ length: 5 }, () => ({
    heightType: 'LOWLAND', buildableType: 'MELEE', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
  }))),
});

const presenceUnit = (id, position) => ({
  effects:Effects.empty(), id, definition: Object.freeze({ id: `presence_${id}`, vitality: Object.freeze({ maxHp: 100 }), spatialPresence: Object.freeze({}) }), position: Object.freeze(position),
  vitality: initializeVitalityState(fixtureBattle(0), {maxHp:100}).value, spatialPresence: { present: true },
});

const presenceNavigationModifier = (id, source, region, costFloor = 1000) => createNavigationModifier({
  id, source, region,
  definition: createNavigationModifierDefinition({
    id: `presence_effect_${id}`, WALK: { denyPassage: false, deniedDepartures: [], costFloor }, FLY: null,
  }),
  active: true, expiresAtTick: null,
});

test('core spatial presence preserves earlier unit values while removing only spatial membership', () => {
  let runtime = presenceBattlefield();
  const unit = presenceUnit(1, [2, 0]);
  const bare = { effects:Effects.empty(), id: 2, definition: Object.freeze({ id: 'bare' }), position: Object.freeze([2, 0]) };
  assert.equal(hasSpatialPresence(unit), true);
  assert.equal(hasSpatialPresence(bare), false);
  assert.equal(isSpatiallyPresent(bare), true);
  runtime = transitionBattlefield(runtime, [{ type: 'REGISTER_UNIT', unit }, { type: 'REGISTER_UNIT', unit: bare }]).state;
  const baseline = viewBattlefield(runtime).navigationMaps;
  const hidden = { ...viewBattlefield(runtime).getUnit(1), spatialPresence: { present: false } };
  assert.equal(viewBattlefield(runtime).getUnit(1).spatialPresence.present, true);
  const result = transitionBattlefield(runtime, [{ type: 'UPDATE_UNIT', unit: hidden }]);
    runtime = result.state;
  assert.deepEqual(result.facts.removedUnits, []);
  assert.deepEqual(viewBattlefield(runtime).unitIds, [1, 2]);
  assert.deepEqual(viewBattlefield(runtime).unitsAt([0, 2]).map(unit => unit.id), [2]);
  assert.equal(viewBattlefield(runtime).getUnit(1).definition, hidden.definition);
  assert.equal(viewBattlefield(runtime).getUnit(1).vitality.hp, 100);
  assert.equal(viewBattlefield(runtime).navigationMaps, baseline);
  const restored = { ...viewBattlefield(runtime).getUnit(1), spatialPresence: { present: true } };
  assert.equal(viewBattlefield(runtime).getUnit(1).spatialPresence.present, false);
  runtime = transitionBattlefield(runtime, [{ type: 'UPDATE_UNIT', unit: restored }]).state;
  assert.deepEqual(viewBattlefield(runtime).unitsAt([0, 2]).map(unit => unit.id), [1, 2]);
});

test('core removal facts share the latest unit while updates preserve retained battlefield snapshots', () => {
  let runtime = presenceBattlefield();
  const unit = presenceUnit(1, [2, 0]);
  runtime = transitionBattlefield(runtime, [{ type: 'REGISTER_UNIT', unit }]).state;
  const retained = viewBattlefield(runtime);
  const snapshot = copy(viewBattlefield(runtime).getUnit(1));
  assert.equal(snapshot.vitality, unit.vitality);
  assert.equal(snapshot.spatialPresence, unit.spatialPresence);
  assert.deepEqual(retained.getUnit(1), unit);
  assert.equal(unit.vitality.hp, 100);
  assert.equal(unit.spatialPresence.present, true);
  const updated = { ...viewBattlefield(runtime).getUnit(1), position: [3, 0], vitality: {...viewBattlefield(runtime).getUnit(1).vitality, hp: 20} };
  const removed = transitionBattlefield(runtime, [
    { type: 'UPDATE_UNIT', unit: updated },
    { type: 'REMOVE_UNIT', unitId: 1, reason: 'DEATH' },
  ]);
    runtime = removed.state;
  assert.deepEqual(removed.facts.removedUnits, [{ unitId: 1, reason: 'DEATH', unit: {
    ...updated, position: Object.freeze([3, 0]),
  } }]);
  assert.equal(removed.facts.removedUnits[0].unit.definition, unit.definition);
  assert.equal(removed.facts.removedUnits[0].unit, updated);
  assert.deepEqual(viewBattlefield(runtime).unitIds, []);
  assert.equal(retained.getUnit(1), unit);
  assert.equal(removed.facts.removedUnits[0].unit.vitality.hp, 20);
});

test('core hidden navigation modifier sources and anchors suspend contributions without removing effects', () => {
  let runtime = presenceBattlefield();
  const source = presenceUnit(1, [0, 0]), anchor = presenceUnit(2, [2, 0]);
  const bare = { effects:Effects.empty(), id: 3, definition: Object.freeze({ id: 'bare' }), position: Object.freeze([4, 0]) };
  const fixed = position => ({ type: 'FIXED', position, range: [[0, 0]], direction: 'RIGHT' });
  runtime = transitionBattlefield(runtime, [
    { type: 'REGISTER_UNIT', unit: source }, { type: 'REGISTER_UNIT', unit: anchor },
    { type: 'REGISTER_UNIT', unit: bare },
    { type: 'REGISTER_MECHANISM', mechanism: { id: 1, definition: createMechanismDefinition({ id: 'presence_mechanism' }), active: true } },
    { type: 'ADD_NAVIGATION_MODIFIER', navigationModifier: presenceNavigationModifier(1, { type: 'UNIT', unitId: 1 }, fixed([0, 1])) },
    { type: 'ADD_NAVIGATION_MODIFIER', navigationModifier: presenceNavigationModifier(2, { type: 'MECHANISM', mechanismId: 1 },
      { type: 'FOLLOW_UNIT', unitId: 2, range: [[0, 0]], direction: 'RIGHT' }) },
    { type: 'ADD_NAVIGATION_MODIFIER', navigationModifier: presenceNavigationModifier(3, { type: 'UNIT', unitId: 3 }, fixed([0, 4]), 2000) },
  ]).state;
  const fly = viewBattlefield(runtime).navigationMaps.FLY;
  assert.deepEqual(viewBattlefield(runtime).navigationMaps.WALK.cells.map(cell => cell.moveCost), [1, 1000, 1000, 1, 2000]);
  const hiddenSource = { ...source, spatialPresence: { present: false } };
  const hiddenAnchor = { ...anchor, spatialPresence: { present: false } };
  const hidden = transitionBattlefield(runtime, [{ type: 'UPDATE_UNIT', unit: hiddenSource }, { type: 'UPDATE_UNIT', unit: hiddenAnchor }]);
    runtime = hidden.state;
  assert.deepEqual(hidden.facts.removedNavigationModifiers, []);
  assert.deepEqual(hidden.facts.changedNavigationModes, ['WALK']);
  assert.deepEqual(viewBattlefield(runtime).navigationModifierIds, [1, 2, 3]);
  assert.equal(viewBattlefield(runtime).getNavigationModifier(1).active, true);
  assert.deepEqual(viewBattlefield(runtime).navigationModifiersFrom({ type: 'UNIT', unitId: 1 }), [1]);
  assert.deepEqual(viewBattlefield(runtime).navigationModifiersFollowing(2), [2]);
  assert.deepEqual(viewBattlefield(runtime).navigationModifiersAt([0, 1]), []);
  assert.deepEqual(viewBattlefield(runtime).navigationModifiersAt([0, 2]), []);
  assert.deepEqual(viewBattlefield(runtime).navigationMaps.WALK.cells.map(cell => cell.moveCost), [1, 1, 1, 1, 2000]);
  const dormant = viewBattlefield(runtime).navigationMaps;
  runtime = transitionBattlefield(runtime, [{ type: 'SET_POSITION_AND_RELEASE_BLOCKING', unitId: 2, position: Object.freeze([3, 0]) }]).state;
  assert.equal(viewBattlefield(runtime).navigationMaps, dormant);
  assert.deepEqual(viewBattlefield(runtime).unitsAt([0, 3]), []);
  const movedAnchor = { ...viewBattlefield(runtime).getUnit(2), spatialPresence: { present: true } };
  runtime = transitionBattlefield(runtime, [{ type: 'UPDATE_UNIT', unit: source }, { type: 'UPDATE_UNIT', unit: movedAnchor }]).state;
  assert.deepEqual(viewBattlefield(runtime).navigationModifiersAt([0, 3]), [2]);
  assert.deepEqual(viewBattlefield(runtime).unitsAt([0, 3]).map(unit => unit.id), [2]);
  assert.deepEqual(viewBattlefield(runtime).navigationMaps.WALK.cells.map(cell => cell.moveCost), [1, 1000, 1, 1000, 2000]);
  assert.equal(viewBattlefield(runtime).navigationMaps.FLY, fly);
  runtime = transitionBattlefield(runtime, [{ type: 'SET_MECHANISM_ACTIVE', mechanismId: 1, active: false }]).state;
  const inactive = viewBattlefield(runtime).navigationMaps;
  runtime = transitionBattlefield(runtime, [{ type: 'UPDATE_UNIT', unit: { ...movedAnchor, spatialPresence: { present: false } } }]).state;
  runtime = transitionBattlefield(runtime, [{ type: 'UPDATE_UNIT', unit: movedAnchor }]).state;
  assert.equal(viewBattlefield(runtime).navigationMaps, inactive);
  assert.deepEqual(viewBattlefield(runtime).navigationModifiersAt([0, 3]), []);
});

test('core presence transitions preserve the original state when later settlement fails', () => {
  let runtime = presenceBattlefield();
  const unit = presenceUnit(1, [2, 0]);
  runtime = transitionBattlefield(runtime, [
    { type: 'REGISTER_UNIT', unit },
    { type: 'ADD_NAVIGATION_MODIFIER', navigationModifier: presenceNavigationModifier(1, { type: 'UNIT', unitId: 1 },
      { type: 'FOLLOW_UNIT', unitId: 1, range: [[0, 0]], direction: 'RIGHT' }) },
  ]).state;
  const maps = viewBattlefield(runtime).navigationMaps;
  assert.throws(() => {
    let working = runtime;
    const hidden = { ...viewBattlefield(working).getUnit(1), spatialPresence: { present: false } };
    working = transitionBattlefield(working, [{ type: 'UPDATE_UNIT', unit: hidden }]).state;
    assert.deepEqual(viewBattlefield(working).unitsAt([0, 2]), []);
    assert.deepEqual(viewBattlefield(working).navigationModifiersAt([0, 2]), []);
    assert.notEqual(viewBattlefield(working).navigationMaps, maps);
    throw new Error('abort presence');
  }, /abort presence/);
  assert.equal(viewBattlefield(runtime).navigationMaps, maps);
  assert.equal(viewBattlefield(runtime).getUnit(1).spatialPresence.present, true);
  assert.deepEqual(viewBattlefield(runtime).unitsAt([0, 2]).map(unit => unit.id), [1]);
  assert.deepEqual(viewBattlefield(runtime).navigationModifiersAt([0, 2]), [1]);
});

test('core placement applies explicit claims to a declared occupancy capability', () => {
  const claims = [{ position: [0, 1], slot: 'DEPLOYMENT', type: 'RESERVATION' }];
  const placement = { definition: { id: 'placement', occupancy: {} }, position: [0, 0], claims };
  const battle = fixtureBattle(17);
  const direct = instantiateUnitPlacement(battle, placement).value.unit;
  const normalized = createUnitPlacementDefinition(placement);
  const placed = instantiateUnitPlacement(battle, normalized).value.unit;
  assert.equal(direct.occupancy.claims, claims);
  assert.equal(normalized.claims, claims);
  assert.equal(placed.occupancy.claims, claims);
  assert.equal(placed.definition, placement.definition);
  assert.equal(placed.position, placement.position);

  const nextClaims = [{ ...claims[0], position: [0, 2] }];
  const next = instantiateUnitPlacement(battle, { ...normalized, claims: nextClaims }).value.unit;
  assert.equal(next.occupancy.claims, nextClaims);
  assert.deepEqual(placed.occupancy.claims[0].position, [0, 1]);
  assert.throws(() => instantiateUnitPlacement(battle, {
    definition: { id: 'no-occupancy' }, position: [0, 0], claims,
  }), /occupancy capability/);
});

const catalogDefinition = () => Object.freeze({
  id: 'catalog_unit',
  spatialPresence: Object.freeze({}),
  vitality: Object.freeze({ maxHp: 100 }),
  locomotion: Object.freeze({
    moveSpeedPerTick: 0.1,
    steeringParameters: Object.freeze({ steeringFactor: 1, maxSteeringForce: 100 }),
  }),
  allegiance: Object.freeze({ side: 'ALLY' }),
  action: createActionCapabilityDefinition({ definitions: Definitions.empty().add(createAttack({ id: 'normal', speed: 100,
    triggerBindingId: 'primary',
    intervalTicks: 3, recoveryTicks: 0, followUps: [],
    targetGroups: [{ id: 'primary',
      operations: [{ type: 'DAMAGE', power: 10, damageType: 'PHYSICAL' }],
      targeting: { type: 'DAMAGE', scope: { type: 'RANGE', geometry: {
        type: 'SHAPES', geometry: { shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 1 }] },
      } }, canTargetAir: false, includeBlockingRelations: false, preferBlockingRelations: false,
        ignoreTargetFree: false, ignoreInvisible: false, maxTargets: 1 },
    }],
   })) }),
  spatial: Object.freeze({ layer: 'GROUND' }),
  hit: createHitDefinition({ geometry: { shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 0.25 }] } }),
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
  const locomotion = createRoutedLocomotionState(createLocomotionState(fixtureBattle(0), fixtureDefinition('locomotion')).value, { route, navigation: createNavigationState('WALK', [0, 0]) });
  locomotion.alternativeRoute = locomotion.mainRoute;
  return locomotion;
}

test('core unit initialization pairs every declared capability with its initializer state', () => {
  const definition = { ...catalogDefinition(), spatialPresence: {}, occupancy: {}, targetable: {},
    tileBinding: createTileBindingDefinition({ buildableType: 'ALL', heightType: null }) };
  const battle = fixtureBattle(17);
  const initialized = initializeUnit(battle, { id: 1, definition, position: [2, 0] });
  const unit = initialized.value;
  assert.equal(initialized.state, battle);
  assert.equal(unit.definition, definition);
  assert.equal(unit.vitality.hp, 100);
  assert.equal(unit.action.states.size, definition.action.definitions.size);
  assert.equal(hasRoutedLocomotion(unit), false);
  assert.equal(unit.spatialPresence.present, true);
  assert.deepEqual(unit.occupancy.claims, []);
  assert.deepEqual(unit.targetable.rules, []);
  assert.deepEqual(unit.tileBinding, {});
  assert.deepEqual(unit.blocker, { capacity: [], geometry: { radius: 0.7 }, enabled: true, rules: [] });
  assert.equal(resolveCapacity(unit.definition.blocker, unit.blocker), 2);
  assert.deepEqual(unit.blockable, { weight: 1, enabled: true });

  const next = initializeUnit(battle, { id: 2, definition, position: [0, 0] }).value;
  assert.notEqual(next.vitality, unit.vitality);
  assert.notEqual(next.action, unit.action);
  assert.notEqual(next.targetable, unit.targetable);
  const bare = initializeUnit(battle, {
    id: 3, definition: { id: 'presence-only', spatialPresence: {} }, position: [0, 0],
  }).value;
  assert.equal(hasSpatialPresence(bare), true);
  assert.equal(bare.spatialPresence.present, true);
  assert.equal(hasVitality(bare), false);
});

test('core initialization and snapshots share immutable definitions', () => {
  const definition = { id: 'shared-definition', vitality: { maxHp: 100 }, metadata: { labels: ['a'] } };
  const first = initialize({ id: 1, definition, position: [0, 0] });
  const second = initialize({ id: 2, definition, position: [1, 0] });
  const snapshot = copy(first);
  assert.equal(first.definition, definition);
  assert.equal(second.definition, definition);
  assert.equal(snapshot.definition, definition);
  assert.equal(snapshot.definition.metadata.labels, definition.metadata.labels);

  const revisedDefinition = { ...definition, vitality: { maxHp: 200 }, metadata: { labels: ['b'] } };
  const revised = initialize({ id: 3, definition: revisedDefinition, position: [0, 0] });
  assert.equal(revised.definition, revisedDefinition);
  assert.equal(revised.vitality.hp, 200);
  assert.equal(first.definition.vitality.maxHp, 100);
  assert.deepEqual(snapshot.definition.metadata.labels, ['a']);
});

test('archetype definitions share passive configuration while current allegiance changes independently', () => {
  const input = catalogDefinition();
  for (const createDefinition of [createOperatorDefinition, createCombatDefinition]) {
    const definition = createDefinition(input);
    assert.equal(definition.allegiance, input.allegiance);
    assert.equal(definition.spatial, input.spatial);
    assert.equal(definition.hit.geometry, input.hit.geometry);
    const unit = initialize({ id: 1, definition, position: [0, 0] });
    assert.equal(unit.allegiance, definition.allegiance);
    const changed = { ...unit, allegiance: { side: 'ENEMY' } };
    assert.equal(unit.allegiance.side, 'ALLY');
    assert.equal(changed.allegiance.side, 'ENEMY');
    assert.equal(changed.definition.allegiance.side, 'ALLY');
  }
});

test('core local state transitions retain capability values across snapshots', () => {
  const definition = { id: 'state-shapes', offense: { attack: 10 } };
  const offense = { ...initializeOffenseState(fixtureBattle(0), fixtureDefinition("offense")).value, marker: 'retained' };
  const original = initializeUnit(fixtureBattle(0), { id: 1, definition, position: [0, 0] }).value;
  const unit = { ...original, offense };
  assert.equal(unit.offense, offense);
  assert.equal(unit.offense.marker, 'retained');
  assert.equal(copy(unit).offense, offense);
});

test('core capability guards inspect composition independently of shared snapshot values', () => {
  const unit = initialize({ id: 1, definition: catalogDefinition(), position: [0, 0],
    states: { locomotion: catalogRoutedState() } });
  for (const [key, guard] of [
    ['vitality', hasVitality], ['locomotion', hasLocomotion], ['allegiance', hasAllegiance],
    ['action', hasAction], ['spatial', hasSpatial], ['hit', hasHit], ['blocker', hasBlocker],
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

  assert.equal(hasRoutedLocomotion({ ...unit, locomotion: createLocomotionState(fixtureBattle(0), fixtureDefinition("locomotion")).value }), false);
  assert.equal(hasRoutedLocomotion(unit), true);
  const presence = { id: 2, definition: Object.freeze({ id: 'presence', spatialPresence: {} }), position: [0, 0],
    spatialPresence: { present: false } };
  assert.deepEqual(copy(presence).spatialPresence, { present: false });


});

test('core snapshots share capabilities and retain earlier values across immutable updates', () => {
  const unit = initialize({ id: 1, definition: catalogDefinition(), position: [2, 0],
    states: { locomotion: catalogRoutedState(), spatialPresence: { present: true }, targetable: initializeTargetableState(fixtureBattle(0), fixtureDefinition("targetable")).value } });
  const snapshot = copy({ ...unit, extension: 'outside-unit-state' });
  assert.equal(Object.hasOwn(snapshot, 'extension'), false);
  assert.equal(snapshot.definition, unit.definition);
  assert.equal(snapshot.position, unit.position);
  for (const key of ['vitality', 'allegiance', 'action', 'spatial', 'hit', 'targetable',
    'blocker', 'blockable', 'spatialPresence', 'locomotion']) {
    assert.equal(snapshot[key], unit[key], key);
  }
  assert.equal(snapshot.locomotion.alternativeRoute, snapshot.locomotion.mainRoute);

  let runtime = presenceBattlefield();
  runtime = transitionBattlefield(runtime, [{ type: 'REGISTER_UNIT', unit }]).state;
  const previous = viewBattlefield(runtime);
  const mainRoute = snapshot.locomotion.mainRoute;
  const updated = { ...snapshot,
    vitality: { ...snapshot.vitality, hp: 25 },
    locomotion: { ...snapshot.locomotion, moving: true,
      mainRoute: { ...mainRoute, route: { ...mainRoute.route,
        progress: { ...mainRoute.route.progress,
          checkpoint: { ...mainRoute.route.progress.checkpoint, remainingTicks: 1 } },
      } },
    },
  };
  runtime = transitionBattlefield(runtime, [{ type: 'UPDATE_UNIT', unit: updated }]).state;

  assert.equal(viewBattlefield(runtime).getUnit(1), updated);
  assert.equal(previous.getUnit(1), unit);
  assert.equal(snapshot.vitality.hp, 100);
  assert.equal(snapshot.locomotion.moving, false);
  assert.equal(snapshot.locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 9);
  assert.equal(updated.locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 1);
  assert.equal(updated.locomotion.alternativeRoute, snapshot.locomotion.alternativeRoute);
  assert.equal(updated.locomotion.alternativeRoute.route.progress.checkpoint.remainingTicks, 9);
  assert.equal(updated.locomotion.mainRoute.navigation, snapshot.locomotion.mainRoute.navigation);
  assert.equal(updated.hit, snapshot.hit);
  assert.equal(updated.targetable, snapshot.targetable);
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
  const first = initialize({ id: 1, definition, position: [0, 0] });
  const second = initialize({ id: 2, definition, position: [1, 0] });
  const snapshot = copy(first);
  assert.equal(snapshot.hit.geometry, geometry);
  assert.equal(second.hit.geometry, geometry);
  assert.notEqual(first.hit, second.hit);
  assert.equal(snapshot.hit, first.hit);
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

test('core domain rules compose independently and preserve earlier unit states', () => {
  const definition = { id: 'rule_unit', vitality: { maxHp: 100 } };
  const first = initialize({ id: 1, definition, position: [0, 0],
    states: { targetable: initializeTargetableState(fixtureBattle(0), fixtureDefinition("targetable")).value } });
  const second = initialize({ id: 2, definition, position: [0, 0],
    states: { targetable: initializeTargetableState(fixtureBattle(0), fixtureDefinition("targetable")).value } });
  const source = { id: 3, definition: { id: 'query_source' }, position: [0, 0] };
  const selector = { type: 'HEAL', ignoreHealFree: false };
  const query = target => ({ source, target, battlefield: { getUnit: () => undefined },
    selector, purposes: ['HEAL'] });
  const restrictSource = { id: 'source-a', allows: context => context.source.id !== source.id };
  const restrictPurpose = { id: 'source-b', allows: context => context.purposes.includes('DAMAGE') };
  const one = setTargetableRule(first.targetable, restrictSource);
  const both = setTargetableRule(one, restrictPurpose);
  const afterOne = removeTargetableRule(both, 'source-a');
  const afterBoth = removeTargetableRule(afterOne, 'source-b');

  assert.equal(hasTargetable(first), true);
  assert.equal(hasTargetable({ id: 4, definition, position: [0, 0] }), false);
  assert.equal(one.rules[0], restrictSource);
  assert.equal(both.rules[0], one.rules[0]);
  assert.equal(setTargetableRule(both, restrictSource), both);
  assert.equal(removeTargetableRule(both, 'missing'), both);
  assert.equal(allowsTarget(query({ ...first, targetable: both })), false);
  assert.equal(allowsTarget(query({ ...first, targetable: afterOne })), false);
  assert.equal(allowsTarget(query({ ...first, targetable: afterBoth })), true);
  assert.equal(allowsTarget(query(first)), true);
  assert.equal(allowsTarget(query(second)), true);
  assert.equal(first.definition, second.definition);
  assert.deepEqual(first.targetable.rules, []);
  assert.equal(both.rules.length, 2);

  const denyHealing = id => ({ id, cancel: context =>
    context.ignoreHealFree ? null : { reason: 'SOURCE_REJECTS_HEALING' } });
  const vitalityOne = setHealingReceptionRule(first.vitality, denyHealing('healer-a'));
  const vitalityBoth = setHealingReceptionRule(vitalityOne, denyHealing('healer-b'));
  const healing = vitality => canReceiveHealing({ source, target: { ...first, vitality },
    battlefield: query(first).battlefield, ignoreHealFree: false });
  const withdrawnOne = removeHealingReceptionRule(vitalityBoth, 'healer-a');
  const withdrawnBoth = removeHealingReceptionRule(withdrawnOne, 'healer-b');

  assert.equal(healing(first.vitality), true);
  assert.equal(healing(vitalityBoth), false);
  assert.equal(healing(withdrawnOne), false);
  assert.equal(healing(withdrawnBoth), true);
  assert.equal(vitalityBoth.healingReceptionRules[0], vitalityOne.healingReceptionRules[0]);
  assert.equal(removeHealingReceptionRule(vitalityBoth, 'missing'), vitalityBoth);
  assert.equal(vitalityBoth.healingReceptionRules.length, 2);
  assert.deepEqual(second.vitality.healingReceptionRules, []);
});

test('core blocking uses current state radius and includes center-distance equality', () => {
  const map = createBattlefieldMap(1, 3, Array.from({ length: 3 }, () => deploymentTile()));
  const blocker = initialize({ id: 1, definition: Object.freeze({ id: 'radius_blocker',
    allegiance: { side: 'ALLY' }, blocker: createBlockerDefinition({ capacity: 1, geometry: { radius: 0.5 } }),
  }), position: [0, 0] });
  const blocked = initialize({ id: 2, definition: Object.freeze({ id: 'radius_enemy',
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
  let runtime = presenceBattlefield();
  const unit = initialize({ id: 1, definition: catalogDefinition(), position: [2, 0] });
  runtime = transitionBattlefield(runtime, [{ type: 'REGISTER_UNIT', unit }]).state;
  const maps = viewBattlefield(runtime).navigationMaps;
  for (const invalid of [{ ...unit, definition: Object.freeze({ ...unit.definition }) }]) {
    assert.throws(() => transitionBattlefield(runtime, [
      { type: 'SET_POSITION_AND_RELEASE_BLOCKING', unitId: 1, position: [3, 0] },
      { type: 'UPDATE_UNIT', unit: invalid },
    ]));
    assert.deepEqual(viewBattlefield(runtime).getUnit(1).position, [2, 0]);
    assert.deepEqual(viewBattlefield(runtime).unitsAt([0, 2]).map(value => value.id), [1]);
    assert.equal(viewBattlefield(runtime).navigationMaps, maps);
  }

  const bare = initialize({ id: 2, definition: Object.freeze({ id: 'bare' }), position: [0, 0] });
  runtime = transitionBattlefield(runtime, [{ type: 'REGISTER_UNIT', unit: bare }]).state;
  assert.throws(() => transitionBattlefield(runtime, [{ type: 'UPDATE_UNIT', unit: {
    ...bare, definition: Object.freeze({ ...bare.definition, vitality: { maxHp: 1 } }), vitality: initializeVitalityState(fixtureBattle(0), { maxHp: 1 }).value,
  } }]));

  const hidden = { ...viewBattlefield(runtime).getUnit(1), spatialPresence: { present: false } };
  runtime = transitionBattlefield(runtime, [{ type: 'UPDATE_UNIT', unit: hidden }]).state;
  assert.deepEqual(viewBattlefield(runtime).unitsAt([0, 2]), []);
  const restored = { ...viewBattlefield(runtime).getUnit(1), spatialPresence: { present: true } };
  runtime = transitionBattlefield(runtime, [{ type: 'UPDATE_UNIT', unit: restored }]).state;
  assert.deepEqual(viewBattlefield(runtime).unitsAt([0, 2]).map(value => value.id), [1]);
});

test('catalog products and core initializers preserve capability composition, definition unions and guard context', async () => {
  const { default: ts } = await import('typescript');
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-unit-types-'));
  const sourceModule = name => JSON.stringify(fileURLToPath(
    new URL(`../../src/core/tactical/unit/${name}.js`, import.meta.url)));
  const imports = `
import { initialize as initializeUnit } from ${sourceModule('initialize')};
import type { Product } from ${sourceModule('capability/catalog')};
import { initializeRoutedEnemy, type RoutedEnemySpawn } from ${sourceModule('../battle/creation/enemy')};
import { stepRoutedEnemy, type RoutedEnemyStepContext } from ${sourceModule('../../../legacy/enemy')};
import type { Unit, Definition as UnitDefinition } from ${sourceModule('unit')};
import type { ImmutableData } from ${sourceModule('../../common/immutable-data')};
import type { Ref } from ${sourceModule('../../common/ref')};
import { initialize as initializeOffenseState } from ${sourceModule('capability/offense/capability')};
import { initialize as initializeDefenseState } from ${sourceModule('capability/defense/capability')};
import { initialize as initializeActionState } from ${sourceModule('capability/action/capability')};
import type { Definition as EnemyDefinition } from ${sourceModule('archetype/enemy')};
import { hasVitality, type Vitality, type Definition as VitalityDefinition } from ${sourceModule('capability/vitality/capability')};
import { initialize as initializeLocomotionState, hasRoutedLocomotion, type Locomotion, type State as LocomotionState, type RoutedLocomotionState } from ${sourceModule('capability/locomotion/capability')};
import type { Targetable } from ${sourceModule('capability/targetable/capability')};
import { create as createBattlefieldState, transition } from ${sourceModule('../battlefield/state')};
import { view } from ${sourceModule('../battlefield/view')};
import type { BattlefieldView } from ${sourceModule('../battlefield/contract')};
import type { BattlefieldMap } from ${sourceModule('../battlefield/map/map')};
import { createUnitPlacementDefinition, instantiateUnitPlacement, type UnitPlacementDefinition } from ${sourceModule('../battle/creation/placement')};
import type { BattleExecutionState } from ${sourceModule('../battle/execution/state')};
import { launchProjectile, getProjectile, type ProjectileLaunchInput } from ${sourceModule('../battlefield/projectile/operations')};
import type { Definition as ProjectileDefinition } from ${sourceModule('../battlefield/projectile/definition')};
import type { Projectile } from ${sourceModule('../battlefield/projectile/projectile')};
import type { State as BattleState } from ${sourceModule('../battle/state')};
import { damage as damageElement } from ${sourceModule('capability/elemental/operations')};
type ElementDamageOutcome = ReturnType<typeof damageElement>['value'];
import type { Occupancy, State as OccupancyState } from ${sourceModule('capability/occupancy/capability')};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
interface EnemyProbe extends EnemyDefinition { readonly kind: 'enemy'; readonly enemyCode: 17; }
interface DeviceProbe extends UnitDefinition { readonly kind: 'device'; readonly deviceCode: 29; }
interface OptionalProbe extends UnitDefinition { readonly vitality?: VitalityDefinition; }
declare const enemyDefinition: EnemyProbe;
declare const enemySpawn: RoutedEnemySpawn<EnemyProbe>;
declare const enemyStepContext: RoutedEnemyStepContext;
declare const unionDefinition: EnemyProbe | DeviceProbe;
declare const routed: RoutedLocomotionState;
declare const battlefieldMap: BattlefieldMap;
declare const execution: BattleExecutionState;
declare const battleState: BattleState;
declare const projectileDefinition: ProjectileDefinition<{ readonly charges: number }>;
declare const projectileInput: ProjectileLaunchInput<{ readonly charges: number }>;
declare const typedProjectile: Projectile<{ readonly charges: number }>;
declare const placement: { readonly definition: EnemyProbe & { readonly occupancy: Readonly<Record<string, never>> }; readonly position: readonly [number, number]; readonly claims: readonly OccupancyState['claims'][number][] }
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
declare const elementalReport: ElementDamageOutcome;
if (elementalReport.type === "APPLIED" && elementalReport.burst !== null) {
  const targetId: number = elementalReport.burst.host.id;
}
if (elementalReport.type === "REJECTED") {
  const reason: string = elementalReport.reason;
}
initializeOffenseState(battleState, { attack: 1 }).value.attack;
initializeDefenseState(battleState, { defense: 1, resistance: 0 }).value.defense;
initializeLocomotionState(battleState, enemyDefinition.locomotion).value.moving;
declare const actionDefinition: Parameters<typeof initializeActionState>[1];
initializeActionState(battleState, actionDefinition).value.states;
// @ts-expect-error capability initialization requires the current BattleState.
initializeOffenseState({ attack: 1 });
// @ts-expect-error capability initialization requires the current BattleState.
initializeDefenseState({ defense: 1, resistance: 0 });
// @ts-expect-error clock-only context is not a BattleState.
initializeLocomotionState(enemyDefinition.locomotion, { tick: 7 });
// @ts-expect-error a tick is not a BattleState.
initializeActionState(7);
type Distributed = Assert<Equal<Product<EnemyProbe | DeviceProbe>, Product<EnemyProbe> | Product<DeviceProbe>>>;
type EnemyCapabilities = Assert<Product<EnemyProbe> extends Vitality & Locomotion ? true : false>;
type ProductDefinition = Assert<Equal<Product<EnemyProbe>['definition'], ImmutableData<EnemyProbe>>>;
type EmptyDefinitions = Assert<Product<{ readonly occupancy: {}; readonly targetable: {} }> extends Occupancy & Targetable ? true : false>;
type OptionalProduct = Assert<Equal<keyof Product<OptionalProbe>, 'definition'>>;
type MetadataIsNotCapability = Assert<Equal<keyof Product<{ readonly label: string }>, 'definition'>>;
type OptionalHasNoRequiredCapabilities = Assert<Equal<RequiredKeys<Unit & Product<OptionalProbe>>, 'id' | 'definition' | 'position' | 'effects' | 'lifecycle'>>;
type WideHasNoRequiredCapabilities = Assert<Equal<RequiredKeys<Unit & Product<UnitDefinition>>, 'id' | 'definition' | 'position' | 'effects' | 'lifecycle'>>;
function initializeGeneric<D extends EnemyDefinition>(definition: D): Unit & Product<D> {
  return initializeUnit(battleState, { id: 0, definition, position: [0, 0] }).value;
}
const enemy = initializeUnit(battleState, { id: 1, definition: enemyDefinition, position: [0, 0] }).value;
const baseUnit: Unit = enemy;
const instanceId: number = baseUnit.id;
const contentId: string = baseUnit.definition.id;
const plainDefinition: ImmutableData<EnemyProbe> = enemy.definition;
const acceptedDefinition: typeof enemy.definition = enemyDefinition;
type PlainUnit = Assert<Equal<typeof enemy, Unit & Product<EnemyProbe>>>;
const routedEnemy = initializeRoutedEnemy(battleState, enemySpawn).value.enemy;
const spawnedCode: 17 = routedEnemy.definition.enemyCode;
routedEnemy.locomotion.mainRoute.route.definition;
const movedEnemy = stepRoutedEnemy(routedEnemy, enemyStepContext).enemy;
const movedCode: 17 = movedEnemy.definition.enemyCode;
movedEnemy.locomotion.mainRoute.route.definition;
const union = initializeUnit(battleState, { id: 2, definition: unionDefinition, position: [0, 0] }).value;
type UnionUnit = Assert<Equal<typeof union, Unit & Product<EnemyProbe | DeviceProbe>>>;
const placed = instantiateUnitPlacement(battleState, placement).value;
const placedDefinition: ImmutableData<typeof placement['definition']> = placed.unit.definition;
const acceptedPlacementDefinition: typeof placed.unit.definition = placement.definition;
type ExpectedPlacement = (Unit & Product<EnemyProbe> & Occupancy) | (Unit & Product<DeviceProbe>);
type PlacementCapabilities = Assert<typeof placed.unit extends ExpectedPlacement ? true : false>;
type PlacementInput = Assert<ExpectedPlacement extends typeof placed.unit ? true : false>;
const normalizedPlacement = createUnitPlacementDefinition(placement);
const normalizedPlaced = instantiateUnitPlacement(battleState, normalizedPlacement).value;
type NormalizedPlacementCapabilities = Assert<typeof normalizedPlaced.unit extends ExpectedPlacement ? true : false>;
type NormalizedPlacementInput = Assert<ExpectedPlacement extends typeof normalizedPlaced.unit ? true : false>;
const requiredPlacement = createUnitPlacementDefinition({
  definition: { ...enemyDefinition, occupancy: {} }, position: [0, 0], claims: [], extra: 31,
});
const requiredPlaced = instantiateUnitPlacement(battleState, requiredPlacement).value;
requiredPlaced.unit.occupancy.claims;
const requiredOccupancy: Occupancy = requiredPlaced.unit;
type NormalizedPlacementFields = Assert<Equal<keyof typeof requiredPlacement, 'definition' | 'position' | 'claims' | 'navigationModifiers' | 'effects'>>;
if (union.definition.kind === 'enemy') { const code: 17 = union.definition.enemyCode; }
else { const code: 29 = union.definition.deviceCode; }
const ordinaryLocomotion: LocomotionState = enemy.locomotion;
declare const guarded: Unit & {
  readonly definition: ImmutableData<EnemyProbe>;
  readonly extra: 23;
};
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
const battlefield = createBattlefieldState({ map: battlefieldMap });
const battlefieldView: BattlefieldView = view(battlefield);
type RuleCache = Assert<Equal<Extract<keyof BattlefieldView['fieldCache'], 'invalidate' | 'clear'>, never>>;
const projectileResult = launchProjectile(battleState, projectileDefinition, projectileInput, 0);
type ProjectileIdentity = Assert<Equal<typeof projectileResult.value, Ref<Projectile<{ readonly charges: number }>>>>;
type ProjectileState = Assert<Equal<typeof projectileResult.state, BattleState>>;
const recoveredProjectile = getProjectile(projectileResult.state, projectileResult.value);
type ProjectileData = Assert<Equal<NonNullable<typeof recoveredProjectile>['state'], { readonly charges: number }>>;
battleState.battlefield.projectiles.add(typedProjectile);
battleState.battlefield.projectiles.replace(typedProjectile);
`);
    assert.deepEqual(positive, []);

    for (const [name, source] of [
      ['projectile-false-definition', `battleState.battlefield.projectiles.add({ ...typedProjectile, definition: { id: 'fake' } });`],
      ['projectile-wrong-initial-state', `launchProjectile(battleState, projectileDefinition, { ...projectileInput, initialState: { charges: 'wrong' } }, 0);`],
      ['projectile-wrong-state-pairing', `battleState.battlefield.projectiles.replace({ ...typedProjectile, state: { charges: 'wrong' } });`],
      ['projectile-untyped-callback', `getProjectile(battleState, 0)!.definition.acceptsContact;`],
      ['projectile-erased-transition', `transition(createBattlefieldState({ map: battlefieldMap }), [{ type: 'REGISTER_PROJECTILE', projectile: typedProjectile }]);`],
      ['state-extra-field', `initializeUnit(battleState, { id: 1, definition: { id: 'offense', offense: { attack: 1 } }, position: [0, 0], states: { offense: initializeOffenseState(battleState, { attack: 1 }).value } });`],
      ['mutable-definition', `initializeUnit(battleState, { id: 1, definition: { id: 'mutable', vitality: { maxHp: 10 } }, position: [0, 0] }).value.definition.vitality.maxHp = 99;`],
      ['unconfigured', `initializeUnit(battleState, { id: 1, definition: { id: 'bare' }, position: [0, 0] }).value.locomotion.moving;`],
      ['invalid-offense-config', `initializeUnit(battleState, { id: 1, definition: { id: 'invalid', offense: { attack: [] } }, position: [0, 0] });`],
      ['optional', `declare const optionalDefinition: OptionalProbe; initializeUnit(battleState, { id: 1, definition: optionalDefinition, position: [0, 0] }).value.vitality.hp;`],
      ['wide', `declare const wideDefinition: UnitDefinition; initializeUnit(battleState, { id: 1, definition: wideDefinition, position: [0, 0] }).value.locomotion.moving;`],
      ['base-unit-definition', `declare const unit: Unit; unit.definition.vitality.maxHp;`],
      ['missing-route-refinement', `initializeUnit(battleState, { id: 1, definition: enemyDefinition, position: [0, 0] }).value.locomotion.mainRoute;`],
      ['optional-normalized-occupancy', `declare const optionalPlacement: UnitPlacementDefinition<EnemyProbe>; instantiateUnitPlacement(battleState, createUnitPlacementDefinition(optionalPlacement)).value.unit.occupancy.claims;`],
      ['normalized-union-occupancy', `instantiateUnitPlacement(battleState, createUnitPlacementDefinition(placement)).value.unit.occupancy.claims;`],
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

const deploymentUnit = (id, position, definition, claims, present = true) => {
  const occupancy = { claims };
  validateOccupancyState(occupancy);
  return initialize({
    id, position, definition: Object.freeze({ id: `deployment_${id}`, ...definition }),
    states: { occupancy, spatialPresence: { present } },
  });
};

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
  const runtime = createFieldState({ map });
  const query = (type, column, playerSide = 'SIDE_A') => evaluateDeployment(viewBattlefield(runtime), {
    profile: createDeployableDefinition({ cost: 0, redeployTicks: 0, slots: 1, buildableType: type }), tile: [0, column], playerSide,
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
  assert.equal(viewBattlefield(runtime).navigationMaps.WALK.cells[2].passable, false);
  for (const [column, reason] of [[3, 'BUILDABLE_TYPE'], [4, 'PLAYER_SIDE'], [5, 'PLAYER_SIDE'],
    [6, 'BUILDABLE_TYPE'], [7, 'TERRAIN'], [8, 'OUTSIDE_MAP'], [-1, 'OUTSIDE_MAP']]) {
    assert.deepEqual(query('ALL', column), { type: 'DENIED', reason });
  }
  assert.deepEqual(query('ALL', 4, 'SIDE_B'), { type: 'ALLOWED', supportUnitId: null });
  assert.deepEqual(evaluateDeployment(viewBattlefield(runtime), {
    profile: createDeployableDefinition({ cost: 0, redeployTicks: 0, slots: 1, buildableType: 'ALL', advancedBuildableMask: 2 }),
    tile: [0, 7], playerSide: 'SIDE_A',
  }), { type: 'ALLOWED', supportUnitId: null });
  assert.deepEqual(evaluateDeployment(viewBattlefield(runtime), {
    profile: createDeployableDefinition({ cost: 0, redeployTicks: 0, slots: 1, buildableType: 'ALL', advancedBuildableMask: 3 }),
    tile: [0, 7], playerSide: 'SIDE_A',
  }), { type: 'ALLOWED', supportUnitId: null });
});

test('core occupancy separates present claims, reservations and geometric membership', () => {
  const claims = [{ position: [0, 1], slot: 'DEPLOYMENT', type: 'PRESENT' }];
  const valid = { claims };
  assert.equal(validateOccupancyState(valid), undefined);
  assert.equal(valid.claims, claims);
  assert.throws(() => validateOccupancyState({ claims: [{ ...claims[0], position: [0.5, 1] }] }), /integer/);
  assert.throws(() => validateOccupancyState({ claims: [{ ...claims[0], position: [0, Number.MAX_SAFE_INTEGER + 1] }] }), /integer/);
  let runtime = createFieldState({ map: createBattlefieldMap(1, 4,
    Array.from({ length: 4 }, () => deploymentTile())) });
  const present = deploymentUnit(1, [1, 0], {}, [
    { position: [0, 1], slot: 'DEPLOYMENT', type: 'PRESENT' },
  ], false);
  const reserved = deploymentUnit(2, [2, 0], {}, [
    { position: [0, 2], slot: 'DEPLOYMENT', type: 'RESERVATION' },
  ], false);
  const enemy = initialize({ id: 3, definition: Object.freeze({ id: 'enemy_without_claim' }), position: [1, 0] });
  runtime = transitionBattlefield(runtime, [present, reserved, enemy].map(unit => ({ type: 'REGISTER_UNIT', unit }))).state;
  assert.deepEqual(viewBattlefield(runtime).unitsAt([0, 1]).map(unit => unit.id), [3]);
  assert.deepEqual(viewBattlefield(runtime).occupancyAt([0, 1], 'DEPLOYMENT'), []);
  assert.deepEqual(viewBattlefield(runtime).occupancyAt([0, 2], 'DEPLOYMENT'), [2]);
  const profile = createDeployableDefinition({ cost: 0, redeployTicks: 0, slots: 1, buildableType: 'ALL' });
  assert.equal(evaluateDeployment(viewBattlefield(runtime), { profile, tile: [0, 1], playerSide: 'SIDE_A' }).type, 'ALLOWED');
  assert.deepEqual(evaluateDeployment(viewBattlefield(runtime), { profile, tile: [0, 2], playerSide: 'SIDE_A' }),
    { type: 'DENIED', reason: 'OCCUPIED' });

  const restored = { ...viewBattlefield(runtime).getUnit(1), spatialPresence: { present: true } };
  runtime = transitionBattlefield(runtime, [{ type: 'UPDATE_UNIT', unit: restored }]).state;
  assert.deepEqual(viewBattlefield(runtime).occupancyAt([0, 1], 'DEPLOYMENT'), [1]);
  assert.deepEqual(viewBattlefield(runtime).unitsAt([0, 1]).map(unit => unit.id), [1, 3]);
  const original = viewBattlefield(runtime);
  const previousUnit = original.getUnit(1);
  const occupancy = { claims: [
    { ...previousUnit.occupancy.claims[0], slot: 'SUPPORT' },
    { position: [0, 3], slot: 'DEPLOYMENT', type: 'RESERVATION' },
  ] };
  validateOccupancyState(occupancy);
  const updated = { ...previousUnit, occupancy };
  runtime = transitionBattlefield(runtime, [{ type: 'UPDATE_UNIT', unit: updated }]).state;
  assert.deepEqual(viewBattlefield(runtime).occupancyAt([0, 1], 'SUPPORT'), [1]);
  assert.deepEqual(viewBattlefield(runtime).occupancyAt([0, 3], 'DEPLOYMENT'), [1]);
  assert.equal(original.getUnit(1), previousUnit);
  assert.deepEqual(previousUnit.occupancy.claims,
    [{ position: [0, 1], slot: 'DEPLOYMENT', type: 'PRESENT' }]);
});

test('core support allows a platform and occupant to coexist without treating the platform as the occupant', () => {
  let runtime = createFieldState({ map: createBattlefieldMap(1, 3, [
    deploymentTile(), deploymentTile({ buildableType: 'NONE' }), deploymentTile(),
  ]) });
  const platform = deploymentUnit(1, [1, 0], {
    vitality: Object.freeze({ maxHp: 100 }),
    tileBinding: createTileBindingDefinition({ buildableType: 'RANGED', heightType: 'HIGHLAND' }),
  }, [{ position: [0, 1], slot: 'SUPPORT', type: 'PRESENT' }]);
  runtime = transitionBattlefield(runtime, [{ type: 'REGISTER_UNIT', unit: platform }]).state;
  const profile = createDeployableDefinition({ cost: 0, redeployTicks: 0, slots: 1, buildableType: 'RANGED' });
  assert.deepEqual(evaluateDeployment(viewBattlefield(runtime), { profile, tile: [0, 1], playerSide: 'SIDE_A' }),
    { type: 'ALLOWED', supportUnitId: 1 });
  const occupant = deploymentUnit(2, [1, 0], { deployable: profile }, [
    { position: [0, 1], slot: 'DEPLOYMENT', type: 'PRESENT' },
  ]);
  runtime = transitionBattlefield(runtime, [{ type: 'REGISTER_UNIT', unit: occupant }, { type: 'SET_SUPPORT_RELATIONS',
    relations: [{ supportedUnitId: 2, supportUnitId: 1 }] }]).state;
  assert.deepEqual(viewBattlefield(runtime).unitsAt([0, 1]).map(unit => unit.id), [1, 2]);
  assert.deepEqual(viewBattlefield(runtime).occupancyAt([0, 1], 'SUPPORT'), [1]);
  assert.deepEqual(viewBattlefield(runtime).occupancyAt([0, 1], 'DEPLOYMENT'), [2]);
  assert.equal(viewBattlefield(runtime).supportOf(2), 1);
  assert.deepEqual(viewBattlefield(runtime).supportedBy(1), [2]);
  assert.deepEqual(evaluateDeployment(viewBattlefield(runtime), { profile, tile: [0, 1], playerSide: 'SIDE_A' }),
    { type: 'DENIED', reason: 'OCCUPIED' });
  assert.deepEqual(evaluateDeployment(viewBattlefield(runtime), { profile, tile: [0, 1], playerSide: 'SIDE_A', relocatingUnitId: 2 }),
    { type: 'ALLOWED', supportUnitId: 1 });
  const retained = viewBattlefield(runtime);
  const removed = transitionBattlefield(runtime, [{ type: 'REMOVE_UNIT', unitId: 1, reason: 'SCRIPT' }]);
    runtime = removed.state;
  assert.deepEqual(removed.facts.lostSupports, [{ supportedUnitId: 2, supportUnitId: 1 }]);
  assert.equal(retained.supportOf(2), 1);
  assert.deepEqual(retained.supportRelations, [{ supportedUnitId: 2, supportUnitId: 1 }]);
  assert.equal(viewBattlefield(runtime).supportOf(2), undefined);
  assert.deepEqual(viewBattlefield(runtime).supportedBy(1), []);
  assert.deepEqual(viewBattlefield(runtime).supportRelations, []);
  assert.equal(viewBattlefield(runtime).getUnit(2).id, 2);
  assert.deepEqual(viewBattlefield(runtime).occupancyAt([0, 1], 'DEPLOYMENT'), [2]);
});

test('core navigation definitions are shared while modifier updates retain earlier views', () => {
  const definition = createNavigationModifierDefinition({
    id: 'shared-navigation', WALK: { denyPassage: false, deniedDepartures: ['LEFT'], costFloor: 1000 }, FLY: null,
  });
  const placement = createUnitPlacementDefinition({ definition: { id: 'source' }, position: [0, 0],
    navigationModifiers: [{ definition, range: [[0, 1]], direction: 'RIGHT' }] });
  let runtime = presenceBattlefield();
  const modifier = { ...presenceNavigationModifier(1, { type: 'UNIT', unitId: 1 },
    { type: 'FIXED', position: [0, 1], range: [[0, 0]], direction: 'RIGHT' }), definition };
  runtime = transitionBattlefield(runtime, [{ type: 'REGISTER_UNIT', unit: presenceUnit(1, [0, 0]) },
    { type: 'ADD_NAVIGATION_MODIFIER', navigationModifier: modifier }]).state;
  const original = viewBattlefield(runtime);
  const maps = original.navigationMaps;
  assert.equal(placement.navigationModifiers[0].definition, definition);
  assert.equal(original.getNavigationModifier(1), modifier);
  assert.equal(original.getNavigationModifier(1).definition, definition);
  assert.equal(maps.WALK.cells[1].passable, true);
  assert.equal(maps.WALK.cells[1].moveCost, 1000);

  const restricted = createNavigationModifierDefinition({ ...definition,
    WALK: { ...definition.WALK, denyPassage: true, deniedDepartures: ['LEFT', 'RIGHT'] },
  });
  const replacement = { ...modifier, definition: restricted };
  runtime = transitionBattlefield(runtime, [{ type: 'REMOVE_NAVIGATION_MODIFIER', navigationModifierId: 1 },
    { type: 'ADD_NAVIGATION_MODIFIER', navigationModifier: replacement }]).state;
  assert.equal(viewBattlefield(runtime).getNavigationModifier(1), replacement);
  assert.equal(viewBattlefield(runtime).navigationMaps.WALK.cells[1].passable, false);
  assert.equal(original.getNavigationModifier(1), modifier);
  assert.equal(original.navigationMaps, maps);
  assert.equal(maps.WALK.cells[1].passable, true);
  assert.deepEqual(definition.WALK.deniedDepartures, ['LEFT']);
});
