import { all as supports, lost } from '../../dist/core/tactical/battlefield/support.js';
import * as route from '../../dist/core/tactical/unit/capability/route/operations.js';
import * as locomotion from '../../dist/core/tactical/unit/capability/locomotion/operations.js';
import * as units from '../../dist/core/tactical/unit/query.js';
import { createBattleState, registerUnit, updateUnit } from '../../dist/core/tactical/battle/state.js';
import { create as createField } from '../../dist/core/tactical/battlefield/state.js';
import * as blocking from '../../dist/core/tactical/battle/blocking/operations.js';
import { blockedIds, fixture as blockingFixture } from '../helpers/blocking.js';
import { fixtureBattle } from "../helpers/unit.js";
import { Effects } from "../../dist/core/tactical/unit/effect/effects.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBattlefieldMap, BattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';
import { create as projectStaticNavigationMap } from '../../dist/core/tactical/battlefield/map/navigation.js';
import {
  createBattlefieldState, maintain,
} from '../../dist/core/tactical/battlefield/storage/state.js';
import { maintainFully } from '../helpers/battlefield-projection.js';
import { Map as NavigationMap } from '../../dist/core/tactical/battlefield/navigation/map.js';
import { apply, create as createOverlay } from '../../dist/core/tactical/battlefield/navigation/overlay.js';
import { create as createNavigation, setOverlay, removeOverlay, nextPoint } from '../../dist/core/tactical/battlefield/navigation/state.js';
import { parseBattlefieldMap } from '../../dist/data/arknights/map.js';
import { parseRouteDefinition } from '../../dist/data/arknights/route.js';
import { createRng } from '../../dist/core/common/rng.js';
import { World } from '../../dist/core/tactical/geometry/coordinate.js';

import { initialize as initializeRoutedUnit } from "../../dist/core/tactical/battle/creation/routed-unit.js";
import { copy } from '../../dist/core/tactical/unit/snapshot.js';
import { initialize } from "../helpers/unit.js";
import { createDefinition as createTileBindingDefinition } from '../../dist/core/tactical/unit/capability/tile-binding/capability.js';
import * as blockable from '../../dist/core/tactical/unit/capability/blocking/blockable.js';
import { setRule as setBlockerRule } from '../../dist/core/tactical/unit/capability/blocking/blocker.js';
import { Grid, OBSTACLE_COST, bresenhamTiles } from '../../server/sim/grid.js';
import { flowFieldForGrid, navigationMapFromGrid, waypointsForGrid } from '../helpers/legacy-navigation.js';
import { build } from '../../dist/core/tactical/battlefield/navigation/field.js';
import { getDefaultSource, hasGeneratedData } from '../../server/sim/simdata.js';
import { makeBattle, flatStage, enemyRec } from '../helpers/battleHarness.js';
import { remainingDistance } from '../../server/sim/ai.js';
import * as contribution from '../../dist/core/tactical/unit/contribution/contribution.js';
import * as modifier from '../../dist/core/tactical/unit/contribution/attribute.js';

const REAL = { skip: !hasGeneratedData() && 'no generated data' };
const NORMAL = { r0: 9, r1: 12, c0: 0, c1: 10 };
const walker = (o = {}) => enemyRec({ key: 'enemy_walker', hp: 1e6, speed: 1, ...o });
const K = (r, c) => r * 21 + c;

/** Grid of a real stage with its match-start devices (crates cost 1000, platforms / mounds blocked). */
function stageGrid(id) {
  const st = getDefaultSource().getStage(id);
  const g = new Grid(st, NORMAL);
  for (const d of st.raw.devices) {
    if (!d.active || !d.pos) continue;
    if (d.role === 'crate') g.setObstacle(d.pos[0], d.pos[1], true, 'crate');
    if (d.role === 'platform' || d.role === 'mound') g.setObstacle(d.pos[0], d.pos[1], true);
  }
  return g;
}
const wp = (g, r, c) => g.waypoints(r, c, 9, 2).map((p) => `(${p})`).join(' ');

function tilesForGrid(g, sr, sc, er, ec, options) {
  const points = waypointsForGrid(g, sr, sc, er, ec, options);
  if (points === null) return null;
  const tiles = [points[0]];
  for (let i = 1; i < points.length; i++) tiles.push(...bresenhamTiles(points[i - 1], points[i]).slice(1));
  return tiles;
}

test('core flow field through legacy input preserves distances and valid one-step gradients', () => {
  const g = new Grid(flatStage(), NORMAL);
  const f = flowFieldForGrid(g, 9, 2);
  assert.equal(f.dist[K(9, 2)], 0);
  assert.equal(f.dist[K(9, 10)], 8, 'Manhattan distance along the open lane');
  assert.equal(f.dist[K(12, 10)], 11, 'no diagonal edges: 3 + 8');
  // every raw parent is a 4-neighbour one step closer
  for (let k = 0; k < f.dist.length; k++) {
    if (f.dist[k] <= 0) continue;
    const p = f.parent[k];
    assert.equal(Math.abs(((p / 21) | 0) - ((k / 21) | 0)) + Math.abs((p % 21) - (k % 21)), 1);
    assert.equal(f.dist[p], f.dist[k] - 1);
  }
  // walls are not walkable: the high ground at col 2 of rows 10–12 has no distance
  assert.equal(f.dist[K(11, 2)], -1);
});

test('core smoothing through legacy input: straight and diagonal hops respect blocked corners', () => {
  const g = new Grid(flatStage(), NORMAL);
  assert.deepEqual(waypointsForGrid(g, 9, 10, 9, 2), [[9, 10], [9, 2]], 'straight lane');
  assert.deepEqual(waypointsForGrid(g, 12, 10, 9, 2), [[12, 10], [9, 2]], 'open field: one straight line to the goal');
  // the crossed tiles form an 8-connected chain that never cuts a corner
  const p = tilesForGrid(g, 12, 10, 9, 2);
  assert.deepEqual(p, bresenhamTiles([12, 10], [9, 2]));
  for (let i = 1; i < p.length; i++) {
    const [r0, c0] = p[i - 1], [r1, c1] = p[i];
    assert.ok(Math.abs(r1 - r0) <= 1 && Math.abs(c1 - c0) <= 1);
    if (r1 !== r0 && c1 !== c0) assert.ok(g.walkable(r0, c1) && g.walkable(r1, c0));
  }
  // a wall stub at (10,6)…(12,6): the upper route bends around its end instead of cutting through
  for (const r of [10, 11, 12]) g.setObstacle(r, 6, true);
  const bent = waypointsForGrid(g, 12, 10, 9, 2);
  assert.ok(bent.length > 2);
  for (const [r, c] of tilesForGrid(g, 12, 10, 9, 2)) assert.ok(!(c === 6 && r >= 10), `crosses the wall at (${r},${c})`);

});

test('crates: walkable at cost 1000 (blocks line of sight), blocks are impassable; each kind toggles its own bit', () => {
  const g = new Grid(flatStage(), NORMAL);
  const v0 = g.version;
  g.setObstacle(9, 6, true, 'crate');
  assert.ok(g.version > v0 && g.isObstacle(9, 6) && g.isCrate(9, 6) && !g.isBlocked(9, 6));
  assert.equal(g.groundPassable(9, 6), false, 'not a placement / displacement tile');
  assert.equal(g.walkable(9, 6), true, 'but walkable for the flow field');
  let f = flowFieldForGrid(g, 9, 2);
  assert.equal(f.dist[K(9, 6)], 3 + OBSTACLE_COST, "(9,5) is 3 from the goal, departing the crate costs 1000");
  assert.ok(!tilesForGrid(g, 9, 10, 9, 2).some(([r, c]) => r === 9 && c === 6), 'detours around the crate');
  // wall off every detour: the crate is the only way — the path goes through it (the enemy will break it)
  for (const r of [10, 11, 12]) g.setObstacle(r, 6, true);
  f = flowFieldForGrid(g, 9, 2);
  assert.ok(f.dist[K(9, 10)] > OBSTACLE_COST);
  assert.ok(tilesForGrid(g, 9, 10, 9, 2).some(([r, c]) => r === 9 && c === 6), 'through the crate');
  // a crate turned into a platform on the same tile: both bits, order-independent
  g.setObstacle(9, 6, true, 'block');
  g.setObstacle(9, 6, false, 'crate');
  assert.ok(g.isBlocked(9, 6) && !g.isCrate(9, 6));
  assert.equal(tilesForGrid(g, 9, 10, 9, 2), null, 'fully walled');
  assert.ok(tilesForGrid(g, 9, 10, 9, 2, { ignoreObstacles: true }));
});

test('legacy field adapter caches per immutable map, destination and effective options', () => {
  const g = new Grid(flatStage(), NORMAL);
  const a = flowFieldForGrid(g, 9, 2);
  assert.equal(flowFieldForGrid(g, 9, 2), a);
  assert.notEqual(flowFieldForGrid(g, 9, 3), a);
  assert.deepEqual(flowFieldForGrid(g, 9, 2, { allowDiagonal: false }).next, a.next);
  assert.notEqual(navigationMapFromGrid(g, { pathMotionMode: 'FLY' }), navigationMapFromGrid(g));
  assert.notEqual(navigationMapFromGrid(new Grid(flatStage(), NORMAL)), navigationMapFromGrid(g));
  g.setObstacle(10, 5, true);
  assert.notEqual(flowFieldForGrid(g, 9, 2), a, 'rebuilt after an obstacle change');
  g.setObstacle(10, 5, true); // no change → no version bump
  const b = flowFieldForGrid(g, 9, 2);
  assert.equal(flowFieldForGrid(g, 9, 2), b);
});

test('legacy stage lanes retain blockable-ground preference', REAL, () => {
  // m01 lower gate: equal-length choice between the col-9 floor lane and the col-8 road — the road (blockable) wins
  // (official: (9,9) → (12,8) through the floor of (10,9)); m04 lower gate: the official diagonal (9,10) → (10,7) only
  // brushes the corner of the floor (10,9) and stays (community report D5, test/sim/pathing-official.test.js)
  const lanes = {
    act1autochess_m01: ['(12,10) (12,4) (9,4) (9,2)', '(9,10) (9,8) (12,8) (12,4) (9,4) (9,2)'],
    act1autochess_m02: ['(12,10) (12,3) (9,3) (9,2)', '(9,10) (9,9) (11,9) (11,6) (9,6) (9,2)'],
    act1autochess_m03: ['(12,10) (12,6) (11,6) (9,5) (9,2)', '(9,10) (9,2)'], // 射击台 on (10,3)/(10,4) block [ASSUMED]
    act1autochess_m04: ['(12,10) (12,9) (11,9) (11,4) (9,4) (9,2)', '(9,10) (10,7) (10,4) (9,4) (9,2)'],
    act2autochess_m01: ['(12,10) (12,9) (9,9) (9,7) (12,7) (12,5) (9,5) (9,2)', '(9,10) (9,7) (12,7) (12,5) (9,5) (9,2)'],
    act2autochess_m02: ['(12,10) (12,7) (9,7) (9,2)', '(9,10) (9,2)'],
    act2autochess_m03: ['(12,10) (12,4) (9,4) (9,2)', '(9,10) (9,9) (10,9) (10,6) (9,6) (9,2)'],
    act2autochess_m04: ['(12,10) (12,4) (9,4) (9,2)', '(9,10) (9,6) (11,6) (11,4) (9,4) (9,2)'],
  };
  for (const [id, [up, low]] of Object.entries(lanes)) {
    const g = stageGrid(id);
    assert.equal(wp(g, 12, 10), up, `${id} upper gate`);
    assert.equal(wp(g, 9, 10), low, `${id} lower gate`);
  }
});

/** Tiles an enemy of `route` visits (rounded position per tick) on a real stage. */
function walk(stageId, route) {
  const h = makeBattle({ stageId, defs: { enemies: { enemy_walker: walker() } }, enemies: [{ key: 'enemy_walker', route }], content: 'none', autoFinish: false, timeLimit: 120 });
  const seen = [];
  h.b.on('tick', () => {
    for (const e of h.b.enemies) {
      const k = `${Math.round(e.y)},${Math.round(e.x)}`;
      if (seen[seen.length - 1] !== k) seen.push(k);
    }
  });
  h.runUntil(() => h.b.enemies.length === 0 && h.b.time > 1, 120);
  return { seen, leaked: h.result().perPlayer.p1.leaked.length };
}

test('act1 m02 (下半, no crates): an upper-gate enemy keeps the top road to col 3 instead of dropping into the lower lane', REAL, () => {
  const { seen, leaked } = walk('act1autochess_m02', { motion: 'WALK', start: [12, 10], end: [9, 2], checkpoints: [] });
  assert.equal(leaked, 1);
  const i3 = seen.indexOf('12,3');
  assert.ok(i3 > 0, `reaches (12,3): ${seen.join(' ')}`);
  for (const t of seen.slice(0, i3)) assert.equal(t.split(',')[0], '12', `stays on row 12 before col 3: ${seen.join(' ')}`);
  assert.ok(!seen.includes('9,6') && !seen.includes('10,6'), 'never takes col 6 down to the lower lane');
  // the battle spawned no crate on m02 at match start
  const h = makeBattle({ stageId: 'act1autochess_m02', content: 'none', timeLimit: 1 });
  h.step();
  assert.equal(h.b.allyUnits.filter((u) => u.kind === 'device').length, 0);
});

test('act1 m04: an upper-gate enemy stays on row 11 down to col 4 (does not join the lower-gate lane at once)', REAL, () => {
  const { seen } = walk('act1autochess_m04', { motion: 'WALK', start: [12, 10], end: [9, 2], checkpoints: [] });
  const i4 = seen.indexOf('11,4');
  assert.ok(i4 > 0, seen.join(' '));
  for (const t of seen.slice(seen.indexOf('11,9'), i4 + 1)) assert.equal(t.split(',')[0], '11', `row 11: ${seen.join(' ')}`);
  const low = walk('act1autochess_m04', { motion: 'WALK', start: [9, 10], end: [9, 2], checkpoints: [] }).seen;
  assert.ok(low.includes('10,7') && low.includes('10,4') && !low.includes('11,6'), `lower gate on row 10: ${low.join(' ')}`);
});

test('crates in battle: detour when one exists; otherwise the enemy walks into the crate, is blocked and breaks it', () => {
  // detour available: never enters the crate tile
  const h = makeBattle({ flat: { crates: [[9, 6]] }, defs: { enemies: { enemy_walker: walker({ atk: 100 }) } }, enemies: [{ key: 'enemy_walker' }], content: 'none', autoFinish: false });
  let touched = false;
  h.b.on('tick', () => { for (const u of h.b.enemies) if (Math.round(u.y) === 9 && Math.round(u.x) === 6) touched = true; });
  h.runUntil(() => h.b.enemies.length === 0 && h.b.time > 1, 40);
  assert.equal(touched, false);
  assert.equal(h.result().perPlayer.p1.leaked.length, 1);
  // only way: through the crate
  const rows = { 10: '##hrrr#rrrfrrrrrrrf##', 11: '##hrrr#rrrfrrrrrrrf##', 12: '##hrrr#rrrSrrrrrrrS##' };
  const h2 = makeBattle({ flat: { rows, crates: [[9, 6]] }, defs: { enemies: { enemy_walker: walker({ atk: 500, bat: 1 }) } }, enemies: [{ key: 'enemy_walker' }], content: 'none', autoFinish: false });
  h2.step();
  const crate = h2.b.allyUnits.find((u) => u.kind === 'device');
  assert.ok(crate && h2.b.grid.isCrate(9, 6));
  const e = h2.enemy('enemy_walker');
  assert.ok(h2.runUntil(() => e.blockedBy === crate, 20), 'blocked by the crate');
  assert.ok(h2.runUntil(() => !crate.alive, 10), 'breaks it');
  assert.equal(h2.b.grid.isObstacle(9, 6), false);
  h2.runUntil(() => !e.alive, 30);
  assert.equal(h2.result().perPlayer.p1.leaked.length, 1);
});

test('remaining distance follows the smoothed flow-field route (targeting "closest to the goal")', REAL, () => {
  const route = { motion: 'WALK', start: [12, 10], end: [9, 2], checkpoints: [] };
  const h = makeBattle({ defs: { enemies: { enemy_walker: walker() } }, enemies: [{ key: 'enemy_walker', route }], content: 'none', autoFinish: false });
  h.run(2);
  const e = h.enemy('enemy_walker');
  approx(remainingDistance(h.b, e), Math.hypot(e.y - 9, e.x - 2), 'open field: one straight segment');
  // act1 m02: along the top road — (12,3) then down col 3
  const h2 = makeBattle({ stageId: 'act1autochess_m02', defs: { enemies: { enemy_walker: walker() } }, enemies: [{ key: 'enemy_walker', route }], content: 'none', autoFinish: false });
  h2.run(2);
  const e2 = h2.enemy('enemy_walker');
  approx(remainingDistance(h2.b, e2), Math.hypot(e2.y - 12, e2.x - 3) + 3 + 1, 'to (12,3), down to (9,3), then (9,2)');
});

function approx(a, b, msg) { assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`); }

const fieldCell = (overrides = {}) => ({
  passable: true, cost: 1, departures: { UP: true, RIGHT: true, DOWN: true, LEFT: true }, ...overrides,
});
const fieldMap = (rows, columns, cells) => new NavigationMap(rows, columns, cells);
const fieldQuery = targetTile => targetTile;
const distances = field => field.nodes.map(node => node === null ? -1 : node.distance);
const effectiveMaps = navigation => ({
  WALK: apply(navigation.baseline.WALK, navigation.overlays.WALK),
  FLY: apply(navigation.baseline.FLY, navigation.overlays.FLY),
});

test('core fields charge departing cells and publish only immutable smoothed successors', () => {
  const map = fieldMap(1, 3, [fieldCell({ cost: 7 }), fieldCell({ cost: 3 }), fieldCell({ cost: 1000 })]);
  const target = [0, 2];
  const before = JSON.stringify({ map, target });
  const field = build(map, target);
  assert.deepEqual(distances(field), [10, 3, 0]);
  assert.deepEqual(field.nodes[0].next, [0, 1]);
  assert.equal(field.nodes[2].next, null);
  assert.deepEqual(Object.keys(field.nodes[0]).sort(), ['distance', 'next']);
  assert.equal(Object.hasOwn(field, 'map'), false);
  assert.equal(JSON.stringify({ map, target }), before);
  assert.ok(Object.isFrozen(field) && Object.isFrozen(field.nodes));
  assert.ok(field.nodes.every(Object.isFrozen));
  assert.notStrictEqual(field.target, target);
  assert.deepEqual(build(map, target), field);
});

test('core fields preserve directed search, target qualification and disconnected regions', () => {
  const map = fieldMap(1, 3, [fieldCell(), fieldCell({ departures: { UP: true, RIGHT: true, DOWN: true, LEFT: false } }), fieldCell()]);
  assert.deepEqual(distances(build(map, [0, 0])), [0, -1, -1]);
  assert.deepEqual(distances(build(map, [0, 2])), [2, 1, 0]);
  const noGoalDepartures = fieldMap(1, 3, [fieldCell(), fieldCell(), fieldCell({ departures: { UP: false, RIGHT: false, DOWN: false, LEFT: false } })]);
  assert.deepEqual(distances(build(noGoalDepartures, [0, 2])), [2, 1, 0]);
  const blocked = fieldMap(1, 3, [fieldCell(), fieldCell({ passable: false }), fieldCell()]);
  assert.deepEqual(build(blocked, [0, 1]).nodes, [null, null, null]);
  assert.deepEqual(distances(build(blocked, [0, 2])), [-1, -1, 0]);
  const bounded = fieldMap(2, 3, Array.from({ length: 6 }, () => fieldCell()));
  for (const target of [[-1, 0], [2, 0], [0, -1], [0, 3], [-1, 3], [1, -1]]) {
    const field = build(bounded, target);
    assert.deepEqual(field.nodes, [null, null, null, null, null, null]);
    assert.deepEqual(field.target, target);
    assert.equal(field.rows, 2);
    assert.equal(field.columns, 3);
    assert.ok(Object.isFrozen(field) && Object.isFrozen(field.nodes));
    assert.notStrictEqual(field.target, target);
  }
});

test('core fields retain FIFO UP-RIGHT-DOWN-LEFT ties when smoothing cannot merge the hop', () => {
  const cells = Array.from({ length: 9 }, () => fieldCell());
  cells[0] = fieldCell({ cost: 1000 });
  const field = build(fieldMap(3, 3, cells), [0, 0]);
  assert.equal(field.nodes[4].distance, 2);
  assert.deepEqual(field.nodes[4].next, [1, 0]);
});

test('core fields preserve safe-integer shortest distances and ignore nonimproving overflow candidates', () => {
  assert.deepEqual(distances(build(fieldMap(1, 3, [fieldCell(), fieldCell({ cost: 0x7fffffff }), fieldCell()]), [0, 0])), [0, 0x7fffffff, 0x80000000]);
  const half = 2 ** 52;
  const replaceable = fieldMap(2, 2, [fieldCell(), fieldCell(), fieldCell({ cost: half }), fieldCell({ cost: half + 2 })]);
  assert.deepEqual(distances(build(replaceable, [0, 0])), [0, 1, half, half + 3]);
  const unsafe = fieldMap(1, 3, [fieldCell(), fieldCell({ cost: Number.MAX_SAFE_INTEGER }), fieldCell()]);
  assert.throws(() => build(unsafe, [0, 0]), RangeError);
  assert.deepEqual(distances(build(fieldMap(1, 2, [fieldCell({ cost: Number.MAX_SAFE_INTEGER }), fieldCell()]), [0, 1])), [Number.MAX_SAFE_INTEGER, 0]);
});

test('core smoothing retains the native thin-rectangle and inclusive-endpoint checks', () => {
  const thin = Array.from({ length: 10 }, () => fieldCell());
  thin[5] = fieldCell({ passable: false });
  assert.deepEqual(build(fieldMap(2, 5, thin), [1, 4]).nodes[0].next, [0, 4]);
  const endpoint = fieldMap(1, 3, [fieldCell(), fieldCell(), fieldCell({ departures: { ...fieldCell().departures, RIGHT: false } })]);
  const field = build(endpoint, [0, 2]);
  assert.deepEqual(field.nodes[0].next, [0, 1]);
  assert.deepEqual(distances(field), [2, 1, 0]);
});

test('core smoothing uses the current row-major successor chain without a weighted shortcut budget', () => {
  const moderate = fieldMap(2, 3, [fieldCell(), fieldCell({ cost: 20 }), fieldCell(), fieldCell(), fieldCell(), fieldCell()]);
  const straight = build(moderate, [0, 2]);
  assert.equal(straight.nodes[0].distance, 4);
  assert.deepEqual(straight.nodes[0].next, [0, 2]);
  const cells = Array.from({ length: 16 }, (_, index) => fieldCell({ passable: ![5, 10, 14].includes(index) }));
  assert.deepEqual(build(fieldMap(4, 4, cells), [3, 3]).nodes[13].next, [3, 0]);
  const obstacle = fieldMap(1, 3, [fieldCell(), fieldCell({ cost: 1000 }), fieldCell()]);
  assert.deepEqual(build(obstacle, [0, 2]).nodes[0].next, [0, 1]);
});

const battlefieldUnit = (id, position) => ({
  effects:Effects.empty(), id, definition: Object.freeze({ id: `battlefield_unit_${id}` }), position: Object.freeze([...position]),
});

function projectionFacts(state) {
  const definitionFacts = ({ initialize, start, step, onEnd, ...definition }) => definition;
  const ruleFacts = (unit, rules) => rules.map(rule => ({ id: rule.id, allows: rule.allows(unit) }));
  return { ...state, navigation: { ...state.navigation, baseline: { WALK: { ...state.navigation.baseline.WALK }, FLY: { ...state.navigation.baseline.FLY } } }, projectiles: state.projectiles.values().toArray(), units: new Map([...state.units].map(([id, unit]) => [
    id, { ...unit, effects: unit.effects.toJSON(), definition: unit.definition.action === undefined
      ? unit.definition
      : { ...unit.definition, action: { ...unit.definition.action,
        definitions: unit.definition.action.definitions.values().toArray().map(definitionFacts),
      } },
      ...(unit.action === undefined ? {} : { action: { ...unit.action,
        states: new Map(unit.action.states.values().map(current => [current.definition.id, {
          ...current, definition: definitionFacts(current.definition),
        }])),
      } }),
      ...(unit.blocker === undefined ? {} : { blocker: { ...unit.blocker,
        rules: ruleFacts(unit, unit.blocker.rules),
      } }),
      ...(unit.blockable === undefined ? {} : { blockable: { ...unit.blockable,
        rules: ruleFacts(unit, unit.blockable.rules),
      } }),
    },
  ])) };
}

function battlefieldProjectionHarness(rows = 2, columns = 5,
  map = createBattlefieldMap(rows, columns, Array.from({ length: rows * columns }, () => coreGround()))) {
  const branches = [maintain, maintainFully].map(settle => {
    const baseline = Object.freeze({
      WALK: projectStaticNavigationMap(map, 'WALK', 0),
      FLY: projectStaticNavigationMap(map, 'FLY', 0),
    });
    return { baseline, settle, state: { map, ...createBattlefieldState(map, createNavigation(baseline)) } };
  });
  const equivalent = () => {
    const [selective, full] = branches.map(branch => branch.state);
    assert.deepEqual(selective, full);
    assert.deepEqual([...selective.units], [...full.units]);
    for (const key of ['unitsByTile']) {
      const entries = state => [...state.spatial[key]].map(([key, ids]) => [key, [...ids]]);
      assert.deepEqual(entries(selective), entries(full));
    }
  };
  const commit = transform => {
    const content = transform(branches[0].state);
    const results = branches.map(branch => {
      const previous = branch.state;
      const snapshot = structuredClone(projectionFacts(previous));
      const settled = branch.settle(previous, content);
      assert.deepEqual(projectionFacts(previous), snapshot);
      branch.state = settled;
      return { lostSupports: lost(previous, settled).map(relation => ({ supportedUnitId: relation.occupant.id, supportUnitId: relation.support.id })) };
    });
    assert.deepEqual(results[0], results[1]);
    equivalent();
    return results[0];
  };
  const reject = (transform, expected) => {
    const content = transform(branches[0].state);
    for (const branch of branches) {
      const previous = branch.state;
      const snapshot = structuredClone(projectionFacts(previous));
      assert.throws(() => {
        branch.settle(previous, content);
      }, expected);
      assert.equal(branch.state, previous);
      assert.deepEqual(projectionFacts(previous), snapshot);
    }
    equivalent();
  };
  return { branches, commit, reject, equivalent, get state() { return branches[0].state; } };
}

const projectionRegistration = (column, slot = 'OCCUPANT') => ({ tile: [0, column], slot });
const projectionUnit = (id, position, definition = {}, states = {}) => initialize({
  id, position, definition: Object.freeze({ id: `projection_unit_${id}`, spatialPresence: {}, ...definition }), states,
});

test('core selective projection retains untouched collections, indexes and route intent on nonspatial updates', () => {
  const h = battlefieldProjectionHarness();
  const routed = routedEnemyHarness({ speedPerTick: 0.1, checkpoints: [coreMove(4)] });
  h.commit(state => ({ ...state, units: new Map([...state.units, ...[routed.enemy].map(unit => [unit.id, unit])]) }));
  const previous = h.state;
  const progress = previous.units.get(1).route.main;
  h.commit(state => ({ ...state, units: new Map([...state.units, ...[{
    ...state.units.get(1), vitality: { ...state.units.get(1).vitality, hp: 90 },
  }].map(unit => [unit.id, unit])]) }));
  assert.notEqual(h.state.units, previous.units);
  assert.equal(h.state.spatial, previous.spatial);
  assert.equal(h.state.occupancy, previous.occupancy);
  assert.equal('blockingRelations' in h.state, false);
  assert.equal(h.state.navigation, previous.navigation);
  assert.equal(h.state.units.get(1).route.main, progress);
  assert.equal(h.state.units.get([...h.state.spatial.unitsByTile.get(0)][0]).vitality.hp, 90);
  assert.equal(previous.units.get(1).vitality.hp, 100);
});

test('complete battle updates retain or release blocking from the tile blocking fact independently of passability', () => {
  const passableMasks = ['ALL', 'FLY_ONLY', 'WALK_ONLY', 'NONE'];
  const map = createBattlefieldMap(1, 8, [true, false].flatMap(meleeBlockable =>
    passableMasks.map(passableMask => coreGround({ meleeBlockable, passableMask }))));
  const blocker = projectionUnit(10, [0, 0], {
    vitality: { maxHp: 100, defense: 0, resistance: 0 }, allegiance: { side: 'ALLY' }, blocker: { capacity: 1, geometry: { radius: 1 } },
  });
  const enemy = projectionUnit(11, [0.1, 0], {
    vitality: { maxHp: 100, defense: 0, resistance: 0 }, allegiance: { side: 'ENEMY' }, blockable: { volume: 1 },
    layer: { type: 'GROUND' },
  });
  const initial = registerUnit(registerUnit(createBattleState(createField({ map })), blocker), enemy);
  const acquired = blocking.search(initial, units.ref(blocker));
  const entry = acquired.battlefield.units.get(10).blocker.blocked[0];
  assert.deepEqual(blockedIds(acquired), [11]);
  for (let column = 0; column < passableMasks.length; column++) {
    const retained = updateUnit(acquired, { ...acquired.battlefield.units.get(10), position: [column, 0] });
    assert.equal(retained.battlefield.units.get(10).blocker.blocked[0], entry, passableMasks[column]);
  }

  for (const position of [[4, 0], [5, 0], [6, 0], [7, 0], [-1, 0]]) {
    const changed = updateUnit(acquired, { ...acquired.battlefield.units.get(10), position });
    assert.deepEqual(blockedIds(changed), []);
    assert.deepEqual(blockedIds(acquired), [11]);
  }
  const hidden = updateUnit(acquired, {
    ...acquired.battlefield.units.get(10), position: [1e30, 0], spatialPresence: { present: false },
  });
  assert.deepEqual(blockedIds(hidden), []);
});

test('selective and full field projection derive support cleanup independently of blocking', () => {
  const h = battlefieldProjectionHarness();
  const rider = projectionUnit(10, [1, 0], {}, {
    spatialPresence: { present: true }, occupancy: { registration: projectionRegistration(1) },
  });
  const platform = projectionUnit(12, [1, 0], {
    tileBinding: createTileBindingDefinition({ buildableType: 'ALL', heightType: 'HIGHLAND' }),
  }, { spatialPresence: { present: true }, occupancy: { registration: projectionRegistration(1, 'SUPPORT') } });
  const relation = { supportedUnitId: 10, supportUnitId: 12 };
  h.commit(state => ({ ...state, units: new Map([[10, rider], [12, platform]]) }));
  const cleared = h.commit(state => ({ ...state, units: new Map([...state.units, [12, {
    ...state.units.get(12), occupancy: { registration: null },
  }]]) }));
  assert.deepEqual(cleared.lostSupports, [relation]);
  h.commit(state => ({ ...state, units: new Map([...state.units, [12, platform]]) }));
  const removed = h.commit(state => ({ ...state, units: new Map([...state.units].filter(([id]) => id !== 12)) }));
  assert.deepEqual(removed.lostSupports, [relation]);
  assert.deepEqual(supports(h.state), []);
  assert.equal('blockingRelations' in h.state, false);
});

test('complete battle updates preserve relation history and release on current eligibility changes', () => {
  const blocker = projectionUnit(10, [1, 0], {
    vitality: { maxHp: 100, defense: 0, resistance: 0 }, allegiance: { side: 'ALLY' }, blocker: { capacity: 2, geometry: { radius: 1 } },
  });
  const enemy = projectionUnit(11, [1.1, 0], {
    vitality: { maxHp: 100, defense: 0, resistance: 0 }, allegiance: { side: 'ENEMY' }, blockable: { volume: 1 }, layer: { type: 'GROUND' },
  });
  const acquired = blocking.search(blockingFixture([blocker, enemy]), units.ref(blocker));
  const first = acquired.battlefield.units.get(10).blocker.blocked[0];
  const moved = updateUnit(acquired, { ...acquired.battlefield.units.get(11), position: [4, 1] });
  assert.equal(moved.battlefield.units.get(10).blocker.blocked[0], first);
  const released = blocking.release(acquired, units.ref(enemy));
  assert.deepEqual(blockedIds(released), []);
  const reacquired = blocking.search(released, units.ref(blocker));
  assert.deepEqual(blockedIds(reacquired), [11]);
  assert.notEqual(reacquired.battlefield.units.get(10).blocker.blocked[0], first);

  const mutations = [
    unit => ({ ...unit, vitality: { ...unit.vitality, hp: 0 } }),
    unit => ({ ...unit, allegiance: { side: 'ALLY' } }),
    unit => ({ ...unit, layer: { type: 'AIR' } }),
    unit => ({ ...unit, blockable: blockable.setVolumeContribution(unit.blockable, { id: 'larger', value: 2 }) }),
    unit => ({ ...unit, blockable: blockable.setRule(unit.blockable, { id: 'unblockable', allows: () => false }) }),
  ];
  for (const mutate of mutations) {
    const changed = updateUnit(acquired, mutate(acquired.battlefield.units.get(11)));
    assert.deepEqual(blockedIds(changed), []);
    assert.deepEqual(blockedIds(acquired), [11]);
  }
  for (const blockerState of [
    { ...acquired.battlefield.units.get(10).blocker, capacity: contribution.set([], { id: 'capacity-zero', value: [modifier.create({ finalScaler: 0 })] }) },
    setBlockerRule(acquired.battlefield.units.get(10).blocker, { id: 'cannot-block', allows: () => false }),
  ]) {
    const changed = updateUnit(acquired, { ...acquired.battlefield.units.get(10), blocker: blockerState });
    assert.deepEqual(blockedIds(changed), []);
  }
});

test('core selective and full projection reject invalid registrations atomically', () => {
  const h = battlefieldProjectionHarness();
  h.commit(state => ({ ...state, units: new Map([...state.units, ...[battlefieldUnit(10, [0, 0])].map(unit => [unit.id, unit])]) }));
  const reserved = projectionUnit(11, [1, 0], {}, { spatialPresence: { present: false },
    occupancy: { registration: projectionRegistration(1) } });
  h.commit(state => ({ ...state, units: new Map([...state.units, ...[reserved].map(unit => [unit.id, unit])]) }));
  const hiddenSpatial = h.state.spatial;
  h.commit(state => ({ ...state, units: new Map([...state.units, ...[{
    ...state.units.get(11), position: Object.freeze([1e30, 0]),
  }].map(unit => [unit.id, unit])]) }));
  assert.deepEqual(h.state.units.get(11).position, [1e30, 0]);
  assert.equal(h.state.spatial, hiddenSpatial);
  assert.equal(h.state.occupancy.get(1).occupant.id, 11);
  h.commit(state => ({ ...state, units: new Map([...state.units, ...[{
    ...state.units.get(11), position: Object.freeze([1, 0]), spatialPresence: { present: true },
  }].map(unit => [unit.id, unit])]) }));
  assert.deepEqual([...h.state.spatial.unitsByTile.get(1)], [11]);
  h.commit(state => ({ ...state, units: new Map([...state.units, ...[{
    ...state.units.get(11), position: Object.freeze([1e30, 0]), spatialPresence: { present: false },
  }].map(unit => [unit.id, unit])]) }));
  assert.equal(h.state.spatial.unitsByTile.has(1), false);
  h.reject(state => ({ ...state, units: new Map([...state.units, ...[projectionUnit(12, [2, 0], {}, {
    occupancy: { registration: projectionRegistration(1) },
  })].map(unit => [unit.id, unit])]) }), /occupancy slot is already occupied/);
  h.reject(state => ({ ...state, units: new Map([...state.units, ...[projectionUnit(12, [2, 0], {}, {
    spatialPresence: { present: false }, occupancy: { registration: projectionRegistration(99) },
  })].map(unit => [unit.id, unit])]) }), /occupancy registration is outside/);
  h.commit(state => ({ ...state, units: new Map([...state.units, ...[battlefieldUnit(12, [0, 0])].map(unit => [unit.id, unit])]) }));
  h.commit(state => ({ ...state, units: new Map([...new Map([...state.units].filter(([id]) => id !== 10)), ...[state.units.get(10)].map(unit => [unit.id, unit])]) }));
  assert.deepEqual([...h.state.units.keys()], [11, 12, 10]);
  assert.deepEqual([...h.state.spatial.unitsByTile.get(0)], [12, 10]);
});

const coreGround = (overrides = {}) => ({
  heightType: 'LOWLAND', meleeBlockable: true, buildableType: 'MELEE', passableMask: 'ALL', playerSideMask: 'ALL',
  terrain: 'NORMAL', mechanism: null, ...overrides,
});
const rawTile = (tileKey, overrides = {}) => ({
  tileKey, heightType: 'LOWLAND', buildableType: 'MELEE', passableMask: 'ALL',
  playerSideMask: 'ALL', blackboard: null, effects: [], ...overrides,
});

test('core battlefield snapshots isolate nested tiles, markers and edges from their input', () => {
  const tile = coreGround({ mechanism: { type: 'INFECTION', params: {
    damagePerTick: 100, attackBonusRatio: 0.2, attackSpeedBonus: 20, activeUntilTick: 60,
  } } });
  const markers = [{ type: 'START', position: [0, 0] }];
  const edges = [{ position: [0, 0], direction: 'RIGHT', blockMask: 'WALK_ONLY' }];
  const map = createBattlefieldMap(1, 2, [tile, coreGround()], markers, edges);
  tile.mechanism.params.damagePerTick = 999;
  markers[0].position[1] = 1;
  edges[0].blockMask = 'ALL';
  assert.equal(map.tiles[0].mechanism.params.damagePerTick, 100);
  assert.deepEqual(map.markers[0].position, [0, 0]);
  assert.equal(map.blockEdges[0].blockMask, 'WALK_ONLY');
  assert.ok(Object.isFrozen(map.tiles[0].mechanism.params) && Object.isFrozen(map.blockEdges));
  assert.equal(BattlefieldMap.get(map, [0, 2]), undefined);
  assert.throws(() => createBattlefieldMap(1, 2, [coreGround(), ,]), RangeError);
  assert.throws(() => createBattlefieldMap(Number.MAX_SAFE_INTEGER, 2, []), RangeError);
  assert.throws(() => createBattlefieldMap(1, 2, [coreGround()]), RangeError);
  assert.throws(() => createBattlefieldMap(1, 1, [coreGround()], [{ type: 'START', position: [0, 1] }]), /outside the map/);
  assert.throws(() => createBattlefieldMap(1, 1, [coreGround()], [,]), /missing marker/);
  assert.throws(() => createBattlefieldMap(1, 1, [coreGround()], [], [,]), /missing block edge/);
  assert.throws(() => createBattlefieldMap(1, 1, [coreGround()], [], [
    { position: [0, 2], direction: 'RIGHT', blockMask: 'ALL' },
  ]), /no endpoint inside/);
  assert.throws(() => createTile(coreGround({ advancedBuildableMask: 0x1_0000_0000 })), RangeError);
});

test('core static navigation projects mode-specific passability, costs and both edge departures', () => {
  const map = createBattlefieldMap(1, 4, [
    coreGround({ passableMask: 'WALK_ONLY' }), coreGround({ terrain: 'HOLE' }),
    coreGround(), coreGround({ passableMask: 'FLY_ONLY' }),
  ], [], [
    { position: [0, 1], direction: 'RIGHT', blockMask: 'WALK_ONLY' },
    { position: [0, -1], direction: 'RIGHT', blockMask: 'ALL' },
  ]);
  const walk = projectStaticNavigationMap(map, 'WALK', 2);
  const fly = projectStaticNavigationMap(map, 'FLY', 2);
  assert.deepEqual(walk.cells.map(cell => cell.cost), [1, 1_000_000, 1, 1]);
  assert.deepEqual(fly.cells.map(cell => cell.cost), [1, 1, 1, 1]);
  assert.deepEqual(walk.cells.map(cell => cell.passable), [true, true, true, false]);
  assert.deepEqual(fly.cells.map(cell => cell.passable), [false, true, true, true]);
  assert.equal(walk.get([0, 1]).departures.RIGHT, false);
  assert.equal(walk.get([0, 2]).departures.LEFT, false);
  assert.equal(fly.get([0, 1]).departures.RIGHT, true);
  assert.deepEqual(distances(build(walk, fieldQuery([0, 2]))), [-1, -1, 0, -1]);
  assert.deepEqual(distances(build(walk, fieldQuery([0, 1]))), [1, 0, -1, -1]);
  assert.deepEqual(distances(build(fly, fieldQuery([0, 3]))), [-1, 2, 1, 0]);
  assert.equal(walk.cells[0].departures.LEFT, false);
  assert.equal(walk.get([0, 0]).departures.UP, true);
  assert.ok(Object.isFrozen(walk) && Object.isFrozen(walk.cells));
  assert.ok(walk.cells.every(cell => Object.isFrozen(cell) && Object.isFrozen(cell.departures)));

});

test('raw battlefield loading flips matrix rows, extracts markers and preserves static side eligibility', () => {
  const raw = {
    map: [[0, 1], [2, 0]], tiles: [rawTile('tile_road'), rawTile('tile_start'), rawTile('tile_end', { playerSideMask: 'SIDE_B' })],
    blockEdges: [{ pos: { row: 1, col: 0 }, direction: 'RIGHT', blockMask: 'WALK_ONLY' }],
    effects: [], tags: [], layerRects: [],
  };
  const map = parseBattlefieldMap(raw);
  assert.deepEqual(map.markers, [{ type: 'END', position: [0, 0] }, { type: 'START', position: [1, 1] }]);
  assert.equal(map.tiles[0].playerSideMask, 'SIDE_B');
  assert.equal(projectStaticNavigationMap(map, 'WALK', 0).cells[2].departures.RIGHT, false);
  raw.tiles[2].playerSideMask = 'ALL';
  assert.equal(map.tiles[0].playerSideMask, 'SIDE_B');
  assert.throws(() => parseBattlefieldMap({ ...raw, map: [[0], [0, 1]] }), /rectangular/);
  assert.throws(() => parseBattlefieldMap({ ...raw, map: [[-1]] }), /definition index/);
  assert.throws(() => parseBattlefieldMap({ ...raw, effects: [{}] }), /not supported/);
  assert.throws(() => parseBattlefieldMap({ ...raw, tiles: [rawTile('tile_unknown')], map: [[0]] }), /unsupported tile key/);
});

test('raw tile mechanisms require controller inputs and explicit consumption of other blackboard rules', () => {
  const oneTile = (tile) => ({ map: [[0]], tiles: [tile], blockEdges: [] });
  const mire = { stackIntervalTicks: 1, attackSpeedPerStack: -5, moveSpeedRatioPerStack: -0.1, maxStacks: 5 };
  assert.throws(() => parseBattlefieldMap(oneTile(rawTile('tile_mire'))), /controller parameters/);
  assert.deepEqual(parseBattlefieldMap(oneTile(rawTile('tile_mire')), { mire }).tiles[0].mechanism.params, mire);
  const hand = oneTile(rawTile('tile_achand', { blackboard: [{ key: 'isValidHand', value: 1, valueStr: null }] }));
  assert.throws(() => parseBattlefieldMap(hand), /unconsumed blackboard/);
  const consumed = [];
  parseBattlefieldMap(hand, { consumeTileBlackboard: (context, entry) => {
    consumed.push([context.position, entry.key]);
    return entry.key === 'isValidHand';
  } });
  assert.deepEqual(consumed, [[[0, 0], 'isValidHand']]);
});

test('core safe-distance overflow candidates may be replaced by a cheaper path', () => {
  const half = Math.floor(Number.MAX_SAFE_INTEGER / 2);
  const map = fieldMap(2, 2, [fieldCell(), fieldCell(), fieldCell({ cost: half + 1 }), fieldCell({ cost: half + 2 })]);
  assert.deepEqual(distances(build(map, fieldQuery([0, 0]))), [0, 1, half + 1, half + 3]);
});


const coreMove = column => ({ type: 'MOVE', position: [0, column], offset: [0, 0] });

function routedEnemyHarness({ speedPerTick = 0.1, checkpoints = [], routeOverrides = {}, position = [0, 0] } = {}) {
  const configuration = {
    pathMotionMode: 'WALK', startPosition: [0, 0], endPosition: [0, 4], offset: [0, 0],
    requireAllCheckpoints: true, alwaysCheckCurrentPoint: true, checkpoints, ...routeOverrides,
  };
  const enemy = initialize({ id: 1, position, definition: {
    id: 'route-walker', vitality: { maxHp: 100, defense: 0, resistance: 0 }, spatialPresence: {},
    locomotion: { halfBodyWidth: 0, minSpeed: 0, speed: speedPerTick,
      steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } }, route: configuration,
  } });
  let battle = registerUnit(fixtureBattle(), enemy);
  const ref = units.ref(enemy);
  let maps = {
    WALK: fieldMap(1, 5, Array.from({ length: 5 }, () => fieldCell())),
    FLY: fieldMap(1, 5, Array.from({ length: 5 }, () => fieldCell())),
  };
  function setNavigation(navigation) {
    battle = { ...battle, battlefield: { ...battle.battlefield, navigation } };
  }
  setNavigation(createNavigation(maps));
  return {
    get enemy() { return units.get(battle, ref); },
    get battle() { return battle; },
    get maps() { return maps; },
    get navigation() { return battle.battlefield.navigation; },
    setMaps(next) { maps = next; setNavigation(createNavigation(maps)); },
    setNavigation,
    displace(position) { battle = updateUnit(battle, { ...units.get(battle, ref), position }); },
    step(multiplier = 1) {
      battle = route.advance(battle, ref);
      const current = units.get(battle, ref);
      if (!route.isCompleted(current.route)) {
        const target = route.movementTarget(battle, ref);
        if (target !== null) battle = locomotion.advance(battle, ref, target, {
          mode: route.pathMotionMode(current.route), speedMultiplier: multiplier,
        });
      }
      const result = units.get(battle, ref);
      battle = { ...battle, tick: battle.tick + 1 };
      return result;
    },
  };
}

test('Route guidance cannot move through an unreachable wall with a large movement budget', () => {
  const h = routedEnemyHarness({ speedPerTick: 10, routeOverrides: { endPosition: [0, 2] } });
  const map = fieldMap(1, 3, [fieldCell(), fieldCell({ passable: false }), fieldCell()]);
  h.setMaps({ WALK: map, FLY: map });
  for (let tick = 0; tick < 3; tick++) h.step();
  assert.deepEqual(h.enemy.position, [0, 0]);
  assert.equal(h.enemy.route.main.phase.type, 'END');
});

test('Route guidance follows visible segments around walls and high-cost intermediate tiles', () => {
  for (const obstacle of [{ passable: false }, { cost: 1000 }]) {
    const cells = Array.from({ length: 6 }, () => fieldCell());
    cells[1] = fieldCell(obstacle);
    const map = fieldMap(2, 3, cells);
    const h = routedEnemyHarness({ speedPerTick: 0.2, routeOverrides: { endPosition: [0, 2] } });
    h.setMaps({ WALK: map, FLY: fieldMap(2, 3, cells.map(cell => ({ ...cell, cost: 1 }))) });
    const positions = [h.enemy.position];
    for (let tick = 0; tick < 100 && !route.isCompleted(h.enemy.route); tick++) {
      h.step(); positions.push(h.enemy.position);
    }
    assert.equal(route.isCompleted(h.enemy.route), true);
    assert.ok(positions.some(position => position[1] >= 0.5));
    for (const position of positions) {
      const column = Math.floor(position[0] + 0.5), row = Math.floor(position[1] + 0.5);
      assert.equal(map.cells[row * map.columns + column].passable, true);
    }
  }
});

test('Route uses the selected motion map and its live overlays without changing the definition', () => {
  for (const mode of ['WALK', 'FLY']) {
    const h = routedEnemyHarness({ checkpoints: [coreMove(4)], routeOverrides: { pathMotionMode: mode } });
    const definition = h.enemy.route.main.definition;
    const original = h.navigation;
    const blocked = setOverlay(original, mode, createOverlay({
      id: 1, cells: [[0, 1]], denyPassage: true, denyDepartures: [],
    }));
    h.setNavigation(blocked);
    h.step();
    assert.deepEqual(h.enemy.position, [0, 0]);
    assert.equal(h.enemy.route.main.definition, definition);
    h.setNavigation(removeOverlay(blocked, mode, { id: 1 }));
    h.step();
    assert.ok(h.enemy.position[0] > 0);
    assert.equal(h.enemy.route.main.definition, definition);
  }
});

test('Route preserves directed departures when choosing a tracking point', () => {
  for (const [from, to, direction] of [
    [[0, 0], [0, 1], 'RIGHT'], [[0, 1], [0, 0], 'LEFT'],
    [[0, 0], [1, 0], 'UP'], [[1, 0], [0, 0], 'DOWN'],
  ]) {
    const rows = Math.max(from[0], to[0]) + 1, columns = Math.max(from[1], to[1]) + 1;
    const cells = Array.from({ length: rows * columns }, () => fieldCell());
    const index = from[0] * columns + from[1];
    cells[index] = fieldCell({ departures: { ...cells[index].departures, [direction]: false } });
    const map = fieldMap(rows, columns, cells);
    const h = routedEnemyHarness({ speedPerTick: 10, position: [from[1], from[0]],
      routeOverrides: { startPosition: from, endPosition: to } });
    h.setMaps({ WALK: map, FLY: map });
    h.step();
    assert.deepEqual(h.enemy.position, [from[1], from[0]]);
    assert.equal(route.isCompleted(h.enemy.route), false);
    const reverse = routedEnemyHarness({ speedPerTick: 10, position: [to[1], to[0]],
      routeOverrides: { startPosition: to, endPosition: from } });
    reverse.setMaps({ WALK: map, FLY: map });
    reverse.step(); reverse.step();
    assert.equal(route.isCompleted(reverse.enemy.route), true);
  }
});

test('Route and Locomotion preserve frozen inputs and share unchanged capability branches', () => {
  const h = routedEnemyHarness({ checkpoints: [coreMove(4)] });
  h.step(0);
  const previous = h.enemy;
  Object.freeze(previous.position);
  Object.freeze(previous.locomotion.velocity);
  Object.freeze(previous.locomotion);
  Object.freeze(previous.route.main.phase);
  Object.freeze(previous.route.main);
  Object.freeze(previous.route);
  Object.freeze(previous);
  const before = JSON.stringify(previous);
  const next = h.step();
  assert.equal(JSON.stringify(previous), before);
  assert.notEqual(next.position, previous.position);
  assert.equal(next.definition, previous.definition);
  assert.equal(next.route, previous.route);
  assert.equal(next.vitality, previous.vitality);
  assert.equal(next.effects, previous.effects);
});

test('Route replays the original teleport and patrol fixtures deterministically', () => {
  const raw = JSON.parse(readFileSync(new URL('../fixtures/arknights/level_act1autochess_h07_02.json', import.meta.url), 'utf8'));
  const map = parseBattlefieldMap(raw.mapData);
  const nav = createNavigation({ WALK: projectStaticNavigationMap(map, 'WALK'), FLY: projectStaticNavigationMap(map, 'FLY') });
  const definition = { spatialPresence: {}, id: 'fixture-route-enemy', vitality: { maxHp: 100, defense: 0, resistance: 0 },
    locomotion: { halfBodyWidth: 0, minSpeed: 0, speed: 0.1, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } } };
  function run(index, ticks) {
    const initialized = initializeRoutedUnit(fixtureBattle(0, { rngState: 31 }), {
      id: 1, definition, route: parseRouteDefinition(raw.routes[index]),
      timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true,
    });
    let battle = registerUnit({ ...initialized.state, battlefield: { ...initialized.state.battlefield, navigation: nav } }, initialized.value);
    const ref = units.ref(initialized.value);
    const trace = [];
    for (let tick = 0; tick < ticks && !route.isCompleted(units.get(battle, ref).route); tick++) {
      battle = route.advance({ ...battle, tick, events: [] }, ref);
      const target = route.movementTarget(battle, ref);
      if (target !== null) battle = locomotion.advance(battle, ref, target, {
        mode: route.pathMotionMode(units.get(battle, ref).route), speedMultiplier: 1,
      });
      trace.push({ unit: copy(units.get(battle, ref)), events: battle.events });
    }
    return { unit: units.get(battle, ref), trace };
  }
  const teleport = run(2, 1800);
  assert.equal(route.isCompleted(teleport.unit.route), true);
  assert.deepEqual(teleport.trace.flatMap(step => step.events.filter(event => event.type === 'ROUTE').map(event => event.signal.type)), ['DISAPPEAR', 'APPEAR_AT_POS']);
  assert.ok(teleport.trace.filter(step => !step.unit.spatialPresence.present).length >= 90);
  assert.deepEqual(run(2, 1800), teleport);
  const patrol = run(6, 500);
  assert.equal(route.isCompleted(patrol.unit.route), false);
  assert.ok(new Set(patrol.trace.map(step => step.unit.route.main.phase.index)).size >= 3);
});
