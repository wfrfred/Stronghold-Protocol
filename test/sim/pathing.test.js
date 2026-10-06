import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBattlefieldMap, BattlefieldMap } from '../../dist/core/tactical/battlefield/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/tile.js';
import { projectStaticNavigationMap } from '../../dist/core/tactical/battlefield/navigation-projection.js';
import { createBattlefieldRuntime } from '../../dist/core/tactical/battlefield/runtime.js';
import { createMechanismDefinition, createMechanismRuntime } from '../../dist/core/tactical/battlefield/mechanism.js';
import {
  createNavigationEffectDefinition, createNavigationSpatialEffect, createSpatialEffectRegion,
} from '../../dist/core/tactical/battlefield/navigation-effect.js';
import { createNavigationMap, NavigationMap } from '../../dist/core/tactical/navigation/map.js';
import { createNavigationRequest } from '../../dist/core/tactical/navigation/request.js';
import { deriveNavigationFieldQuery } from '../../dist/core/tactical/navigation/field.js';
import { createNavigationPath } from '../../dist/core/tactical/navigation/path.js';
import {
  bindNavigationPath, createNavigationState, predictNavigation,
  canCompleteNavigationSegment,
  setNavigationMotionMode, startNavigationRequest, steerNavigation,
} from '../../dist/core/tactical/navigation/state.js';
import { createRouteDefinition } from '../../dist/core/tactical/route/definition.js';
import {
  advanceRoute, createRouteExecution, enterRoute, nextCheckpointIndex, tickRouteWait,
} from '../../dist/core/tactical/route/execution.js';
import { createRouteTiming, createRouteState } from '../../dist/core/tactical/route/state.js';
import { initializeRouteSpawn } from '../../dist/core/tactical/route/spawn.js';
import { predictRouteTarget } from '../../dist/core/tactical/route/plan.js';
import { initializeRouteControl } from '../../dist/core/tactical/unit/capability/locomotion/route-control.js';
import { parseBattlefieldMap } from '../../dist/data/arknights/map.js';
import { parseRouteDefinition } from '../../dist/data/arknights/route.js';
import { createRng } from '../../dist/core/common/rng.js';
import { World } from '../../dist/core/tactical/geometry/coordinate.js';
import { createEnemyDefinition, initializeRoutedEnemy, stepRoutedEnemy } from '../../dist/core/tactical/unit/enemy.js';
import { copyUnitSnapshot } from '../../dist/core/tactical/unit/snapshot.js';
import { createSteeringParameters, createSteeringState, integrateSteering } from '../../dist/core/tactical/unit/capability/locomotion/steering.js';
import { Grid, OBSTACLE_COST, bresenhamTiles } from '../../server/sim/grid.js';
import { flowFieldForGrid, navigationMapFromGrid, waypointsForGrid } from '../../dist/legacy/navigation.js';
import { buildRawNavigationField, buildNavigationField } from '../../dist/core/tactical/navigation/pathfinding.js';
import { createNavigationFieldCache } from '../../dist/core/tactical/navigation/cache.js';
import { smoothNavigationField } from '../../dist/core/tactical/navigation/smoothing.js';
import {
  initializeNavigationCursor, selectNavigationPredictionTarget, selectNavigationSteeringTarget,
  canTraverseNavigationSegment,
} from '../../dist/core/tactical/navigation/query.js';
import { getDefaultSource, hasGeneratedData } from '../../server/sim/simdata.js';
import { makeBattle, flatStage, enemyRec } from '../helpers/battleHarness.js';
import { remainingDistance } from '../../server/sim/ai.js';

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

test('core flow field through legacy input: strict improvement and UP/RIGHT/DOWN/LEFT tie-break', () => {
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
  // equal costs: a tile keeps the first parent that reached it — (10,4) is reached from (10,3) (RIGHT of it) before
  // (9,4) (UP of it) is expanded, because (10,3) entered the queue first (UP from (9,3))
  assert.equal(f.parent[K(10, 4)], K(10, 3));
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
  // allowDiagonal=false: line of sight only along a row / column
  const fx = flowFieldForGrid(g, 9, 2, { allowDiagonal: false });
  let k = K(12, 10);
  while (k !== fx.dest) {
    const n = fx.next[k];
    assert.ok(((n / 21) | 0) === ((k / 21) | 0) || n % 21 === k % 21, 'axis-aligned hop');
    k = n;
  }
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
  assert.notEqual(flowFieldForGrid(g, 9, 2, { allowDiagonal: false }), a);
  assert.notEqual(navigationMapFromGrid(g, { pathMotionMode: 'FLY' }), a.field.map);
  assert.notEqual(navigationMapFromGrid(new Grid(flatStage(), NORMAL)), a.field.map);
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
  passable: true, moveCost: 1, departures: { UP: true, RIGHT: true, DOWN: true, LEFT: true }, ...overrides,
});
const fieldMap = (rows, columns, cells, pathMotionMode = 'WALK') => createNavigationMap({
  rows, columns, cells, pathMotionMode, revision: 0,
});
const fieldQuery = (targetTile, allowDiagonalMove = true) => ({ targetTile, allowDiagonalMove });
const distances = (field) => field.nodes.map(node => node.type === 'UNREACHABLE' ? -1 : node.distance);

test('core raw distances charge the departing tile and exclude target cost', () => {
  const map = fieldMap(1, 3, [fieldCell({ moveCost: 7 }), fieldCell({ moveCost: 3 }), fieldCell({ moveCost: 1000 })]);
  const query = fieldQuery([0, 2]);
  const input = JSON.stringify({ map, query });
  const raw = buildRawNavigationField(map, query);
  assert.deepEqual(distances(raw), [10, 3, 0]);
  assert.deepEqual(raw.nodes[0].rawNext, [0, 1]);
  assert.deepEqual(raw.nodes[0].next, [0, 1]);
  assert.deepEqual(raw, buildRawNavigationField(map, fieldQuery([0, 2])));
  assert.equal(raw.map, map);
  assert.equal(JSON.stringify({ map, query }), input);
  assert.ok(Object.isFrozen(raw));
  assert.ok(Object.isFrozen(raw.query));
  assert.ok(Object.isFrozen(raw.query.targetTile));
  assert.ok(raw.nodes.every(Object.isFrozen));
  assert.ok(Object.isFrozen(raw.nodes[0].rawNext));
  assert.ok(Object.isFrozen(raw.nodes[0].next));
  assert.ok(Object.isFrozen(raw.nodes));
  const tie = buildRawNavigationField(fieldMap(3, 3, Array.from({ length: 9 }, () => fieldCell())), fieldQuery([0, 0]));
  assert.deepEqual(tie.nodes[4].rawNext, [1, 0]);
});

test('core raw search respects directed departures, blocked targets and disconnected regions', () => {
  const departures = { UP: true, RIGHT: true, DOWN: true, LEFT: false };
  const map = fieldMap(1, 3, [fieldCell(), fieldCell({ departures }), fieldCell()]);
  assert.deepEqual(distances(buildRawNavigationField(map, fieldQuery([0, 0]))), [0, -1, -1]);
  assert.deepEqual(distances(buildRawNavigationField(map, fieldQuery([0, 2]))), [2, 1, 0]);
  const goalWithNoDepartures = fieldMap(1, 3, [fieldCell(), fieldCell(), fieldCell({
    departures: { UP: false, RIGHT: false, DOWN: false, LEFT: false },
  })]);
  assert.deepEqual(distances(buildRawNavigationField(goalWithNoDepartures, fieldQuery([0, 2]))), [2, 1, 0]);
  const blocked = fieldMap(1, 3, [fieldCell(), fieldCell({ passable: false }), fieldCell()]);
  assert.deepEqual(distances(buildRawNavigationField(blocked, fieldQuery([0, 1]))), [-1, -1, -1]);
  assert.deepEqual(distances(buildRawNavigationField(blocked, fieldQuery([0, 2]))), [-1, -1, 0]);
  assert.throws(() => buildRawNavigationField(map, fieldQuery([0, 3])), RangeError);
  assert.throws(() => buildRawNavigationField(map, fieldQuery([-1, 0])), RangeError);
});

test('core raw search consumes projected WALK_ONLY, hole costs and FLY masks', () => {
  const map = createBattlefieldMap(1, 5, [
    coreGround({ passableMask: 'WALK_ONLY' }), coreGround({ terrain: 'HOLE' }),
    coreGround({ passableMask: 'NONE' }), coreGround({ passableMask: 'FLY_ONLY' }), coreGround(),
  ]);
  const walk = projectStaticNavigationMap(map, 'WALK', 0);
  const fly = projectStaticNavigationMap(map, 'FLY', 0);
  assert.deepEqual(distances(buildRawNavigationField(walk, fieldQuery([0, 0]))), [0, 1_000_000, -1, -1, -1]);
  assert.deepEqual(distances(buildRawNavigationField(walk, fieldQuery([0, 1]))), [1, 0, -1, -1, -1]);
  assert.deepEqual(distances(buildRawNavigationField(fly, fieldQuery([0, 4]))), [-1, -1, -1, 1, 0]);
  assert.deepEqual(distances(buildRawNavigationField(fly, fieldQuery([0, 0]))), [-1, -1, -1, -1, -1]);
});

test('core field rejects signed int32 candidate overflow as a computation error', () => {
  const map = fieldMap(1, 3, [fieldCell(), fieldCell({ moveCost: 0x7fffffff }), fieldCell()]);
  assert.throws(() => buildRawNavigationField(map, fieldQuery([0, 0])), RangeError);
  assert.throws(() => buildNavigationField(map, fieldQuery([0, 0])), RangeError);
  assert.deepEqual(distances(buildRawNavigationField(fieldMap(1, 1, [fieldCell({ moveCost: 0x7fffffff })]), fieldQuery([0, 0]))), [0]);
});

test('core diagonal smoothing reads the final tile departure and keeps raw successors', () => {
  const map = fieldMap(1, 3, [fieldCell(), fieldCell(), fieldCell({
    departures: { UP: true, RIGHT: false, DOWN: true, LEFT: true },
  })]);
  const diagonal = buildNavigationField(map, fieldQuery([0, 2]));
  const axis = buildNavigationField(map, fieldQuery([0, 2], false));
  assert.deepEqual(diagonal.nodes[0].rawNext, [0, 1]);
  assert.deepEqual(diagonal.nodes[0].next, [0, 1]);
  assert.deepEqual(axis.nodes[0].next, [0, 2]);
  assert.deepEqual(distances(diagonal), distances(axis));
});

test('core smoothing respects one-way departures and keeps reverse cardinal rays open', () => {
  const cases = [
    { rows: 2, columns: 3, from: [0, 2], to: [0, 0], denied: 'LEFT', turn: [1, 2] },
    { rows: 2, columns: 3, from: [0, 0], to: [0, 2], denied: 'RIGHT', turn: [1, 0] },
    { rows: 3, columns: 2, from: [2, 0], to: [0, 0], denied: 'DOWN', turn: [2, 1] },
    { rows: 3, columns: 2, from: [0, 0], to: [2, 0], denied: 'UP', turn: [0, 1] },
  ];
  for (const { rows, columns, from, to, denied, turn } of cases) {
    const cells = Array.from({ length: rows * columns }, () => fieldCell());
    cells[from[0] * columns + from[1]].departures[denied] = false;
    const map = fieldMap(rows, columns, cells);
    for (const allowDiagonalMove of [true, false]) {
      const message = `${denied}, diagonal=${allowDiagonalMove}`;
      const forward = buildNavigationField(map, fieldQuery(to, allowDiagonalMove));
      const node = forward.nodes[from[0] * columns + from[1]];
      assert.equal(node.distance, 4, message);
      assert.deepEqual(node.rawNext, turn, message);
      assert.deepEqual(node.next, turn, message);
      const reverse = buildNavigationField(map, fieldQuery(from, allowDiagonalMove));
      const reverseNode = reverse.nodes[to[0] * columns + to[1]];
      assert.equal(reverseNode.distance, 2, message);
      assert.deepEqual(reverseNode.next, from, message);
    }
  }
});

test('core reversed diagonal smoothing checks both actual departure components and axes', () => {
  const cases = [
    { rows: 3, columns: 4, from: [2, 3], to: [0, 0], denied: 'LEFT', axis: 1 },
    { rows: 3, columns: 4, from: [2, 3], to: [0, 0], denied: 'DOWN', axis: 0 },
    { rows: 4, columns: 3, from: [3, 2], to: [0, 0], denied: 'DOWN', axis: 0 },
    { rows: 4, columns: 3, from: [3, 2], to: [0, 0], denied: 'LEFT', axis: 1 },
    { rows: 3, columns: 3, from: [0, 2], to: [2, 0], denied: 'LEFT', axis: 1 },
    { rows: 3, columns: 3, from: [0, 2], to: [2, 0], denied: 'UP', axis: 0 },
  ];
  for (const { rows, columns, from, to, denied, axis } of cases) {
    const cells = Array.from({ length: rows * columns }, () => fieldCell());
    cells[from[0] * columns + from[1]].departures[denied] = false;
    const map = fieldMap(rows, columns, cells);
    const message = `${rows}x${columns}, ${denied}`;
    const field = buildNavigationField(map, fieldQuery(to));
    const node = field.nodes[from[0] * columns + from[1]];
    assert.equal(node.distance, rows + columns - 2, message);
    assert.equal(node.next[axis], from[axis], message);
    assert.notDeepEqual(node.next, from, message);
    const reverse = buildNavigationField(map, fieldQuery(from));
    assert.deepEqual(reverse.nodes[to[0] * columns + to[1]].next, from, message);
  }
});

test('core reversed diagonal smoothing checks departures from both side cells', () => {
  const cases = [
    { from: [2, 2], to: [0, 0], blocked: [1, 2], denied: 'LEFT' },
    { from: [2, 2], to: [0, 0], blocked: [2, 1], denied: 'DOWN' },
    { from: [0, 2], to: [2, 0], blocked: [1, 2], denied: 'LEFT' },
    { from: [0, 2], to: [2, 0], blocked: [0, 1], denied: 'UP' },
  ];
  for (const { from, to, blocked, denied } of cases) {
    const cells = Array.from({ length: 9 }, () => fieldCell());
    cells[blocked[0] * 3 + blocked[1]].departures[denied] = false;
    const map = fieldMap(3, 3, cells);
    const message = `${from} -> ${to}, ${blocked}.${denied}`;
    const field = buildNavigationField(map, fieldQuery(to));
    const node = field.nodes[from[0] * 3 + from[1]];
    assert.equal(node.distance, 4, message);
    assert.notDeepEqual(node.next, to, message);
    const reverse = buildNavigationField(map, fieldQuery(from));
    assert.deepEqual(reverse.nodes[to[0] * 3 + to[1]].next, from, message);
  }
});

test('core diagonal smoothing checks narrow rectangles while axis smoothing retains high-cost hops', () => {
  const cells = Array.from({ length: 8 }, () => fieldCell());
  cells[4] = fieldCell({ passable: false });
  const map = fieldMap(2, 4, cells);
  const field = buildNavigationField(map, fieldQuery([1, 3]));
  assert.deepEqual(field.nodes[0].rawNext, [0, 1]);
  assert.deepEqual(field.nodes[0].next, [0, 3]);
  const costs = fieldMap(1, 3, [fieldCell(), fieldCell({ moveCost: 1000 }), fieldCell()]);
  const diagonal = buildNavigationField(costs, fieldQuery([0, 2]));
  const axis = buildNavigationField(costs, fieldQuery([0, 2], false));
  assert.deepEqual(diagonal.nodes[0].next, [0, 1]);
  assert.deepEqual(axis.nodes[0].next, [0, 2]);
  assert.deepEqual(distances(diagonal), [1001, 1000, 0]);
});

test('core smoothing performs one row-column pass rather than repeating until stable', () => {
  const cells = Array.from({ length: 6 }, () => fieldCell());
  cells[2] = fieldCell({ departures: { UP: true, RIGHT: false, DOWN: true, LEFT: true } });
  const map = fieldMap(2, 3, cells);
  const query = fieldQuery([1, 2]);
  const raw = buildRawNavigationField(map, query);
  const before = JSON.stringify(raw);
  const first = smoothNavigationField(raw);
  assert.deepEqual(first, buildNavigationField(map, query));
  assert.equal(JSON.stringify(raw), before);
  assert.equal(first.map, raw.map);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.nodes));
  assert.ok(first.nodes.every(Object.isFrozen));
  assert.ok(Object.isFrozen(first.nodes[0].rawNext) && Object.isFrozen(first.nodes[0].next));
  assert.deepEqual(first.nodes[0].rawNext, [0, 1]);
  assert.deepEqual(first.nodes[0].next, [0, 1]);
  assert.deepEqual(first.nodes[1].next, [1, 2]);
  assert.deepEqual(smoothNavigationField(first).nodes[0].next, [1, 2]);
  assert.deepEqual(first.nodes[0].next, [0, 1]);
});

test('core field cache shares geometry queries within a battle and isolates actual maps and battle owners', () => {
  const map = fieldMap(1, 4, Array.from({ length: 4 }, () => fieldCell()));
  const otherMap = fieldMap(1, 4, Array.from({ length: 4 }, () => fieldCell()));
  const cache = createNavigationFieldCache(), otherBattle = createNavigationFieldCache();
  const request = createNavigationRequest(coreRequest({ targetTile: [0, 3], goal: { position: [3, 0], reachDistance: 0.05 } }));
  const first = cache.get(map, request);
  const anotherUnit = createNavigationRequest({
    ...request, id: 2, goal: { position: [3.2, 0.1], reachDistance: 0.25 },
    options: { ...request.options, visitEveryTileCenter: true, visitEveryNodeStably: true },
  });
  assert.equal(cache.get(map, anotherUnit), first);
  assert.equal(first.map, map);
  const differentTarget = createNavigationRequest({ ...request, targetTile: [0, 2] });
  const differentDiagonal = createNavigationRequest({ ...request, options: { ...request.options, allowDiagonalMove: false } });
  assert.notEqual(cache.get(map, differentTarget), first);
  assert.notEqual(cache.get(map, differentDiagonal), first);
  const otherMapField = cache.get(otherMap, request);
  assert.notEqual(otherMapField, first);
  assert.notEqual(otherBattle.get(map, request), first);
  const fly = fieldMap(1, 4, Array.from({ length: 4 }, () => fieldCell()), 'FLY');
  assert.notEqual(cache.get(fly, request), first);
  const snapshot = JSON.stringify(first);
  cache.invalidate(map);
  assert.equal(cache.get(otherMap, request), otherMapField);
  const rebuilt = cache.get(map, request);
  assert.notEqual(rebuilt, first);
  assert.equal(JSON.stringify(first), snapshot);
  assert.equal(first.nodes[0].distance, 3);
  assert.throws(() => { first.nodes[0].distance = 9; }, TypeError);
  const otherBeforeClear = cache.get(otherMap, request);
  cache.clear();
  assert.notEqual(cache.get(map, request), rebuilt);
  assert.notEqual(cache.get(otherMap, request), otherBeforeClear);
  assert.equal(JSON.stringify(first), snapshot);
});

function navigationPathFor(map, overrides = {}) {
  const input = coreRequest({ targetTile: [0, 3], goal: { position: [3.2, 0], reachDistance: 0.05 }, ...overrides });
  input.options = { ...coreRequest().options, ...overrides.options };
  const request = createNavigationRequest(input);
  return createNavigationPath(request, buildNavigationField(map, deriveNavigationFieldQuery(request)));
}

const navigationVisits = (...positions) => Object.freeze({
  visitedCenters: Object.freeze(positions.map(position => Object.freeze([...position]))),
});
const navigationCursor = (nextNode) => Object.freeze({ type: 'FIELD', nextNode: Object.freeze([...nextNode]) });

test('core navigation predicts the continuous goal and steers through the field bend', () => {
  const cells = Array.from({ length: 8 }, () => fieldCell());
  cells[1] = fieldCell({ passable: false });
  const path = navigationPathFor(fieldMap(2, 4, cells));
  assert.deepEqual(path.field.nodes[0].next, [1, 0]);
  const initial = initializeNavigationCursor(path, [0, 0], [0, 0]);
  assert.deepEqual(initial, { type: 'READY', cursor: { type: 'FIELD', nextNode: [0, 0] } });
  const prediction = selectNavigationPredictionTarget(path, initial.cursor, navigationVisits(), [0, 0], [0, 0]);
  assert.deepEqual(prediction.decision, { type: 'TARGET', target: [3.2, 0] });
  const steering = selectNavigationSteeringTarget(path, prediction.cursor, prediction.visits, [0, 0], [0, 0]);
  assert.deepEqual(steering.decision, { type: 'MOVE', target: [0, 1] });
  const finalLeg = selectNavigationSteeringTarget(path, navigationCursor([0, 2]), navigationVisits(), [2, 0], [0, 0]);
  assert.deepEqual(finalLeg.decision, { type: 'MOVE', target: [3.2, 0] });
  const displaced = selectNavigationPredictionTarget(path, Object.freeze({ type: 'GOAL' }), navigationVisits(), [0, 0], [0, 0]);
  assert.deepEqual(displaced.cursor, { type: 'FIELD', nextNode: [1, 0] });
  assert.deepEqual(displaced.decision, { type: 'TARGET', target: [3.2, 0] });
});

test('core navigation prioritizes tile centers, then node centers, then stable centers', () => {
  const map = fieldMap(1, 4, Array.from({ length: 4 }, () => fieldCell()));
  const tile = navigationPathFor(map, { options: { visitEveryTileCenter: true, visitEveryNodeCenter: true, visitEveryNodeStably: true } });
  const tileSelection = selectNavigationPredictionTarget(tile, navigationCursor([0, 2]), navigationVisits(), [0.2, 0], [0, 0]);
  assert.deepEqual(tileSelection.decision, { type: 'TARGET', target: [0, 0] });
  const node = navigationPathFor(map, { options: { visitEveryNodeCenter: true, visitEveryNodeStably: true } });
  assert.deepEqual(selectNavigationPredictionTarget(node, navigationCursor([0, 0]), navigationVisits(), [0.2, 0], [0, 0]).decision, {
    type: 'TARGET', target: [0, 0],
  });
  const stable = navigationPathFor(map, { options: { visitEveryNodeStably: true } });
  assert.deepEqual(selectNavigationPredictionTarget(stable, navigationCursor([0, 0]), navigationVisits(), [0.2, 0], [0, 0]).decision, {
    type: 'TARGET', target: [3.2, 0],
  });
  const centerBeforeArrival = selectNavigationSteeringTarget(tile, navigationCursor([0, 3]), navigationVisits(), [3.2, 0], [0, 0]);
  assert.deepEqual(centerBeforeArrival.decision, { type: 'MOVE', target: [3, 0] });
});

test('core center visits use 0.05 distance while stable tracking uses 0.25 without visit memory', () => {
  const map = fieldMap(1, 4, Array.from({ length: 4 }, () => fieldCell()));
  for (const option of ['visitEveryTileCenter', 'visitEveryNodeCenter']) {
    const path = navigationPathFor(map, { options: { [option]: true } });
    const waiting = selectNavigationPredictionTarget(path, navigationCursor([0, 0]), navigationVisits(), [0.051, 0], [0, 0]);
    assert.deepEqual(waiting.decision, { type: 'TARGET', target: [0, 0] });
    assert.deepEqual(waiting.visits.visitedCenters, []);
    const reached = selectNavigationPredictionTarget(path, navigationCursor([0, 0]), navigationVisits(), [0.049, 0], [0, 0]);
    assert.deepEqual(reached.decision, { type: 'TARGET', target: [3.2, 0] });
    assert.deepEqual(reached.visits.visitedCenters, [[0, 0]]);
    const steering = selectNavigationSteeringTarget(path, navigationCursor([0, 0]), navigationVisits(), [0.049, 0], [0, 0]);
    assert.deepEqual(steering.decision, { type: 'MOVE', target: [3.2, 0] });
    const remembered = selectNavigationPredictionTarget(path, navigationCursor([0, 0]), navigationVisits([0, 0]), [0.2, 0], [0, 0]);
    assert.deepEqual(remembered.decision, { type: 'TARGET', target: [3.2, 0] });
    assert.deepEqual(remembered.visits.visitedCenters, [[0, 0]]);
  }
  const path = navigationPathFor(map, { options: { visitEveryNodeStably: true } });
  const waiting = selectNavigationPredictionTarget(path, navigationCursor([0, 0]), navigationVisits(), [0.251, 0], [0, 0]);
  const reached = selectNavigationPredictionTarget(path, navigationCursor([0, 0]), navigationVisits(), [0.249, 0], [0, 0]);
  assert.deepEqual(waiting.decision, { type: 'TARGET', target: [0, 0] });
  assert.deepEqual(reached.decision, { type: 'TARGET', target: [3.2, 0] });
  assert.deepEqual(reached.visits.visitedCenters, []);
});

test('core locator offsets affect quantization and every selected unit-space target', () => {
  const map = fieldMap(3, 4, Array.from({ length: 12 }, () => fieldCell()));
  const path = navigationPathFor(map, { options: { visitEveryTileCenter: true } });
  const offset = [-0.5, 0.75];
  const initial = initializeNavigationCursor(path, [1, 0.75], offset);
  assert.deepEqual(initial, { type: 'READY', cursor: { type: 'FIELD', nextNode: [2, 0] } });
  const center = selectNavigationPredictionTarget(path, initial.cursor, navigationVisits(), [1, 0.75], offset);
  assert.deepEqual(center.decision, { type: 'TARGET', target: [0.5, 1.25] });
  const ordinary = navigationPathFor(map);
  const goal = selectNavigationPredictionTarget(ordinary, initial.cursor, navigationVisits(), [1, 0.75], offset);
  assert.deepEqual(goal.decision, { type: 'TARGET', target: [3.7, -0.75] });
  const inside = initializeNavigationCursor(ordinary, [-1, 0], [1, 0]);
  assert.equal(inside.type, 'READY');
});

test('core prediction remains TARGET at the goal while steering distinguishes geometric arrival rules', () => {
  const map = fieldMap(1, 4, Array.from({ length: 4 }, () => fieldCell()));
  const path = navigationPathFor(map);
  const cursor = navigationCursor([0, 3]);
  const prediction = selectNavigationPredictionTarget(path, cursor, navigationVisits(), [3.2, 0], [0, 0]);
  assert.deepEqual(initializeNavigationCursor(path, [3, 0], [0, 0]), { type: 'READY', cursor: { type: 'GOAL' } });
  assert.deepEqual(prediction.decision, { type: 'TARGET', target: [3.2, 0] });
  assert.deepEqual(selectNavigationSteeringTarget(path, prediction.cursor, prediction.visits, [3.2, 0], [0, 0]).decision, { type: 'ARRIVED' });
  const geometric = navigationPathFor(map, { goal: { position: [2, 0], reachDistance: 2 }, targetTile: [0, 2] });
  const end = navigationPathFor(map, { goal: { position: [2, 0], reachDistance: 2 }, targetTile: [0, 2], arrivalRule: 'TARGET_TILE_AND_DISTANCE' });
  assert.equal(selectNavigationSteeringTarget(geometric, cursor, navigationVisits(), [0.49, 0], [0, 0]).decision.type, 'ARRIVED');
  assert.equal(selectNavigationSteeringTarget(end, cursor, navigationVisits(), [0.49, 0], [0, 0]).decision.type, 'MOVE');
  assert.equal(selectNavigationSteeringTarget(end, cursor, navigationVisits(), [1.5, 0], [0, 0]).decision.type, 'ARRIVED');
  const exact = navigationPathFor(map, { goal: { position: [3, 0], reachDistance: 0 } });
  assert.equal(selectNavigationSteeringTarget(exact, cursor, navigationVisits(), [3, 0], [0, 0]).decision.type, 'ARRIVED');
  assert.equal(selectNavigationSteeringTarget(exact, cursor, navigationVisits(), [3.049, 0], [0, 0]).decision.type, 'MOVE');
});

test('core steering consumes the cursor and visits returned by the preceding prediction query', () => {
  const path = navigationPathFor(fieldMap(1, 4, Array.from({ length: 4 }, () => fieldCell())), { options: { visitEveryNodeCenter: true } });
  const cursor = navigationCursor([0, 0]), visits = navigationVisits();
  const prediction = selectNavigationPredictionTarget(path, cursor, visits, [0.049, 0], [0, 0]);
  assert.deepEqual(prediction.cursor, { type: 'GOAL' });
  assert.deepEqual(prediction.visits.visitedCenters, [[0, 0]]);
  assert.deepEqual(prediction.decision, { type: 'TARGET', target: [3.2, 0] });
  const shared = selectNavigationSteeringTarget(path, prediction.cursor, prediction.visits, [0.049, 0], [0, 0]);
  const stale = selectNavigationSteeringTarget(path, cursor, visits, [0.049, 0], [0, 0]);
  assert.deepEqual(shared.decision, { type: 'MOVE', target: [3, 0] });
  assert.deepEqual(stale.decision, { type: 'MOVE', target: [3.2, 0] });
  assert.deepEqual(shared.visits.visitedCenters, [[0, 0]]);
  assert.deepEqual(visits.visitedCenters, []);
});

test('core navigation distinguishes unreachable target, unreachable position and outside-map recovery input', () => {
  const cursor = navigationCursor([0, 0]);
  const blockedTarget = navigationPathFor(fieldMap(1, 4, [fieldCell(), fieldCell(), fieldCell(), fieldCell({ passable: false })]));
  const disconnected = navigationPathFor(fieldMap(1, 4, [fieldCell(), fieldCell({ passable: false }), fieldCell(), fieldCell()]));
  assert.deepEqual(selectNavigationSteeringTarget(blockedTarget, cursor, navigationVisits(), [0, 0], [0, 0]).decision, {
    type: 'UNREACHABLE', reason: 'TARGET_UNREACHABLE',
  });
  assert.deepEqual(selectNavigationSteeringTarget(disconnected, cursor, navigationVisits(), [0, 0], [0, 0]).decision, {
    type: 'UNREACHABLE', reason: 'POSITION_UNREACHABLE',
  });
  assert.equal(selectNavigationPredictionTarget(disconnected, cursor, navigationVisits(), [0, 0], [0, 0]).decision.type, 'TARGET');
  assert.deepEqual(initializeNavigationCursor(disconnected, [-2, 0], [0, 0]), { type: 'OUTSIDE_MAP' });
  assert.deepEqual(selectNavigationPredictionTarget(disconnected, cursor, navigationVisits(), [-2, 0], [0, 0]).decision, { type: 'OUTSIDE_MAP' });
  assert.deepEqual(selectNavigationSteeringTarget(disconnected, cursor, navigationVisits(), [-2, 0], [0, 0]).decision, { type: 'OUTSIDE_MAP' });
});

test('core navigation selections preserve their inputs and never consume global randomness', () => {
  const path = navigationPathFor(fieldMap(1, 4, Array.from({ length: 4 }, () => fieldCell())), { options: { visitEveryNodeCenter: true } });
  const cursor = navigationCursor([0, 0]), visits = navigationVisits(), position = [0.049, 0], offset = [0, 0];
  const before = JSON.stringify({ path, cursor, visits, position, offset });
  const originalRandom = Math.random;
  let randomCalls = 0;
  Math.random = () => { randomCalls++; return 0.5; };
  try {
    const first = selectNavigationPredictionTarget(path, cursor, visits, position, offset);
    assert.deepEqual(selectNavigationPredictionTarget(path, cursor, visits, position, offset), first);
    selectNavigationSteeringTarget(path, first.cursor, first.visits, position, offset);
    const ordinary = navigationPathFor(path.field.map);
    const unchanged = selectNavigationPredictionTarget(ordinary, cursor, visits, position, offset);
    assert.equal(unchanged.cursor, cursor);
    assert.equal(unchanged.visits, visits);
    const outside = selectNavigationPredictionTarget(ordinary, cursor, visits, [-2, 0], offset);
    assert.equal(outside.cursor, cursor);
    assert.equal(outside.visits, visits);
    const bound = bindNavigationPath(startNavigationRequest(createNavigationState('WALK', offset), path.request), path, position);
    const prediction = predictNavigation(bound.state, position);
    const steering = steerNavigation(prediction.state, position);
    setNavigationMotionMode(steering.state, 'FLY');
    assert.ok(first.visits.visitedCenters.every(Object.isFrozen));
    assert.ok(Object.isFrozen(path) && Object.isFrozen(path.request));
    assert.equal(randomCalls, 0);
    assert.equal(JSON.stringify({ path, cursor, visits, position, offset }), before);
  } finally {
    Math.random = originalRandom;
  }
});

test('core navigation state passes prediction updates to steering without modifying the prior state', () => {
  const path = navigationPathFor(fieldMap(1, 4, Array.from({ length: 4 }, () => fieldCell())), { options: { visitEveryNodeCenter: true } });
  const idle = createNavigationState('WALK', [-0.5, 0.25]);
  const started = startNavigationRequest(idle, path.request);
  assert.equal(idle.execution.activity.type, 'IDLE');
  assert.equal(started.execution.activity.type, 'NEEDS_PATH');
  assert.equal(started.execution.activity.request, path.request);
  const position = [0.549, -0.25];
  const bound = bindNavigationPath(started, path, position);
  assert.equal(bound.initialization.type, 'READY');
  const before = JSON.stringify({ idle, started, state: bound.state, path, position });
  const prediction = predictNavigation(bound.state, position);
  assert.deepEqual(prediction.selection.decision, { type: 'TARGET', target: [3.7, -0.25] });
  assert.deepEqual(prediction.state.execution.visits.visitedCenters, [[0, 0]]);
  assert.deepEqual(prediction.state.execution.activity.cursor, { type: 'GOAL' });
  const steering = steerNavigation(prediction.state, position);
  assert.deepEqual(steering.selection.decision, { type: 'MOVE', target: [3.5, -0.25] });
  assert.deepEqual(steering.outcomes, []);
  assert.equal(steering.state.execution.activity.type, 'FOLLOWING');
  assert.equal(steering.state.execution.activity.path.request, path.request);
  const displaced = predictNavigation(steering.state, [2.7, -0.25]);
  assert.deepEqual(displaced.selection.decision, { type: 'TARGET', target: [3.5, -0.25] });
  assert.equal(displaced.state.execution.visits, steering.state.execution.visits);
  assert.equal(displaced.state.execution.activity.path.request, path.request);
  assert.equal(JSON.stringify({ idle, started, state: bound.state, path, position }), before);
  assert.notEqual(prediction.state, bound.state);
  assert.equal(Object.isFrozen(prediction.state.execution), false);
  assert.equal(Object.isFrozen(steering.state.execution), false);
});

test('core navigation rebinds displacement, map replacement and motion mode without replacing the resolved request', () => {
  const path = navigationPathFor(fieldMap(1, 4, Array.from({ length: 4 }, () => fieldCell())), {
    id: 77, options: { visitEveryTileCenter: true },
  });
  const started = startNavigationRequest(createNavigationState('WALK', [0, 0]), path.request);
  const original = bindNavigationPath(started, path, [0.049, 0]).state;
  const visited = predictNavigation(original, [0.049, 0]).state;
  const changedMap = createNavigationMap({
    rows: 1, columns: 4, pathMotionMode: 'WALK', revision: 1,
    cells: [fieldCell(), fieldCell({ moveCost: 1000 }), fieldCell(), fieldCell()],
  });
  const changedPath = createNavigationPath(path.request, buildNavigationField(changedMap, deriveNavigationFieldQuery(path.request)));
  const rebound = bindNavigationPath(visited, changedPath, [2.2, 0]);
  assert.equal(rebound.state.execution.activity.path, changedPath);
  assert.deepEqual(rebound.initialization, { type: 'READY', cursor: { type: 'FIELD', nextNode: [0, 2] } });
  assert.equal(rebound.state.execution.visits, visited.execution.visits);
  assert.equal(rebound.state.execution.locatorOffset, visited.execution.locatorOffset);
  assert.equal(rebound.state.execution.activity.path.request, path.request);
  assert.equal(rebound.state.execution.activity.path.request.goal, path.request.goal);
  assert.equal(rebound.state.execution.activity.path.request.id, 77);
  assert.deepEqual(predictNavigation(rebound.state, [2.2, 0]).selection.decision, { type: 'TARGET', target: [2, 0] });
  const fly = setNavigationMotionMode(rebound.state, 'FLY');
  assert.equal(rebound.state.pathMotionMode, 'WALK');
  assert.equal(fly.pathMotionMode, 'FLY');
  assert.equal(fly.execution.activity.type, 'NEEDS_PATH');
  assert.equal(fly.execution.activity.request, path.request);
  assert.equal(fly.execution.visits, visited.execution.visits);
  assert.throws(() => bindNavigationPath(fly, changedPath, [2.2, 0]));
  const flyPath = createNavigationPath(path.request, buildNavigationField(
    fieldMap(1, 4, Array.from({ length: 4 }, () => fieldCell()), 'FLY'), deriveNavigationFieldQuery(path.request),
  ));
  const flying = bindNavigationPath(fly, flyPath, [2.2, 0]).state;
  assert.equal(flying.execution.activity.type, 'FOLLOWING');
  assert.equal(flying.execution.activity.path.request, path.request);
  assert.equal(flying.execution.visits, visited.execution.visits);
  const continued = startNavigationRequest(flying, createNavigationRequest({ ...path.request, id: 78 }));
  assert.equal(continued.execution.activity.type, 'NEEDS_PATH');
  assert.equal(continued.execution.visits, flying.execution.visits);
  assert.throws(() => bindNavigationPath(continued, flyPath, [2.2, 0]));
});

test('core unreachable navigation can predict and recover while reporting only failure transitions', () => {
  const path = navigationPathFor(fieldMap(1, 4, [fieldCell(), fieldCell({ passable: false }), fieldCell(), fieldCell()]));
  const started = startNavigationRequest(createNavigationState('WALK', [0, 0]), path.request);
  const following = bindNavigationPath(started, path, [0, 0]).state;
  const failed = steerNavigation(following, [0, 0]);
  assert.deepEqual(failed.outcomes, [{ type: 'UNREACHABLE', requestId: path.request.id, reason: 'POSITION_UNREACHABLE' }]);
  assert.equal(failed.state.execution.activity.type, 'UNREACHABLE');
  assert.deepEqual(failed.state.execution.activity.position, [0, 0]);
  const retry = steerNavigation(failed.state, [0.1, 0]);
  assert.deepEqual(retry.outcomes, []);
  assert.deepEqual(retry.state.execution.activity.position, [0.1, 0]);
  assert.deepEqual(failed.state.execution.activity.position, [0, 0]);
  const prediction = predictNavigation(retry.state, [0.1, 0]);
  assert.deepEqual(prediction.selection.decision, { type: 'TARGET', target: [3.2, 0] });
  assert.equal(prediction.state.execution.activity.type, 'UNREACHABLE');
  const outside = steerNavigation(prediction.state, [-2, 0]);
  assert.deepEqual(outside.selection.decision, { type: 'OUTSIDE_MAP' });
  assert.deepEqual(outside.outcomes, []);
  assert.equal(outside.state.execution.activity.type, 'UNREACHABLE');
  const displaced = predictNavigation(outside.state, [2, 0]);
  assert.equal(displaced.state.execution.activity.type, 'UNREACHABLE');
  assert.deepEqual(displaced.state.execution.activity.position, [0.1, 0]);
  const resumed = steerNavigation(displaced.state, [2, 0]);
  assert.deepEqual(resumed.selection.decision, { type: 'MOVE', target: [3.2, 0] });
  assert.equal(resumed.state.execution.activity.type, 'FOLLOWING');
  assert.deepEqual(resumed.outcomes, []);
  const arrived = steerNavigation(resumed.state, [3.2, 0]);
  assert.deepEqual(arrived.selection.decision, { type: 'ARRIVED' });
  assert.deepEqual(arrived.outcomes, [{ type: 'ARRIVED', requestId: path.request.id }]);
  assert.equal(arrived.state.execution.activity.type, 'ARRIVED');
  assert.equal(arrived.state.execution.activity.request, path.request);
  assert.throws(() => predictNavigation(arrived.state, [3.2, 0]));
});

test('core initial outside-map binding retains the request and later explicit binding can start it', () => {
  const path = navigationPathFor(fieldMap(1, 4, Array.from({ length: 4 }, () => fieldCell())));
  const started = startNavigationRequest(createNavigationState('WALK', [0, 0]), path.request);
  const outside = bindNavigationPath(started, path, [-2, 0]);
  assert.deepEqual(outside.initialization, { type: 'OUTSIDE_MAP' });
  assert.equal(outside.state.execution.activity.type, 'NEEDS_PATH');
  assert.equal(outside.state.execution.activity.request, path.request);
  assert.throws(() => predictNavigation(outside.state, [-2, 0]));
  assert.throws(() => steerNavigation(outside.state, [-2, 0]));
  const following = bindNavigationPath(outside.state, path, [0, 0]).state;
  const outsidePrediction = predictNavigation(following, [-2, 0]);
  assert.deepEqual(outsidePrediction.selection.decision, { type: 'OUTSIDE_MAP' });
  assert.equal(outsidePrediction.state.execution.activity.type, 'FOLLOWING');
  assert.equal(outsidePrediction.state.execution.activity.path, path);
  assert.deepEqual(predictNavigation(outsidePrediction.state, [0, 0]).selection.decision, { type: 'TARGET', target: [3.2, 0] });
});

const coreMove = (column, overrides = {}) => ({
  type: 'MOVE', target: {
    position: [0, column], reachOffset: [0, 0], randomizeReachOffset: false, reachDistance: 0, ...overrides,
  },
});

function routedEnemyHarness({
  seed = 42, speedPerTick = 10, checkpoints, routeOverrides = {}, alwaysCheckCurrentPoint = true,
  initialTick = 0, timing = { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
} = {}) {
  const route = createRouteDefinition(coreRoute({
    startPosition: [0, 0], endPosition: [0, 4], spawnOffset: [0, 0], spawnRandomRange: [0, 0],
    checkpoints: checkpoints ?? [coreMove(1), { type: 'WAIT_FOR_TICKS', durationTicks: 3 }], ...routeOverrides,
  }));
  const initialized = initializeRoutedEnemy({
    id: 1,
    definition: createEnemyDefinition({ id: 'enemy_core_walker', vitality: { maxHp: 100 }, locomotion: {
      moveSpeedPerTick: speedPerTick,
      steeringParameters: createSteeringParameters({ steeringFactor: 2.5, maxSteeringForce: 4 }),
    } }),
    route, timing: createRouteTiming(timing), tick: initialTick,
    alwaysCheckCurrentPoint, rngState: seed, nextNavigationRequestId: 0,
  });
  let enemy = initialized.enemy, rngState = initialized.rngState, nextNavigationRequestId = initialized.nextNavigationRequestId, tick = initialTick;
  let maps = Object.freeze({
    WALK: fieldMap(1, 5, Array.from({ length: 5 }, () => fieldCell())),
    FLY: fieldMap(1, 5, Array.from({ length: 5 }, () => fieldCell()), 'FLY'),
  });
  const fieldCache = createNavigationFieldCache();
  const trace = [];
  return {
    get enemy() { return enemy; },
    get rngState() { return rngState; },
    get nextNavigationRequestId() { return nextNavigationRequestId; },
    get tick() { return tick; },
    get maps() { return maps; },
    get initialSignals() { return initialized.signals; },
    trace,
    setMaps(next) { maps = next; },
    displace(position) { enemy = { ...enemy, position: Object.freeze([...position]) }; },
    setAlternative(route, alwaysCheckCurrentPoint = false) {
      const execution = createRouteExecution(createRng(rngState), nextNavigationRequestId, tick);
      const initial = initializeRouteControl(route, enemy.locomotion.mainRoute.route.timing,
        alwaysCheckCurrentPoint, [0, 0], enemy.position, execution, enemy.spatialPresence.present);
      enemy = { ...enemy, position: initial.position, spatialPresence: { present: initial.present },
        locomotion: { ...enemy.locomotion, alternativeRoute: initial.control } };
      ({ rngState, nextNavigationRequestId } = execution.state());
    },
    clearAlternative() {
      enemy = { ...enemy, locomotion: { ...enemy.locomotion, alternativeRoute: null } };
    },
    setMotionMode(mode) {
      const locomotion = enemy.locomotion, mainRoute = locomotion.mainRoute;
      enemy = {
        ...enemy,
        locomotion: {
          ...locomotion,
          mainRoute: { ...mainRoute, navigation: setNavigationMotionMode(mainRoute.navigation, mode) },
        },
      };
    },
    step(controls = {}) {
      const context = {
        maps, fieldCache, rngState, nextNavigationRequestId, tick,
        moveMultiplier: controls.moveMultiplier ?? 1,
        movementAllowed: controls.movementAllowed ?? true,
        routeAdvanceAllowed: controls.routeAdvanceAllowed ?? true,
        waitTickAllowed: controls.waitTickAllowed ?? true,
        motionOverride: controls.motionOverride,
      };
      const before = JSON.stringify({ enemy, context });
      const oldLocomotion = enemy.locomotion, oldMainRoute = oldLocomotion.mainRoute;
      const result = stepRoutedEnemy(enemy, context);
      assert.equal(JSON.stringify({ enemy, context }), before);
      assert.equal(enemy.locomotion, oldLocomotion);
      assert.equal(enemy.locomotion.mainRoute, oldMainRoute);
      assert.equal(Object.hasOwn(result.enemy, 'route'), false);
      assert.equal(Object.hasOwn(result.enemy, 'navigation'), false);
      assert.equal(result.enemy.definition, enemy.definition);
      if (oldLocomotion.alternativeRoute === null) assert.equal(result.enemy.locomotion.alternativeRoute, null);
      assert.equal(Object.isFrozen(result.enemy.locomotion), false);
      assert.equal(Object.isFrozen(result.enemy.locomotion.steering), false);
      enemy = result.enemy;
      rngState = result.rngState;
      nextNavigationRequestId = result.nextNavigationRequestId;
      trace.push(JSON.parse(JSON.stringify({ tick, enemy, rngState, nextNavigationRequestId,
        outcomes: result.outcomes, signals: result.signals })));
      tick++;
      return result;
    },
  };
}

function routedEnemyRequest(enemy) {
  const activity = enemy.locomotion.mainRoute.navigation.execution.activity;
  return activity.type === 'FOLLOWING' || activity.type === 'UNREACHABLE' ? activity.path.request : activity.request;
}

test('core ordinary movement cannot snap across an unreachable wall even with a large budget', () => {
  const h = routedEnemyHarness({ speedPerTick: 2, checkpoints: [], routeOverrides: { endPosition: [0, 2] } });
  const map = fieldMap(1, 3, [fieldCell(), fieldCell({ passable: false }), fieldCell()]);
  h.setMaps({ WALK: map, FLY: map });
  const seed = h.rngState, nextId = h.nextNavigationRequestId;
  const first = h.step();
  assert.deepEqual(h.enemy.position, [0, 0]);
  assert.equal(h.enemy.locomotion.moving, false);
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'END');
  const navigation = h.enemy.locomotion.mainRoute.navigation;
  assert.equal(navigation.execution.activity.type, 'UNREACHABLE');
  assert.deepEqual(predictNavigation(navigation, [0, 0]).selection.decision, { type: 'TARGET', target: [2, 0] });
  assert.equal(canCompleteNavigationSegment(navigation, [0, 0], [2, 0]), false);
  assert.deepEqual(first.outcomes, [{ type: 'UNREACHABLE', requestId: 0, reason: 'POSITION_UNREACHABLE' }]);
  assert.deepEqual(h.step().outcomes, []);
  assert.deepEqual(h.enemy.position, [0, 0]);
  assert.equal(h.rngState, seed);
  assert.equal(h.nextNavigationRequestId, nextId);
});

test('core large-budget movement follows each current segment around walls and high-cost tiles', () => {
  for (const obstacle of [{ passable: false }, { moveCost: 1000 }]) {
    const cells = Array.from({ length: 6 }, () => fieldCell());
    cells[1] = fieldCell(obstacle);
    const map = fieldMap(2, 3, cells);
    const h = routedEnemyHarness({ speedPerTick: 2, checkpoints: [], routeOverrides: { endPosition: [0, 2] } });
    h.setMaps({ WALK: map, FLY: map });
    h.step();
    assert.deepEqual(h.enemy.position, [0, 1]);
    assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'END');
    const positions = [h.enemy.position];
    for (let tick = 0; tick < 10 && h.enemy.locomotion.mainRoute.route.progress.phase !== 'COMPLETED'; tick++) {
      h.step();
      positions.push(h.enemy.position);
    }
    assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'COMPLETED');
    assert.deepEqual(h.enemy.position, [2, 0]);
    assert.ok(positions.every(position => position[1] >= 0.5 || position[0] === 0 || position[0] === 2));
  }
});

test('core ordinary movement respects one-way departures in all four directions and permits the reverse', () => {
  const cases = [
    { start: [0, 2], end: [0, 0], direction: 'LEFT', first: [2, 1] },
    { start: [0, 0], end: [0, 2], direction: 'RIGHT', first: [0, 1] },
    { start: [2, 0], end: [0, 0], direction: 'DOWN', first: [1, 2] },
    { start: [0, 0], end: [2, 0], direction: 'UP', first: [1, 0] },
  ];
  for (const { start, end, direction, first } of cases) {
    const cells = Array.from({ length: 9 }, () => fieldCell());
    cells[start[0] * 3 + start[1]] = fieldCell({ departures: { ...fieldCell().departures, [direction]: false } });
    const map = fieldMap(3, 3, cells);
    const h = routedEnemyHarness({ speedPerTick: 2, checkpoints: [], routeOverrides: { startPosition: start, endPosition: end } });
    h.setMaps({ WALK: map, FLY: map });
    h.step();
    assert.deepEqual(h.enemy.position, first, direction);
    assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'END');
    const reverse = routedEnemyHarness({ speedPerTick: 2, checkpoints: [], routeOverrides: { startPosition: end, endPosition: start } });
    reverse.setMaps({ WALK: map, FLY: map });
    reverse.step();
    assert.deepEqual(reverse.enemy.position, [start[1], start[0]], direction);
    assert.equal(reverse.enemy.locomotion.mainRoute.route.progress.phase, 'COMPLETED');
  }
});

test('core continuous segment permissions use actual directed crossings and rounded boundary ownership', () => {
  const cells = Array.from({ length: 9 }, () => fieldCell());
  cells[0] = fieldCell({ departures: { ...fieldCell().departures, RIGHT: false } });
  const map = fieldMap(3, 3, cells);
  assert.equal(canTraverseNavigationSegment(map, [0.5, 0], [1, 0]), false);
  assert.equal(canTraverseNavigationSegment(map, [1, 0], [0.5, 0]), true);
  assert.equal(canTraverseNavigationSegment(map, [0, 0], [0.5, 0]), true);
  assert.equal(canTraverseNavigationSegment(map, [1.5, 0], [1, 0]), true);
  assert.equal(canTraverseNavigationSegment(map, [0, 0], [0, 0]), true);
  assert.equal(canTraverseNavigationSegment(map, [0.49, 0.1], [1, 1]), false);
  assert.equal(canTraverseNavigationSegment(map, [1, 1], [0.49, 0.1]), true);
  const cornerCells = Array.from({ length: 4 }, () => fieldCell());
  cornerCells[1] = fieldCell({ departures: { ...fieldCell().departures, UP: false } });
  const corner = fieldMap(2, 2, cornerCells);
  assert.equal(canTraverseNavigationSegment(corner, [0, 0], [1, 1]), false);
  assert.equal(canTraverseNavigationSegment(corner, [1, 1], [0, 0]), true);
});

test('core ordinary movement checks both world and locator segments and uses the selected motion map', () => {
  const cells = Array.from({ length: 6 }, () => fieldCell());
  cells[1] = fieldCell({ passable: false });
  const walk = fieldMap(2, 3, cells);
  const fly = fieldMap(2, 3, Array.from({ length: 6 }, () => fieldCell()), 'FLY');
  const h = routedEnemyHarness({ speedPerTick: 10, checkpoints: [], routeOverrides: {
    endPosition: [1, 2], spawnOffset: [0.49, 0],
  } });
  h.setMaps({ WALK: walk, FLY: fly });
  h.step();
  assert.deepEqual(h.enemy.position, [0.49, 1]);
  for (let tick = 0; tick < 10 && h.enemy.locomotion.mainRoute.route.progress.phase !== 'COMPLETED'; tick++) h.step();
  assert.deepEqual(h.enemy.position, [2.49, 1]);
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'COMPLETED');
  const flying = routedEnemyHarness({ speedPerTick: 2, checkpoints: [], routeOverrides: { endPosition: [0, 2], pathMotionMode: 'FLY' } });
  flying.setMaps({ WALK: walk, FLY: fly });
  flying.step();
  assert.deepEqual(flying.enemy.position, [2, 0]);
  assert.equal(flying.enemy.locomotion.mainRoute.route.progress.phase, 'COMPLETED');
});

test('core ordinary steering cannot carry old velocity through a wall to a passable landing tile', () => {
  const cells = Array.from({ length: 15 }, () => fieldCell());
  cells[1] = fieldCell({ passable: false });
  const map = fieldMap(5, 3, cells);
  const h = routedEnemyHarness({ speedPerTick: 2, checkpoints: [], routeOverrides: { endPosition: [4, 0] } });
  h.setMaps({ WALK: map, FLY: map });
  h.enemy.definition = createEnemyDefinition({ ...h.enemy.definition, locomotion: {
    ...h.enemy.definition.locomotion,
    steeringParameters: createSteeringParameters({ steeringFactor: 1, maxSteeringForce: 0 }),
  } });
  h.enemy.locomotion.steering.lastVelocity = [2, 0];
  h.step();
  assert.deepEqual(h.enemy.position, [0, 0]);
  assert.equal(h.enemy.locomotion.moving, false);
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'END');
});

test('core unreachable MOVE and wait preview targets cannot trigger a snap or checkpoint arrival', () => {
  const map = fieldMap(1, 3, [fieldCell(), fieldCell({ passable: false }), fieldCell()]);
  for (const checkpoints of [[coreMove(2)], [{ type: 'WAIT_FOR_TICKS', durationTicks: 10 }, coreMove(2)]]) {
    const h = routedEnemyHarness({ speedPerTick: 2, checkpoints, routeOverrides: { endPosition: [0, 2] } });
    h.setMaps({ WALK: map, FLY: map });
    const nextId = h.nextNavigationRequestId, seed = h.rngState;
    const result = h.step();
    assert.deepEqual(h.enemy.position, [0, 0]);
    assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'CHECKPOINTS');
    assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpointIndex, 0);
    assert.equal(result.outcomes.some(outcome => outcome.type === 'ARRIVED'), false);
    assert.equal(h.nextNavigationRequestId, nextId);
    assert.equal(h.rngState, seed);
  }
});

test('core motion overrides and scripted appearances retain their explicit displacement semantics', () => {
  const map = fieldMap(1, 3, [fieldCell(), fieldCell({ passable: false }), fieldCell()]);
  const displaced = routedEnemyHarness({ speedPerTick: 2, checkpoints: [], routeOverrides: { endPosition: [0, 2] } });
  displaced.setMaps({ WALK: map, FLY: map });
  displaced.step({ motionOverride: { type: 'DISPLACEMENT', displacement: [2, 0] } });
  assert.deepEqual(displaced.enemy.position, [2, 0]);
  const appeared = routedEnemyHarness({ speedPerTick: 0, checkpoints: [
    { type: 'APPEAR_AT_POS', position: [0, 2], reachOffset: [0, 0] },
  ], routeOverrides: { endPosition: [0, 2] } });
  appeared.setMaps({ WALK: map, FLY: map });
  appeared.step();
  assert.deepEqual(appeared.enemy.position, [2, 0]);
});

test('core serial MOVE-WAIT-END snaps once per step and waits independently of zero speed and blocking', () => {
  const h = routedEnemyHarness();
  assert.equal(Object.hasOwn(h.enemy, 'route'), false);
  assert.equal(Object.hasOwn(h.enemy, 'navigation'), false);
  const initialLocomotion = h.enemy.locomotion;
  assert.equal(Object.hasOwn(initialLocomotion, 'controller'), false);
  assert.equal(initialLocomotion.alternativeRoute, null);
  assert.equal(initialLocomotion.mainRoute.route.progress.checkpoint.type, 'MOVE');
  initialLocomotion.moving = true;
  initialLocomotion.steering.lastVelocity = Object.freeze([0, 0]);
  h.enemy.vitality.hp = 90;
  h.step();
  assert.equal(initialLocomotion.mainRoute.route.progress.checkpoint.type, 'MOVE');
  assert.equal(h.enemy.vitality.hp, 90);
  assert.deepEqual(h.enemy.position, [1, 0]);
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpointIndex, 1);
  assert.deepEqual(h.enemy.locomotion.mainRoute.route.progress.checkpoint, { type: 'WAIT', remainingTicks: 3 });
  assert.equal(h.enemy.locomotion.moving, true);
  h.step({ moveMultiplier: 0 });
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 2);
  assert.deepEqual(h.enemy.position, [1, 0]);
  assert.equal(h.enemy.locomotion.moving, false);
  h.step({ movementAllowed: false });
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 1);
  assert.deepEqual(h.enemy.position, [1, 0]);
  const completed = h.step();
  assert.deepEqual(h.enemy.position, [4, 0]);
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'COMPLETED');
  assert.deepEqual(completed.outcomes, [{ type: 'ARRIVED', requestId: 1 }]);
  assert.equal(h.nextNavigationRequestId, 2);
});

test('core serial WAIT entered before movement consumes one tick and WAIT entered after snap starts next tick', () => {
  const before = routedEnemyHarness();
  before.step({ moveMultiplier: 0 });
  assert.equal(before.enemy.locomotion.mainRoute.route.progress.checkpoint.type, 'MOVE');
  before.displace([0.96, 0]);
  before.step({ moveMultiplier: 0.001 });
  assert.deepEqual(before.enemy.position, [0.96, 0]);
  assert.deepEqual(before.enemy.locomotion.mainRoute.route.progress.checkpoint, { type: 'WAIT', remainingTicks: 2 });
  const after = routedEnemyHarness();
  after.step();
  assert.deepEqual(after.enemy.position, [1, 0]);
  assert.deepEqual(after.enemy.locomotion.mainRoute.route.progress.checkpoint, { type: 'WAIT', remainingTicks: 3 });
});

test('core serial route advancement can pause while wait time continues to expire', () => {
  const h = routedEnemyHarness();
  h.step();
  const waiting = h.enemy;
  waiting.locomotion.mainRoute.route.progress.checkpoint.remainingTicks = 1;
  h.step({ movementAllowed: false, routeAdvanceAllowed: false, moveMultiplier: 0 });
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'CHECKPOINTS');
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpointIndex, 1);
  assert.deepEqual(h.enemy.locomotion.mainRoute.route.progress.checkpoint, { type: 'WAIT', remainingTicks: 0 });
  assert.deepEqual(waiting.locomotion.mainRoute.route.progress.checkpoint, { type: 'WAIT', remainingTicks: 1 });
  h.step({ routeAdvanceAllowed: false });
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpointIndex, 1);
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 0);
  assert.deepEqual(h.enemy.position, [4, 0]);
  h.step({ movementAllowed: false });
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'COMPLETED');
  assert.deepEqual(h.enemy.position, [4, 0]);
});

test('core serial reached MOVE resumes through heading before the wait tick and reports arrival once', () => {
  const h = routedEnemyHarness({ speedPerTick: 0, checkpoints: [
    coreMove(2, { reachDistance: 0.1 }), { type: 'WAIT_FOR_TICKS', durationTicks: 2 },
  ] });
  h.displace([1.95, 0]);
  const paused = h.step({ routeAdvanceAllowed: false });
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpointIndex, 0);
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpoint.type, 'MOVE');
  assert.equal(h.enemy.locomotion.mainRoute.navigation.execution.activity.type, 'ARRIVED');
  assert.deepEqual(paused.outcomes, [{ type: 'ARRIVED', requestId: 0 }]);
  const resumed = h.step();
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpointIndex, 1);
  assert.deepEqual(h.enemy.locomotion.mainRoute.route.progress.checkpoint, { type: 'WAIT', remainingTicks: 1 });
  assert.deepEqual(resumed.outcomes, []);
  assert.deepEqual(h.enemy.position, [1.95, 0]);
});

test('core routed enemy keeps one randomized goal across map changes, motion mode changes and displacement', () => {
  const seed = 42;
  const h = routedEnemyHarness({ seed, checkpoints: [
    coreMove(2, { randomizeReachOffset: true, reachOffset: [0.25, 0] }),
    coreMove(3, { randomizeReachOffset: true, reachOffset: [0.25, 0.125] }),
  ] });
  const expected = createRng(seed);
  expected.next();
  expected.next();
  const x = -0.25 + expected.next() * 0.5;
  expected.next();
  const request = routedEnemyRequest(h.enemy), goal = h.enemy.locomotion.mainRoute.route.progress.checkpoint.goal;
  assert.deepEqual(goal.position, [2 + x, 0]);
  assert.equal(goal.reachDistance, 0.05);
  assert.equal(request.goal, goal);
  assert.equal(request.id, 0);
  assert.equal(h.rngState, expected.state());
  assert.equal(h.nextNavigationRequestId, 1);
  const savedRngState = h.rngState;
  const serialExpected = createRng(savedRngState);
  serialExpected.next();
  serialExpected.next();
  const secondX = -0.25 + serialExpected.next() * 0.5;
  serialExpected.next();
  const second = initializeRoutedEnemy({
    id: 2, definition: h.enemy.definition, route: h.enemy.locomotion.mainRoute.route.definition,
    timing: h.enemy.locomotion.mainRoute.route.timing, tick: h.tick, alwaysCheckCurrentPoint: true,
    rngState: savedRngState, nextNavigationRequestId: h.nextNavigationRequestId,
  });
  const secondRequest = routedEnemyRequest(second.enemy), secondGoal = second.enemy.locomotion.mainRoute.route.progress.checkpoint.goal;
  assert.deepEqual(secondGoal.position, [2 + secondX, 0]);
  assert.equal(secondRequest.goal, secondGoal);
  assert.equal(secondRequest.id, 1);
  assert.equal(second.rngState, serialExpected.state());
  assert.equal(second.nextNavigationRequestId, 2);
  assert.equal(h.rngState, savedRngState);
  assert.equal(routedEnemyRequest(h.enemy), request);
  h.step({ moveMultiplier: 0 });
  assert.equal(routedEnemyRequest(h.enemy), request);
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpoint.goal, goal);
  assert.equal(h.rngState, savedRngState);
  assert.equal(h.nextNavigationRequestId, 1);
  const changedMaps = Object.freeze({
    WALK: createNavigationMap({ rows: 1, columns: 5, pathMotionMode: 'WALK', revision: 1, cells: Array.from({ length: 5 }, () => fieldCell()) }),
    FLY: createNavigationMap({ rows: 1, columns: 5, pathMotionMode: 'FLY', revision: 1, cells: Array.from({ length: 5 }, () => fieldCell()) }),
  });
  h.setMaps(changedMaps);
  h.step({ moveMultiplier: 0 });
  assert.equal(h.enemy.locomotion.mainRoute.navigation.execution.activity.path.field.map, changedMaps.WALK);
  const walkingLocomotion = h.enemy.locomotion, walkingMainRoute = walkingLocomotion.mainRoute;
  h.setMotionMode('FLY');
  assert.equal(h.enemy.locomotion.steering.lastVelocity, walkingLocomotion.steering.lastVelocity);
  assert.equal(h.enemy.locomotion.mainRoute.route, walkingMainRoute.route);
  assert.equal(walkingMainRoute.navigation.pathMotionMode, 'WALK');
  h.step({ moveMultiplier: 0 });
  assert.equal(h.enemy.locomotion.mainRoute.navigation.execution.activity.path.field.map, changedMaps.FLY);
  const flyingLocomotion = h.enemy.locomotion;
  h.displace([1.1, 0]);
  assert.equal(h.enemy.locomotion, flyingLocomotion);
  h.step({ moveMultiplier: 0 });
  assert.equal(routedEnemyRequest(h.enemy), request);
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpoint.goal, goal);
  assert.equal(h.rngState, savedRngState);
  assert.equal(h.nextNavigationRequestId, 1);
  const nextX = -0.25 + expected.next() * 0.5;
  const nextY = -0.125 + expected.next() * 0.25;
  h.step();
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpointIndex, 1);
  assert.deepEqual(h.enemy.locomotion.mainRoute.route.progress.checkpoint.goal.position, [3 + nextX, nextY]);
  assert.equal(h.rngState, expected.state());
  assert.equal(h.nextNavigationRequestId, 2);
  assert.notEqual(h.enemy.locomotion.mainRoute.route.progress.checkpoint.goal, goal);
});

test('core routed enemy reproduces a complete trace from the same seed and explicit controls', () => {
  const settings = { seed: 7919, checkpoints: [
    coreMove(1, { randomizeReachOffset: true, reachOffset: [0.2, 0.2] }),
    { type: 'WAIT_FOR_TICKS', durationTicks: 2 }, coreMove(3),
  ], routeOverrides: { spawnOffset: [0.1, -0.1], spawnRandomRange: [0.2, 0.2] } };
  const first = routedEnemyHarness(settings), second = routedEnemyHarness(settings);
  const originalRandom = Math.random;
  Math.random = () => { throw new Error('core routed enemy consumed global randomness'); };
  try {
    for (const h of [first, second]) {
      for (let step = 0; step < 16 && h.enemy.locomotion.mainRoute.route.progress.phase !== 'COMPLETED'; step++) {
        h.step({ movementAllowed: step !== 2, moveMultiplier: step === 3 ? 0 : 1 });
      }
      assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'COMPLETED');
    }
    assert.deepEqual(first.trace, second.trace);
    assert.deepEqual(first.enemy.position.map((coordinate, axis) => coordinate + first.enemy.locomotion.mainRoute.navigation.execution.locatorOffset[axis]), [4, 0]);
  } finally {
    Math.random = originalRandom;
  }
});

test('core locomotion retains velocity history, clamps acceleration and reports actual displacement', () => {
  const parameters = createSteeringParameters({ steeringFactor: 2.5, maxSteeringForce: 2 });
  const state = createSteeringState(), position = [0, 0], target = [100, 0];
  const before = JSON.stringify({ state, position, target, parameters });
  const first = integrateSteering(state, position, target, 10, parameters);
  assert.deepEqual(first.state.lastVelocity, [2, 0]);
  assert.deepEqual(first.position, [2, 0]);
  assert.equal(Object.hasOwn(first.state, 'moving'), false);
  const next = integrateSteering(first.state, first.position, target, 10, parameters);
  assert.deepEqual(next.state.lastVelocity, [4, 0]);
  assert.deepEqual(next.position, [6, 0]);
  const stopped = integrateSteering(next.state, next.position, target, 0, parameters);
  assert.equal(stopped.position, next.position);
  assert.equal(stopped.state.lastVelocity, next.state.lastVelocity);
  const retained = integrateSteering(next.state, next.position, target, 10, createSteeringParameters({ steeringFactor: 2.5, maxSteeringForce: 0 }));
  assert.deepEqual(retained.state.lastVelocity, [4, 0]);
  assert.deepEqual(retained.position, [10, 0]);
  assert.deepEqual(World.clampMagnitude([1e-200, 0], 0), [0, 0]);
  const fast = integrateSteering(state, position, target, 1, createSteeringParameters({ steeringFactor: 100, maxSteeringForce: 100 }));
  assert.deepEqual(fast.state.lastVelocity, [1, 0]);
  assert.deepEqual(fast.position, [1, 0]);
  const disabled = integrateSteering(state, position, target, 10, createSteeringParameters({ steeringFactor: 0, maxSteeringForce: 4 }));
  assert.deepEqual(disabled.position, [0, 0]);
  assert.ok(Object.isFrozen(parameters) && Object.isFrozen(first.position) && Object.isFrozen(first.state.lastVelocity));
  assert.equal(Object.isFrozen(first.state), false);
  assert.equal(JSON.stringify({ state, position, target, parameters }), before);
  const h = routedEnemyHarness({ speedPerTick: 0.5 });
  h.step();
  assert.deepEqual(h.enemy.locomotion.steering.lastVelocity, [0.5, 0]);
  h.step();
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpoint.type, 'WAIT');
  assert.deepEqual(h.enemy.locomotion.steering.lastVelocity, [0.5, 0]);
  h.step({ movementAllowed: false });
  assert.equal(h.enemy.locomotion.moving, false);
  assert.deepEqual(h.enemy.locomotion.steering.lastVelocity, [0.5, 0]);
});

test('core empty routes accept checkpoint flag combinations and complete only at the end goal', () => {
  for (const alwaysCheckCurrentPoint of [false, true]) {
    for (const visitEveryCheckPoint of [false, true]) {
      const h = routedEnemyHarness({ checkpoints: [], alwaysCheckCurrentPoint, routeOverrides: { visitEveryCheckPoint } });
      const request = routedEnemyRequest(h.enemy), rngState = h.rngState;
      assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'END');
      assert.equal(h.enemy.locomotion.mainRoute.route.alwaysCheckCurrentPoint, alwaysCheckCurrentPoint);
      assert.equal(request.arrivalRule, 'TARGET_TILE_AND_DISTANCE');
      assert.equal(request.options.visitEveryNodeStably, true);
      h.displace([-2, 0]);
      assert.deepEqual(h.step().outcomes, []);
      assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'END');
      h.displace([3.8, 0]);
      assert.deepEqual(h.step({ movementAllowed: false }).outcomes, []);
      assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'END');
      h.displace([0, 0]);
      for (let step = 0; step < 12 && h.enemy.locomotion.mainRoute.route.progress.phase !== 'COMPLETED'; step++) h.step();
      assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'COMPLETED');
      assert.deepEqual(h.enemy.position, [4, 0]);
      assert.deepEqual(h.trace.flatMap(entry => entry.outcomes), [{ type: 'ARRIVED', requestId: request.id }]);
      assert.equal(h.nextNavigationRequestId, 1);
      assert.equal(h.rngState, rngState);
    }
  }
});

test('core routed enemy supports full checkpoint flag combinations and rejects invalid definition values', () => {
  for (const visitEveryCheckPoint of [false, true]) {
    for (const alwaysCheckCurrentPoint of [false, true]) {
      const h = routedEnemyHarness({ checkpoints: [{ type: 'ALERT' }, coreMove(2)],
        routeOverrides: { visitEveryCheckPoint }, alwaysCheckCurrentPoint });
      assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpoint.type, 'ENTERED');
      h.step();
      assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpointIndex, 1);
    }
  }
  assert.throws(() => createEnemyDefinition({ id: 'enemy_bad', vitality: { maxHp: 0 }, locomotion: {
    moveSpeedPerTick: 1, steeringParameters: createSteeringParameters({ steeringFactor: 2.5, maxSteeringForce: 4 }),
  } }), RangeError);
  assert.throws(() => createSteeringParameters({ steeringFactor: Infinity, maxSteeringForce: 4 }), RangeError);
});

const battlefieldUnit = (id, position) => ({
  id, definition: Object.freeze({ id: `battlefield_unit_${id}` }), position: Object.freeze([...position]),
});
const battlefieldMechanism = (id, active = true) => createMechanismRuntime({
  id, definition: createMechanismDefinition({ id: `battlefield_mechanism_${id}` }), active,
});
const walkRestriction = (overrides = {}) => ({ denyPassage: false, deniedDepartures: [], costFloor: 1, ...overrides });
const effectDefinition = (id, WALK, FLY = null) => createNavigationEffectDefinition({ id, WALK, FLY });
const fixedNavigationEffect = (id, source, position, definition, overrides = {}) => createNavigationSpatialEffect({
  id, source, definition, active: true, expiresAtTick: null,
  region: { type: 'FIXED', position, range: [[0, 0]], direction: 'RIGHT' }, ...overrides,
});
const flatBattlefieldRuntime = (rows = 1, columns = 5) => createBattlefieldRuntime({
  map: createBattlefieldMap(rows, columns, Array.from({ length: rows * columns }, () => coreGround())),
});

test('core battlefield combines source restrictions and rebuilds navigation from the static baseline on removal', () => {
  const runtime = flatBattlefieldRuntime();
  runtime.apply([
    { type: 'REGISTER_UNIT', unit: battlefieldUnit(10, [2, 0]) },
    { type: 'REGISTER_UNIT', unit: battlefieldUnit(11, [3, 0]) },
  ]);
  const baseline = runtime.navigationMaps;
  const oldField = buildNavigationField(baseline.WALK, fieldQuery([0, 4]));
  const source = { type: 'UNIT', unitId: 10 };
  const crate = fixedNavigationEffect(1, source, [0, 2], effectDefinition('crate', walkRestriction({ costFloor: 1000 })));
  const otherSource = { type: 'UNIT', unitId: 11 };
  const other = fixedNavigationEffect(2, otherSource, [0, 2], effectDefinition('other', walkRestriction({
    costFloor: 2000, deniedDepartures: ['RIGHT'],
  })));
  const blocked = fixedNavigationEffect(3, source, [0, 2], effectDefinition('blocked', walkRestriction({ denyPassage: true, deniedDepartures: ['UP'] })));
  const added = runtime.apply([{ type: 'ADD_EFFECT', effect: crate }, { type: 'ADD_EFFECT', effect: other }]);
  assert.deepEqual(added.changedNavigationModes, ['WALK']);
  assert.equal(runtime.navigationMaps.WALK.revision, 1);
  assert.equal(runtime.navigationMaps.WALK.cells[2].moveCost, 2000);
  assert.equal(runtime.navigationMaps.WALK.cells[2].departures.RIGHT, false);
  assert.equal(runtime.navigationMaps.FLY, baseline.FLY);
  assert.equal(runtime.navigationMaps.FLY.cells[2].moveCost, 1);
  assert.deepEqual(distances(buildRawNavigationField(runtime.navigationMaps.WALK, fieldQuery([0, 4]))), [-1, -1, -1, 1, 0]);
  const overlap = runtime.navigationMaps;
  const maskedRemoval = runtime.apply([{ type: 'REMOVE_EFFECT', effectId: 1 }]);
  assert.deepEqual(maskedRemoval.removedEffects, [1]);
  assert.deepEqual(maskedRemoval.changedNavigationModes, []);
  assert.equal(runtime.navigationMaps, overlap);
  runtime.apply([{ type: 'ADD_EFFECT', effect: blocked }]);
  assert.equal(runtime.navigationMaps.WALK.cells[2].passable, false);
  assert.equal(runtime.navigationMaps.WALK.cells[2].departures.UP, false);
  assert.equal(runtime.navigationMaps.WALK.cells[2].departures.RIGHT, false);
  const removedSource = runtime.apply([{ type: 'REMOVE_UNIT', unitId: 10, reason: 'SCRIPT' }]);
  assert.deepEqual(removedSource.removedUnits, [{ unitId: 10, reason: 'SCRIPT' }]);
  assert.deepEqual(removedSource.removedEffects, [3]);
  assert.equal(runtime.navigationMaps.WALK.cells[2].passable, true);
  assert.equal(runtime.navigationMaps.WALK.cells[2].departures.UP, true);
  assert.equal(runtime.navigationMaps.WALK.cells[2].departures.RIGHT, false);
  assert.equal(runtime.navigationMaps.WALK.cells[2].moveCost, 2000);
  runtime.apply([{ type: 'REMOVE_EFFECT', effectId: 2 }]);
  assert.equal(runtime.navigationMaps.WALK.cells[2].moveCost, 1);
  assert.equal(runtime.navigationMaps.WALK.cells[2].departures.RIGHT, true);
  assert.equal(runtime.navigationMaps.FLY, baseline.FLY);
  assert.equal(baseline.WALK.cells[2].moveCost, 1);
  assert.equal(oldField.map, baseline.WALK);
  assert.deepEqual(distances(oldField), [4, 3, 2, 1, 0]);
  const restoredWalk = runtime.navigationMaps.WALK;
  const flyOnly = runtime.apply([{ type: 'ADD_EFFECT', effect: fixedNavigationEffect(4, otherSource, [0, 2],
    effectDefinition('fly-edge', null, { denyPassage: false, deniedDepartures: ['RIGHT'] }), {
      region: { type: 'FIXED', position: [0, 2], range: [[0, 0]], direction: 'UP' },
    }) }]);
  assert.deepEqual(flyOnly.changedNavigationModes, ['FLY']);
  assert.equal(runtime.navigationMaps.WALK, restoredWalk);
  assert.equal(runtime.navigationMaps.FLY.cells[2].moveCost, 1);
  assert.equal(runtime.navigationMaps.FLY.cells[2].departures.RIGHT, false);
  assert.equal(runtime.navigationMaps.FLY.cells[2].departures.UP, true);
});

test('core battlefield follows quantized unit positions, clips rotated regions and updates spatial indexes', () => {
  const runtime = flatBattlefieldRuntime(2, 4);
  const source = { type: 'MECHANISM', mechanismId: 1 };
  const region = createSpatialEffectRegion({ type: 'FOLLOW_UNIT', unitId: 10, range: [[0, 0], [0, 1], [-1, 0]], direction: 'RIGHT' });
  const effect = createNavigationSpatialEffect({
    id: 1, source, region, definition: effectDefinition('following-crate', walkRestriction({ costFloor: 1000 })),
    active: true, expiresAtTick: null,
  });
  runtime.apply([
    { type: 'ADD_EFFECT', effect }, { type: 'REGISTER_MECHANISM', mechanism: battlefieldMechanism(1) },
    { type: 'REGISTER_UNIT', unit: battlefieldUnit(10, [0, 0]) },
  ]);
  assert.deepEqual(runtime.unitsAt([0, 0]).map(unit => unit.id), [10]);
  assert.deepEqual(runtime.effectsAt([0, 0]), [1]);
  assert.deepEqual(runtime.effectsAt([0, 1]), [1]);
  assert.deepEqual(runtime.effectsFollowing(10), [1]);
  assert.deepEqual(runtime.effectsFrom(source), [1]);
  const firstMaps = runtime.navigationMaps;
  runtime.apply([{ type: 'MOVE_UNIT', unitId: 10, position: Object.freeze([0.5, 0]) }]);
  assert.equal(runtime.navigationMaps, firstMaps);
  assert.deepEqual(runtime.unitsAt([0, 0]).map(unit => unit.id), [10]);
  runtime.apply([{ type: 'MOVE_UNIT', unitId: 10, position: Object.freeze([0.51, 0]) }]);
  assert.deepEqual(runtime.unitsAt([0, 0]), []);
  assert.deepEqual(runtime.unitsAt([0, 1]).map(unit => unit.id), [10]);
  assert.deepEqual(runtime.effectsAt([0, 0]), []);
  assert.deepEqual(runtime.effectsAt([0, 2]), [1]);
  assert.equal(runtime.navigationMaps.WALK.revision, firstMaps.WALK.revision + 1);
  assert.equal(runtime.navigationMaps.FLY, firstMaps.FLY);
  runtime.apply([{ type: 'MOVE_UNIT', unitId: 10, position: Object.freeze([-2, 0]) }]);
  assert.deepEqual(runtime.unitsAt([0, 1]), []);
  assert.deepEqual(runtime.effectsAt([0, 1]), []);
  assert.equal(runtime.navigationMaps.WALK.cells.every(cell => cell.moveCost === 1), true);
  const fixed = createSpatialEffectRegion({ type: 'FIXED', position: [0, 3], range: [[0, 0], [0, 1]], direction: 'UP' });
  runtime.apply([{ type: 'SET_EFFECT_REGION', effectId: 1, region: fixed }]);
  assert.deepEqual(runtime.effectsFollowing(10), []);
  assert.deepEqual(runtime.effectsFrom(source), [1]);
  assert.deepEqual(runtime.effectsAt([0, 3]), [1]);
  assert.deepEqual(runtime.effectsAt([1, 3]), [1]);
  assert.equal(runtime.navigationMaps.WALK.cells[3].moveCost, 1000);
  assert.equal(runtime.navigationMaps.WALK.cells[7].moveCost, 1000);
});

test('core battlefield keeps inactive effects, expires deadlines and cleans distinct sources and follow anchors', () => {
  const runtime = flatBattlefieldRuntime();
  runtime.apply([
    { type: 'REGISTER_UNIT', unit: battlefieldUnit(10, [0, 0]) },
    { type: 'REGISTER_UNIT', unit: battlefieldUnit(11, [1, 0]) },
    { type: 'REGISTER_MECHANISM', mechanism: battlefieldMechanism(1) },
  ]);
  const definition = effectDefinition('lifecycle-crate', walkRestriction({ costFloor: 1000 }));
  const fromMechanism = fixedNavigationEffect(1, { type: 'MECHANISM', mechanismId: 1 }, [0, 2], definition, { expiresAtTick: 5 });
  const followOther = fixedNavigationEffect(2, { type: 'UNIT', unitId: 10 }, [0, 0], definition, {
    region: { type: 'FOLLOW_UNIT', unitId: 11, range: [[0, 0]], direction: 'RIGHT' },
  });
  const fromOther = fixedNavigationEffect(3, { type: 'UNIT', unitId: 11 }, [0, 3], definition);
  runtime.apply([{ type: 'ADD_EFFECT', effect: fromMechanism }, { type: 'ADD_EFFECT', effect: followOther }, { type: 'ADD_EFFECT', effect: fromOther }]);
  runtime.apply([{ type: 'SET_MECHANISM_ACTIVE', mechanismId: 1, active: false }]);
  assert.equal(runtime.getEffect(1).active, true);
  assert.equal(runtime.navigationMaps.WALK.cells[2].moveCost, 1);
  const inactiveMaps = runtime.navigationMaps;
  runtime.apply([{ type: 'SET_EFFECT_ACTIVE', effectId: 1, active: false }]);
  assert.equal(runtime.navigationMaps, inactiveMaps);
  runtime.apply([{ type: 'SET_MECHANISM_ACTIVE', mechanismId: 1, active: true }]);
  assert.equal(runtime.navigationMaps, inactiveMaps);
  runtime.apply([{ type: 'SET_EFFECT_ACTIVE', effectId: 1, active: true }]);
  assert.equal(runtime.navigationMaps.WALK.cells[2].moveCost, 1000);
  assert.deepEqual(runtime.apply([{ type: 'EXPIRE_EFFECTS', tick: 4 }]).removedEffects, []);
  assert.deepEqual(runtime.apply([{ type: 'EXPIRE_EFFECTS', tick: 5 }]).removedEffects, [1]);
  assert.equal(runtime.getEffect(1), undefined);
  const removedAnchor = runtime.apply([{ type: 'REMOVE_UNIT', unitId: 11, reason: 'DEATH' }]);
  assert.deepEqual(removedAnchor.removedUnits, [{ unitId: 11, reason: 'DEATH' }]);
  assert.deepEqual([...removedAnchor.removedEffects].sort(), [2, 3]);
  assert.equal(runtime.getUnit(10).id, 10);
  assert.deepEqual(runtime.effectsFrom({ type: 'UNIT', unitId: 10 }), []);
  assert.deepEqual(runtime.effectsFollowing(11), []);
  const fromSource = fixedNavigationEffect(4, { type: 'UNIT', unitId: 10 }, [0, 0], definition);
  const finalMechanism = fixedNavigationEffect(5, { type: 'MECHANISM', mechanismId: 1 }, [0, 4], definition);
  runtime.apply([{ type: 'ADD_EFFECT', effect: fromSource }, { type: 'ADD_EFFECT', effect: finalMechanism }]);
  const removed = runtime.apply([
    { type: 'REMOVE_UNIT', unitId: 10, reason: 'EXPIRED' },
    { type: 'REMOVE_MECHANISM', mechanismId: 1, reason: 'SCRIPT' },
  ]);
  assert.deepEqual(removed.removedUnits, [{ unitId: 10, reason: 'EXPIRED' }]);
  assert.deepEqual(removed.removedMechanisms, [{ mechanismId: 1, reason: 'SCRIPT' }]);
  assert.deepEqual([...removed.removedEffects].sort(), [4, 5]);
  assert.deepEqual(runtime.unitIds, []);
  assert.deepEqual(runtime.mechanismIds, []);
  assert.deepEqual(runtime.effectIds, []);
  assert.equal(runtime.navigationMaps.WALK.cells.every(cell => cell.moveCost === 1), true);
});

test('core battlefield isolates dynamic snapshots and rejects a failed batch without changing maps or caches', () => {
  const runtime = flatBattlefieldRuntime();
  const h = routedEnemyHarness();
  const unit = h.enemy, mechanism = battlefieldMechanism(1);
  const effect = fixedNavigationEffect(1, { type: 'MECHANISM', mechanismId: 1 }, [0, 2], effectDefinition('snapshot-crate', walkRestriction({ costFloor: 1000 })));
  runtime.apply([{ type: 'REGISTER_UNIT', unit }, { type: 'REGISTER_MECHANISM', mechanism }, { type: 'ADD_EFFECT', effect }]);
  unit.vitality.hp = 1;
  unit.locomotion.mainRoute.navigation.execution.visits.visitedCenters.push(Object.freeze([0, 4]));
  mechanism.active = false;
  effect.active = false;
  const snapshot = runtime.getUnit(1);
  snapshot.vitality.hp = 2;
  snapshot.position = Object.freeze([3, 0]);
  snapshot.locomotion.steering.lastVelocity = Object.freeze([10, 0]);
  snapshot.locomotion.mainRoute.route.progress.checkpointIndex = 100;
  snapshot.locomotion.mainRoute.navigation.execution.visits.visitedCenters.push(Object.freeze([0, 3]));
  runtime.unitsAt([0, 0])[0].vitality.hp = 3;
  runtime.getMechanism(1).active = false;
  runtime.getEffect(1).active = false;
  assert.equal(runtime.getUnit(1).vitality.hp, 100);
  assert.deepEqual(runtime.getUnit(1).position, [0, 0]);
  assert.deepEqual(runtime.getUnit(1).locomotion.steering.lastVelocity, [0, 0]);
  assert.equal(runtime.getUnit(1).locomotion.mainRoute.route.progress.checkpointIndex, 0);
  assert.deepEqual(runtime.getUnit(1).locomotion.mainRoute.navigation.execution.visits.visitedCenters, []);
  assert.equal(runtime.getMechanism(1).active, true);
  assert.equal(runtime.getEffect(1).active, true);
  const before = JSON.stringify({ unit: runtime.getUnit(1), mechanisms: runtime.mechanismIds, effects: runtime.effectIds });
  const maps = runtime.navigationMaps;
  const request = createNavigationRequest(coreRequest({ targetTile: [0, 4], goal: { position: [4, 0], reachDistance: 0.05 } }));
  const field = runtime.fieldCache.get(maps.WALK, request);
  assert.throws(() => runtime.apply([
    { type: 'REGISTER_UNIT', unit: battlefieldUnit(10, [4, 0]) },
    { type: 'ADD_EFFECT', effect: fixedNavigationEffect(2, { type: 'UNIT', unitId: 10 }, [0, 3], effectDefinition('failed-denial', walkRestriction({ denyPassage: true }))) },
    { type: 'REGISTER_UNIT', unit: battlefieldUnit(1, [2, 0]) },
  ]));
  assert.equal(runtime.getUnit(10), undefined);
  assert.equal(runtime.getEffect(2), undefined);
  assert.equal(runtime.navigationMaps, maps);
  assert.equal(runtime.fieldCache.get(maps.WALK, request), field);
  assert.equal(JSON.stringify({ unit: runtime.getUnit(1), mechanisms: runtime.mechanismIds, effects: runtime.effectIds }), before);
  assert.throws(() => runtime.apply([{ type: 'ADD_EFFECT', effect: fixedNavigationEffect(2, { type: 'UNIT', unitId: 99 }, [0, 3], effect.definition) }]));
  assert.equal(runtime.navigationMaps, maps);
  assert.deepEqual(runtime.effectIds, [1]);
  const updated = runtime.getUnit(1);
  updated.definition = Object.freeze({ ...updated.definition });
  assert.throws(() => runtime.apply([{ type: 'UPDATE_UNIT', unit: updated }]));
});

test('core battlefield commits phased changes together and preserves maps and cached fields on rollback', () => {
  const runtime = flatBattlefieldRuntime();
  runtime.apply([{ type: 'REGISTER_UNIT', unit: battlefieldUnit(10, [0, 0]) }]);
  const maps = runtime.navigationMaps;
  const request = createNavigationRequest(coreRequest({ targetTile: [0, 4], goal: { position: [4, 0], reachDistance: 0.05 } }));
  const cached = runtime.fieldCache.get(maps.WALK, request);
  const effect = fixedNavigationEffect(1, { type: 'UNIT', unitId: 10 }, [0, 2], effectDefinition('phased', walkRestriction({ costFloor: 1000 })));
  assert.throws(() => runtime.transact(field => {
    field.apply([{ type: 'ADD_EFFECT', effect }]);
    assert.notEqual(field.navigationMaps.WALK, maps.WALK);
    field.apply([{ type: 'MOVE_UNIT', unitId: 10, position: Object.freeze([1, 0]) }]);
    throw new Error('movement failed');
  }), /movement failed/);
  assert.equal(runtime.navigationMaps, maps);
  assert.deepEqual(runtime.getUnit(10).position, [0, 0]);
  assert.deepEqual(runtime.effectIds, []);
  assert.deepEqual(runtime.unitsAt([0, 0]).map(unit => unit.id), [10]);
  assert.equal(runtime.fieldCache.get(maps.WALK, request), cached);
  const value = runtime.transact(field => {
    field.apply([{ type: 'ADD_EFFECT', effect }]);
    field.apply([{ type: 'MOVE_UNIT', unitId: 10, position: Object.freeze([1, 0]) }]);
    return 7;
  });
  assert.equal(value, 7);
  assert.deepEqual(runtime.getUnit(10).position, [1, 0]);
  assert.deepEqual(runtime.effectsAt([0, 2]), [1]);
  assert.equal(runtime.navigationMaps.WALK.revision, 1);
  assert.equal(runtime.navigationMaps.FLY, maps.FLY);
  assert.notEqual(runtime.fieldCache.get(maps.WALK, request), cached);
});

test('core battlefield forks isolate mutable state while preserving map, field and path identity', () => {
  const runtime = flatBattlefieldRuntime();
  const h = routedEnemyHarness({ checkpoints: [coreMove(4)] });
  h.setMaps(runtime.navigationMaps);
  h.step({ moveMultiplier: 0 });
  const effect = fixedNavigationEffect(1, { type: 'MECHANISM', mechanismId: 1 }, [0, 2],
    effectDefinition('fork-crate', walkRestriction({ costFloor: 1000 })), { active: false });
  runtime.apply([
    { type: 'REGISTER_UNIT', unit: h.enemy },
    { type: 'REGISTER_MECHANISM', mechanism: battlefieldMechanism(1) },
    { type: 'ADD_EFFECT', effect },
  ]);
  const before = runtime.getUnit(1), maps = runtime.navigationMaps;
  const path = before.locomotion.mainRoute.navigation.execution.activity.path;
  const fork = runtime.fork();
  assert.equal(fork.map, runtime.map);
  assert.equal(fork.navigationMaps, maps);
  assert.equal(fork.getUnit(1).locomotion.mainRoute.navigation.execution.activity.path, path);
  assert.equal(path.field.map, maps.WALK);
  const cached = runtime.fieldCache.get(maps.WALK, path.request);
  assert.equal(fork.fieldCache.get(maps.WALK, path.request), cached);
  const updated = fork.getUnit(1);
  updated.vitality.hp = 50;
  updated.spatialPresence.present = false;
  updated.locomotion.steering.lastVelocity = Object.freeze([1, 0]);
  updated.locomotion.mainRoute.route.progress.checkpointIndex = 1;
  updated.locomotion.mainRoute.navigation.execution.visits.visitedCenters.push(Object.freeze([0, 1]));
  updated.locomotion.mainRoute.navigation.execution.activity.cursor = { type: 'GOAL' };
  fork.apply([
    { type: 'UPDATE_UNIT', unit: updated },
    { type: 'SET_MECHANISM_ACTIVE', mechanismId: 1, active: false },
    { type: 'SET_EFFECT_ACTIVE', effectId: 1, active: true },
  ]);
  assert.deepEqual(runtime.getUnit(1), before);
  assert.equal(runtime.getMechanism(1).active, true);
  assert.equal(runtime.getEffect(1).active, false);
  assert.deepEqual(runtime.unitsAt([0, 0]).map(unit => unit.id), [1]);
  assert.deepEqual(fork.unitsAt([0, 0]), []);
  assert.equal(fork.navigationMaps, maps);
  assert.equal(fork.getUnit(1).locomotion.mainRoute.navigation.execution.activity.path, path);
  updated.vitality.hp = 1;
  updated.locomotion.mainRoute.navigation.execution.visits.visitedCenters.push(Object.freeze([0, 2]));
  assert.equal(fork.getUnit(1).vitality.hp, 50);
  assert.deepEqual(fork.getUnit(1).locomotion.mainRoute.navigation.execution.visits.visitedCenters, [[0, 1]]);
  fork.apply([{ type: 'SET_MECHANISM_ACTIVE', mechanismId: 1, active: true }]);
  assert.notEqual(fork.navigationMaps.WALK, maps.WALK);
  assert.equal(fork.navigationMaps.FLY, maps.FLY);
  assert.equal(fork.getUnit(1).locomotion.mainRoute.navigation.execution.activity.type, 'NEEDS_PATH');
  assert.equal(runtime.getUnit(1).locomotion.mainRoute.navigation.execution.activity.path, path);
  assert.equal(runtime.navigationMaps, maps);
  assert.equal(path.field.map, maps.WALK);
  runtime.apply([{ type: 'MOVE_UNIT', unitId: 1, position: Object.freeze([1, 0]) }]);
  assert.deepEqual(fork.getUnit(1).position, [0, 0]);
  assert.deepEqual(runtime.getUnit(1).position, [1, 0]);
  assert.deepEqual(before.position, [0, 0]);
});

test('core battlefield shares immutable unit values internally and copies only at external boundaries', () => {
  let copies = 0;
  const runtime = createBattlefieldRuntime({ map: flatBattlefieldRuntime().map }, unit => {
    copies++;
    return copyUnitSnapshot(unit);
  });
  const h = routedEnemyHarness({ speedPerTick: 0.1, checkpoints: [coreMove(4)] });
  h.setMaps(runtime.navigationMaps);
  h.step({ moveMultiplier: 0 });
  runtime.apply([{ type: 'REGISTER_UNIT', unit: h.enemy }]);
  assert.equal(copies, 1);
  const unit = runtime.view.getUnit(1), maps = runtime.navigationMaps;
  const path = unit.locomotion.mainRoute.navigation.execution.activity.path;
  const field = runtime.fieldCache.get(maps.WALK, path.request);
  assert.notEqual(unit, h.enemy);
  assert.equal(runtime.view.getUnit(1), unit);
  assert.equal(runtime.view.unitsAt([0, 0])[0], unit);
  assert.equal(copies, 1);
  const fork = runtime.fork(), view = fork.view;
  assert.equal(view.getUnit(1), unit);
  const moved = stepRoutedEnemy(unit, {
    tick: h.tick, maps: view.navigationMaps, fieldCache: view.fieldCache,
    moveMultiplier: 1, movementAllowed: true, routeAdvanceAllowed: true, waitTickAllowed: true,
    rngState: h.rngState, nextNavigationRequestId: h.nextNavigationRequestId,
  }).enemy;
  const added = { ...moved, id: 2, position: Object.freeze([2, 0]) };
  fork.commit([{ type: 'UPDATE_UNIT', unit: moved }, { type: 'REGISTER_UNIT', unit: added }]);
  assert.equal(copies, 1);
  assert.equal(view.getUnit(1), moved);
  assert.equal(view.getUnit(2), added);
  assert.equal(view.unitsAt([0, 0])[0], moved);
  assert.equal(runtime.view.getUnit(1), unit);
  assert.equal(runtime.view.getUnit(2), undefined);
  assert.deepEqual(unit.position, [0, 0]);
  assert.equal(fork.map, runtime.map);
  assert.equal(view.navigationMaps, maps);
  assert.equal(moved.locomotion.mainRoute.navigation.execution.activity.path, path);
  assert.equal(path.field.map, maps.WALK);
  assert.equal(view.fieldCache.get(maps.WALK, path.request), field);
  assert.throws(() => fork.transact(working => {
    working.commit([{ type: 'MOVE_UNIT', unitId: 1, position: Object.freeze([3, 0]) }]);
    throw new Error('immutable commit failed');
  }), /immutable commit failed/);
  assert.equal(view.getUnit(1), moved);
  assert.equal(copies, 1);
  const snapshot = fork.getUnit(1);
  assert.equal(copies, 2);
  snapshot.vitality.hp = 50;
  fork.unitsAt([0, 0])[0].vitality.hp = 1;
  assert.equal(copies, 3);
  assert.equal(view.getUnit(1).vitality.hp, 100);
  fork.apply([{ type: 'UPDATE_UNIT', unit: snapshot }]);
  assert.equal(copies, 4);
  assert.notEqual(view.getUnit(1), snapshot);
  snapshot.vitality.hp = 0;
  assert.equal(view.getUnit(1).vitality.hp, 50);
  assert.equal(runtime.view.getUnit(1).vitality.hp, 100);
});

test('core routed movement preserves frozen input values and shares unchanged domain branches', () => {
  const h = routedEnemyHarness({ speedPerTick: 0.1, checkpoints: [coreMove(4)] });
  h.step({ moveMultiplier: 0 });
  const freeze = value => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const nested of Object.values(value)) freeze(nested);
    return Object.freeze(value);
  };
  const unit = freeze(h.enemy), before = JSON.stringify(unit);
  const moved = stepRoutedEnemy(unit, {
    tick: h.tick, maps: h.maps, fieldCache: createNavigationFieldCache(),
    moveMultiplier: 1, movementAllowed: true, routeAdvanceAllowed: true, waitTickAllowed: true,
    rngState: h.rngState, nextNavigationRequestId: h.nextNavigationRequestId,
  }).enemy;
  assert.equal(JSON.stringify(unit), before);
  assert.notEqual(moved, unit);
  assert.notDeepEqual(moved.position, unit.position);
  assert.notEqual(moved.locomotion, unit.locomotion);
  assert.equal(moved.definition, unit.definition);
  assert.equal(moved.vitality, unit.vitality);
  assert.equal(moved.spatialPresence, unit.spatialPresence);
  assert.equal(moved.locomotion.mainRoute.route, unit.locomotion.mainRoute.route);
  assert.equal(moved.locomotion.mainRoute.navigation.execution.visits,
    unit.locomotion.mainRoute.navigation.execution.visits);
  assert.equal(moved.locomotion.mainRoute.navigation.execution.activity.path,
    unit.locomotion.mainRoute.navigation.execution.activity.path);
});

test('core external unit coordinates and internal effect snapshots retain ownership isolation', () => {
  const runtime = flatBattlefieldRuntime();
  const h = routedEnemyHarness();
  h.setMaps(runtime.navigationMaps);
  h.step({ moveMultiplier: 0 });
  const position = [0, 0], velocity = [0, 0], locator = [0, 0], visited = [0, 0];
  const navigation = h.enemy.locomotion.mainRoute.navigation;
  const unit = { ...h.enemy, position, locomotion: {
    ...h.enemy.locomotion, steering: { lastVelocity: velocity },
    mainRoute: { ...h.enemy.locomotion.mainRoute, navigation: {
      ...navigation, execution: { ...navigation.execution, locatorOffset: locator,
        visits: { visitedCenters: [visited] },
      },
    } },
  } };
  runtime.apply([{ type: 'REGISTER_UNIT', unit }]);
  position[0] = 4;
  velocity[0] = 4;
  locator[0] = 4;
  visited[1] = 4;
  const stored = runtime.view.getUnit(1);
  assert.deepEqual(stored.position, [0, 0]);
  assert.deepEqual(stored.locomotion.steering.lastVelocity, [0, 0]);
  assert.deepEqual(stored.locomotion.mainRoute.navigation.execution.locatorOffset, [0, 0]);
  assert.deepEqual(stored.locomotion.mainRoute.navigation.execution.visits.visitedCenters, [[0, 0]]);
  const moved = [1, 0];
  runtime.apply([{ type: 'MOVE_UNIT', unitId: 1, position: moved }]);
  moved[0] = 4;
  assert.deepEqual(runtime.view.getUnit(1).position, [1, 0]);
  assert.deepEqual(runtime.view.unitsAt([0, 1]).map(entry => entry.id), [1]);
  const effect = {
    id: 1, source: { type: 'UNIT', unitId: 1 },
    definition: effectDefinition('owned-region', walkRestriction({ costFloor: 1000 })),
    active: true, expiresAtTick: null,
    region: { type: 'FOLLOW_UNIT', unitId: 1, range: [[0, 0]], direction: 'RIGHT' },
  };
  runtime.commit([{ type: 'ADD_EFFECT', effect }]);
  const snapshot = runtime.getEffect(1), maps = runtime.navigationMaps;
  snapshot.source.unitId = 999;
  snapshot.region.unitId = 999;
  snapshot.region.range.push([0, 1]);
  assert.throws(() => { snapshot.region.range[0][0] = 1; }, TypeError);
  assert.equal(effect.source.unitId, 1);
  assert.equal(effect.region.unitId, 1);
  assert.deepEqual(effect.region.range, [[0, 0]]);
  assert.equal(runtime.navigationMaps, maps);
  assert.deepEqual(runtime.effectsAt([0, 1]), [1]);
  const fixedPosition = [0, 2], range = [[0, 0]];
  runtime.apply([{ type: 'SET_EFFECT_REGION', effectId: 1,
    region: { type: 'FIXED', position: fixedPosition, range, direction: 'RIGHT' },
  }]);
  fixedPosition[1] = 4;
  range[0][1] = 2;
  assert.deepEqual(runtime.getEffect(1).region.position, [0, 2]);
  assert.deepEqual(runtime.getEffect(1).region.range, [[0, 0]]);
  assert.deepEqual(runtime.effectsAt([0, 2]), [1]);
});

test('core battlefield isolates custom unit state using its explicit snapshot copy', () => {
  const runtime = createBattlefieldRuntime({ map: flatBattlefieldRuntime().map }, unit => {
    const { charges, ...base } = unit;
    return { ...copyUnitSnapshot(base), charges: { ...charges, spent: [...charges.spent] } };
  });
  const unit = { ...battlefieldUnit(10, [0, 0]), charges: { remaining: 3, spent: [] } };
  runtime.apply([{ type: 'REGISTER_UNIT', unit }]);
  unit.charges.remaining = 0;
  unit.charges.spent.push(0);
  const snapshot = runtime.getUnit(10);
  assert.deepEqual(snapshot.charges, { remaining: 3, spent: [] });
  snapshot.charges.remaining = 2;
  snapshot.charges.spent.push(1);
  assert.deepEqual(runtime.getUnit(10).charges, { remaining: 3, spent: [] });
  const maps = runtime.navigationMaps;
  runtime.apply([{ type: 'UPDATE_UNIT', unit: snapshot }]);
  snapshot.charges.remaining = 0;
  snapshot.charges.spent.push(2);
  runtime.unitsAt([0, 0])[0].charges.spent.push(3);
  assert.deepEqual(runtime.getUnit(10).charges, { remaining: 2, spent: [1] });
  assert.equal(runtime.navigationMaps, maps);
  assert.throws(() => runtime.apply([
    { type: 'MOVE_UNIT', unitId: 10, position: Object.freeze([1, 0]) },
    { type: 'REGISTER_UNIT', unit },
  ]));
  assert.deepEqual(runtime.getUnit(10).position, [0, 0]);
  assert.deepEqual(runtime.getUnit(10).charges, { remaining: 2, spent: [1] });
});

test('core battlefield invalidates only changed navigation modes and preserves routed intent through rebinding', () => {
  const runtime = flatBattlefieldRuntime();
  const h = routedEnemyHarness({ speedPerTick: 1, checkpoints: [coreMove(4, { randomizeReachOffset: true, reachOffset: [0.1, 0] })], routeOverrides: {
    spawnOffset: [0.1, -0.2], visitEveryTileCenter: true,
  } });
  h.setMaps(runtime.navigationMaps);
  h.step({ moveMultiplier: 0 });
  const walker = h.enemy, oldNavigation = walker.locomotion.mainRoute.navigation;
  const request = routedEnemyRequest(walker), goal = walker.locomotion.mainRoute.route.progress.checkpoint.goal;
  const alternativeRoute = { route: walker.locomotion.mainRoute.route, navigation: oldNavigation };
  walker.locomotion.alternativeRoute = alternativeRoute;
  const flyRoute = createRouteDefinition(coreRoute({ pathMotionMode: 'FLY', startPosition: [0, 0], endPosition: [0, 4], spawnOffset: [0, 0], spawnRandomRange: [0, 0] }));
  const flyer = initializeRoutedEnemy({ id: 2, definition: walker.definition, route: flyRoute,
    timing: walker.locomotion.mainRoute.route.timing, tick: h.tick, alwaysCheckCurrentPoint: true, rngState: h.rngState, nextNavigationRequestId: h.nextNavigationRequestId }).enemy;
  const flyRequest = routedEnemyRequest(flyer);
  const flyField = runtime.fieldCache.get(runtime.navigationMaps.FLY, flyRequest);
  flyer.locomotion.mainRoute.navigation = bindNavigationPath(flyer.locomotion.mainRoute.navigation, createNavigationPath(flyRequest, flyField), flyer.position).state;
  const idle = { ...flyer, id: 3, locomotion: { ...flyer.locomotion, mainRoute: { ...flyer.locomotion.mainRoute, navigation: createNavigationState('WALK', [0, 0]) } } };
  const arrived = { ...walker, id: 4, locomotion: { ...walker.locomotion, alternativeRoute: null, mainRoute: {
    ...walker.locomotion.mainRoute, navigation: { ...oldNavigation, execution: { ...oldNavigation.execution, activity: { type: 'ARRIVED', request } } },
  } } };
  const externalMap = fieldMap(1, 5, Array.from({ length: 5 }, () => fieldCell()));
  const externalPath = createNavigationPath(request, buildNavigationField(externalMap, deriveNavigationFieldQuery(request)));
  const externalUnit = { ...walker, id: 5, locomotion: { ...walker.locomotion, alternativeRoute: null, mainRoute: {
    ...walker.locomotion.mainRoute, navigation: bindNavigationPath(oldNavigation, externalPath, walker.position).state,
  } } };
  runtime.apply([
    { type: 'REGISTER_UNIT', unit: walker }, { type: 'REGISTER_UNIT', unit: flyer },
    { type: 'REGISTER_UNIT', unit: idle }, { type: 'REGISTER_UNIT', unit: arrived },
    { type: 'REGISTER_UNIT', unit: externalUnit },
    { type: 'REGISTER_MECHANISM', mechanism: battlefieldMechanism(1) },
  ]);
  assert.equal(runtime.getUnit(5).locomotion.mainRoute.navigation.execution.activity.type, 'NEEDS_PATH');
  assert.equal(routedEnemyRequest(runtime.getUnit(5)), request);
  assert.equal(externalUnit.locomotion.mainRoute.navigation.execution.activity.path, externalPath);
  const oldMaps = runtime.navigationMaps;
  const oldPath = runtime.getUnit(1).locomotion.mainRoute.navigation.execution.activity.path;
  const memo = runtime.fieldCache.get(oldMaps.WALK, request);
  const hpUpdate = runtime.getUnit(1);
  hpUpdate.vitality.hp = 90;
  assert.deepEqual(runtime.apply([{ type: 'UPDATE_UNIT', unit: hpUpdate }]).changedNavigationModes, []);
  assert.equal(runtime.navigationMaps, oldMaps);
  assert.equal(runtime.getUnit(1).locomotion.mainRoute.navigation.execution.activity.path, oldPath);
  assert.equal(runtime.fieldCache.get(oldMaps.WALK, request), memo);
  runtime.fieldCache.clear();
  assert.equal(runtime.navigationMaps, oldMaps);
  assert.equal(runtime.getUnit(1).locomotion.mainRoute.navigation.execution.activity.path, oldPath);
  assert.notEqual(runtime.fieldCache.get(oldMaps.WALK, request), memo);
  const flyMemo = runtime.fieldCache.get(oldMaps.FLY, flyRequest);
  const change = runtime.apply([{ type: 'ADD_EFFECT', effect: fixedNavigationEffect(1, { type: 'MECHANISM', mechanismId: 1 }, [0, 2],
    effectDefinition('dynamic-crate', walkRestriction({ costFloor: 1000 }))) }]);
  assert.deepEqual(change.changedNavigationModes, ['WALK']);
  assert.equal(runtime.navigationMaps.FLY, oldMaps.FLY);
  assert.equal(runtime.fieldCache.get(runtime.navigationMaps.FLY, flyRequest), flyMemo);
  assert.equal(runtime.getUnit(2).locomotion.mainRoute.navigation.execution.activity.path.field, flyField);
  assert.equal(runtime.getUnit(3).locomotion.mainRoute.navigation.execution.activity.type, 'IDLE');
  assert.equal(runtime.getUnit(4).locomotion.mainRoute.navigation.execution.activity.type, 'ARRIVED');
  const changedMaps = runtime.navigationMaps;
  const changedField = runtime.fieldCache.get(changedMaps.WALK, request);
  hpUpdate.vitality.hp = 80;
  assert.deepEqual(runtime.apply([{ type: 'UPDATE_UNIT', unit: hpUpdate }]).changedNavigationModes, []);
  assert.equal(runtime.navigationMaps, changedMaps);
  assert.equal(runtime.fieldCache.get(changedMaps.WALK, request), changedField);
  assert.equal(hpUpdate.locomotion.mainRoute.navigation.execution.activity.path, oldPath);
  const pending = runtime.getUnit(1);
  assert.equal(pending.vitality.hp, 80);
  for (const control of [pending.locomotion.mainRoute, pending.locomotion.alternativeRoute]) {
    assert.equal(control.navigation.execution.activity.type, 'NEEDS_PATH');
    assert.equal(control.navigation.execution.activity.request, request);
    assert.equal(control.navigation.execution.activity.request.goal, goal);
    assert.deepEqual(control.navigation.execution.visits, oldNavigation.execution.visits);
    assert.equal(control.navigation.execution.locatorOffset, oldNavigation.execution.locatorOffset);
  }
  assert.equal(oldPath.field.map, oldMaps.WALK);
  assert.equal(oldMaps.WALK.cells[2].moveCost, 1);
  pending.locomotion.alternativeRoute = null;
  const context = {
    tick: h.tick,
    maps: runtime.navigationMaps, fieldCache: runtime.fieldCache,
    moveMultiplier: 0, movementAllowed: true, waitTickAllowed: true, routeAdvanceAllowed: true,
    rngState: h.rngState, nextNavigationRequestId: h.nextNavigationRequestId,
  };
  const stepped = stepRoutedEnemy(pending, context);
  runtime.apply([{ type: 'UPDATE_UNIT', unit: stepped.enemy }]);
  const rebound = runtime.getUnit(1);
  assert.equal(rebound.locomotion.mainRoute.navigation.execution.activity.path.field.map, runtime.navigationMaps.WALK);
  assert.equal(routedEnemyRequest(rebound), request);
  assert.equal(rebound.locomotion.mainRoute.route.progress.checkpoint.goal, goal);
  assert.equal(rebound.vitality.hp, 80);
  assert.equal(stepped.rngState, h.rngState);
  assert.equal(stepped.nextNavigationRequestId, h.nextNavigationRequestId);
  runtime.apply([{ type: 'ADD_EFFECT', effect: fixedNavigationEffect(2, { type: 'MECHANISM', mechanismId: 1 }, [0, 2],
    effectDefinition('dynamic-wall', walkRestriction({ denyPassage: true }))) }]);
  const failed = stepRoutedEnemy(runtime.getUnit(1), { ...context, tick: context.tick + 1, maps: runtime.navigationMaps });
  assert.equal(failed.enemy.locomotion.mainRoute.navigation.execution.activity.type, 'UNREACHABLE');
  runtime.apply([{ type: 'UPDATE_UNIT', unit: failed.enemy }]);
  runtime.apply([{ type: 'REMOVE_EFFECT', effectId: 2 }]);
  const retry = runtime.getUnit(1).locomotion.mainRoute.navigation;
  assert.equal(retry.execution.activity.type, 'NEEDS_PATH');
  assert.equal(retry.execution.activity.request, request);
  assert.equal(retry.execution.activity.request.goal, goal);
  assert.deepEqual(retry.execution.visits, oldNavigation.execution.visits);
});

test('a pushed ground enemy re-plans from its tile centre: never cuts a fence corner or breaks the stage crate on it (act1 m03, tile 11,5)', REAL, () => {
  // Regression: after Battle.displace() the enemy steered straight from its off-centre position to next[tile], cut
  // the corner of the FLY-only fence tile (11,5), got blocked by the decorative crate standing there and broke it.
  const cases = [[12.57, { x: -1, y: 0.2 }], [11, { x: -1, y: -1 }], [13, { x: -1, y: 1 }]];
  for (const [at, dir] of cases) {
    const h = makeBattle({
      stageId: 'act1autochess_m03', routes: [{ motion: 'WALK', start: [12, 10], end: [9, 2], checkpoints: [] }],
      enemies: [{ key: 'enemy_1267_nhpbr', route: 0 }], units: [], timeLimit: 120,
    });
    const b = h.b;
    h.run(at);
    const e = b.enemies[0];
    const crate = b.units.find((u) => u.defId === 'trap_1105_accrate' && u.tileR === 11 && u.tileC === 5);
    assert.ok(e && crate && crate.alive, 'enemy walking, crate on (11,5)');
    assert.ok(b.displace(e, dir, 0.5, { force: 3 }) > 0, 'pushed');
    const ver = b.grid.version;
    const off = [];
    while (e.alive && !b.finished) {
      b.step();
      const r = Math.round(e.y), c = Math.round(e.x);
      if (e.alive && !b.grid.walkable(r, c, true)) off.push(`${b.time.toFixed(2)}@${r},${c}`);
      assert.notEqual(e.blockedBy, crate, `t=${at}: blocked by the fence crate`);
    }
    assert.deepEqual(off, [], `t=${at} push ${JSON.stringify(dir)}: stood on a tile it cannot walk`);
    assert.ok(crate.alive, 'the stage crate survives');
    assert.equal(b.grid.version, ver, 'no obstacle change');
    assert.equal(h.result().perPlayer.p1.leaked.length, 1, 'still reaches the goal');
  }
});

const coreGround = (overrides = {}) => ({
  heightType: 'LOWLAND', buildableType: 'MELEE', passableMask: 'ALL', playerSideMask: 'ALL',
  terrain: 'NORMAL', mechanism: null, ...overrides,
});
const coreRequest = (overrides = {}) => ({
  id: 1, targetTile: [0, 2], goal: { position: [2.2, 0], reachDistance: 0.05 },
  options: { allowDiagonalMove: true, visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryNodeStably: false },
  arrivalRule: 'DISTANCE', ...overrides,
});
const coreRoute = (overrides = {}) => ({
  pathMotionMode: 'WALK', startPosition: [3, 4], endPosition: [0, 0], spawnOffset: [0.1, -0.2],
  spawnRandomRange: [0.5, 1], checkpoints: [], allowDiagonalMove: true,
  visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true, ...overrides,
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
  assert.throws(() => createTile(coreGround({ passableMask: 'E_NUM' })), TypeError);
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
  assert.deepEqual(walk.cells.map(cell => cell.moveCost), [1, 1_000_000, 1, 1]);
  assert.deepEqual(fly.cells.map(cell => cell.moveCost), [1, 1, 1, 1]);
  assert.deepEqual(walk.cells.map(cell => cell.passable), [true, true, true, false]);
  assert.deepEqual(fly.cells.map(cell => cell.passable), [false, true, true, true]);
  assert.equal(NavigationMap.canDepart(walk, [0, 1], 'RIGHT'), false);
  assert.equal(NavigationMap.canDepart(walk, [0, 2], 'LEFT'), false);
  assert.equal(NavigationMap.canDepart(fly, [0, 1], 'RIGHT'), true);
  assert.deepEqual(distances(buildRawNavigationField(walk, fieldQuery([0, 2]))), [-1, -1, 0, -1]);
  assert.deepEqual(distances(buildNavigationField(walk, fieldQuery([0, 1]))), [1, 0, -1, -1]);
  assert.deepEqual(distances(buildNavigationField(fly, fieldQuery([0, 3]))), [-1, 2, 1, 0]);
  assert.equal(walk.cells[0].departures.LEFT, false);
  assert.equal(NavigationMap.canDepart(walk, [0, 0], 'UP'), true);
  assert.ok(Object.isFrozen(walk.cells[0].departures));
});

test('core navigation rejects malformed costs and preserves raw distance semantics in shared fields', () => {
  const cell = (moveCost) => ({ passable: true, moveCost, departures: { UP: true, RIGHT: true, DOWN: true, LEFT: true } });
  const input = { rows: 1, columns: 3, pathMotionMode: 'WALK', revision: 0, cells: [cell(4), cell(1), cell(1)] };
  const map = createNavigationMap(input);
  input.cells[0].moveCost = 99;
  assert.equal(map.cells[0].moveCost, 4);
  assert.throws(() => createNavigationMap({ ...input, cells: [cell(0), cell(1), cell(1)] }), RangeError);
  assert.throws(() => createNavigationMap({ ...input, cells: [cell(Infinity), cell(1), cell(1)] }), RangeError);
  assert.throws(() => createNavigationMap({ ...input, pathMotionMode: 'FLY' }), RangeError);
  assert.throws(() => createNavigationMap({ ...input, cells: [cell(1), , cell(1)] }), RangeError);
  const request = createNavigationRequest(coreRequest());
  const query = deriveNavigationFieldQuery(request);
  const field = buildNavigationField(map, query);
  const path = createNavigationPath(request, field);
  assert.equal(field.map, map);
  assert.equal(path.request, request);
  assert.equal(path.field, field);
  assert.ok(Object.isFrozen(path));
  assert.deepEqual(field.nodes[0].next, [0, 2]);
  assert.equal(field.nodes[0].distance, 5);
  assert.throws(() => createNavigationPath(createNavigationRequest(coreRequest({ targetTile: [0, 1] })), field), /does not match/);
  assert.throws(() => createNavigationPath(createNavigationRequest(coreRequest({
    options: { ...request.options, allowDiagonalMove: false },
  })), field), /does not match/);
});

test('core requests snapshot effective options without quantizing the continuous goal', () => {
  const input = coreRequest();
  const request = createNavigationRequest(input);
  input.options.allowDiagonalMove = false;
  input.goal.position[0] = 9;
  assert.equal(request.options.allowDiagonalMove, true);
  assert.deepEqual(request.goal.position, [2.2, 0]);
  assert.deepEqual(request.targetTile, [0, 2]);
  assert.throws(() => createNavigationRequest(coreRequest({ targetTile: [0, 2, 3] })), RangeError);
  assert.throws(() => createNavigationRequest(coreRequest({ targetTile: [0, 0.5] })), RangeError);
  assert.throws(() => createNavigationRequest(coreRequest({ options: {
    visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryNodeStably: false,
  } })), TypeError);
  assert.throws(() => createNavigationRequest(coreRequest({ goal: { position: [2, 0], reachDistance: -1 } })), RangeError);
  const offset = [0.3, -0.4];
  const state = createNavigationState('FLY', offset);
  offset[0] = 2;
  assert.deepEqual(state.execution.locatorOffset, [0.3, -0.4]);
  assert.equal(state.execution.activity.type, 'IDLE');
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

test('route birth resolution consumes x then y exactly once even for zero ranges', () => {
  let calls = 0;
  const definition = createRouteDefinition(coreRoute());
  const before = JSON.stringify(definition);
  const spawn = initializeRouteSpawn(definition, { next: () => [0.25, 0.75][calls++] });
  approx(spawn.position[0], 3.85, 'spawn x');
  approx(spawn.position[1], 3.3, 'spawn y');
  approx(spawn.locatorOffset[0], 0.15, 'locator x');
  approx(spawn.locatorOffset[1], -0.3, 'locator y');
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(definition), before);
  assert.ok(Object.isFrozen(spawn) && Object.isFrozen(spawn.position) && Object.isFrozen(spawn.locatorOffset));
  calls = 0;
  const exact = initializeRouteSpawn(createRouteDefinition(coreRoute({ spawnOffset: [0, 0], spawnRandomRange: [0, 0] })), { next: () => { calls++; return 0.5; } });
  assert.equal(calls, 2);
  assert.deepEqual(exact, { position: [4, 3], locatorOffset: [0, 0] });
  calls = 0;
  assert.throws(() => initializeRouteSpawn(createRouteDefinition(coreRoute({ spawnRandomRange: [Number.MAX_VALUE, 0] })), { next: () => { calls++; return 0; } }), RangeError);
  assert.equal(calls, 0);
});

test('route constructors keep tick timing explicit, snapshots isolated and progress local to each instance', () => {
  const input = coreRoute({ checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: 3 }] });
  const definition = createRouteDefinition(input);
  input.checkpoints[0].durationTicks = 9;
  assert.equal(definition.checkpoints[0].durationTicks, 3);
  const timing = createRouteTiming({ waveStartedAtTick: 10, fragmentStartedAtTick: 12 });
  const a = createRouteState(definition, timing, false), b = createRouteState(definition, timing, true);
  a.progress.checkpointIndex = 1;
  assert.equal(b.progress.checkpointIndex, 0);
  assert.equal(a.definition, definition);
  assert.equal(b.definition, definition);
  assert.equal(a.timing, timing);
  assert.equal(b.timing, timing);
  assert.ok(Object.isFrozen(definition) && Object.isFrozen(definition.checkpoints) && Object.isFrozen(timing));
  assert.throws(() => createRouteState(definition, timing), TypeError);
  assert.throws(() => createRouteTiming({ waveStartedAtTick: 0, fragmentStartedAtTick: NaN }), RangeError);
  assert.throws(() => createRouteTiming({ waveStartedAtTick: -1, fragmentStartedAtTick: 0 }), RangeError);
  assert.throws(() => createRouteTiming({ waveStartedAtTick: 0, fragmentStartedAtTick: 0.5 }), RangeError);
  assert.throws(() => createRouteDefinition(coreRoute({ checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: -1 }] })), RangeError);
  assert.throws(() => createRouteDefinition(coreRoute({ checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: 0.5 }] })), RangeError);
  assert.throws(() => createRouteDefinition(coreRoute({ checkpoints: [,] })), TypeError);
  assert.throws(() => createRouteDefinition(coreRoute({ startPosition: [0, 0, 1] })), TypeError);
  assert.throws(() => createRouteDefinition(coreRoute({ spawnOffset: [0, Infinity] })), TypeError);
});

test('core route waits bind absolute deadlines to explicit play ticks and birth timing', () => {
  const timing = createRouteTiming({ waveStartedAtTick: 40, fragmentStartedAtTick: 80 });
  for (const checkpoint of [
    { type: 'WAIT_FOR_PLAY_TICK', targetPlayTick: 110 },
    { type: 'WAIT_CURRENT_WAVE_TICKS', targetElapsedTicks: 70 },
    { type: 'WAIT_CURRENT_FRAGMENT_TICKS', targetElapsedTicks: 30 },
  ]) {
    const definition = createRouteDefinition(coreRoute({ checkpoints: [checkpoint] }));
    const state = createRouteState(definition, timing, true);
    const execution = createRouteExecution(createRng(42), 0, 100);
    const entered = enterRoute(state, execution);
    assert.deepEqual(state.progress.checkpoint, { type: 'NOT_ENTERED' });
    assert.deepEqual(entered.state.progress.checkpoint, { type: 'WAIT', remainingTicks: 10 });
    assert.equal(entered.request, undefined);
    assert.equal(entered.state.timing, timing);
    assert.equal(enterRoute(entered.state, execution).state, entered.state);
    const refreshed = tickRouteWait(entered.state, 105);
    assert.deepEqual(refreshed.progress.checkpoint, { type: 'WAIT', remainingTicks: 5 });
    assert.equal(tickRouteWait(refreshed, 105), refreshed);
    const expired = tickRouteWait(refreshed, 110);
    assert.deepEqual(expired.progress.checkpoint, { type: 'WAIT', remainingTicks: 0 });
    assert.equal(expired.progress.checkpointIndex, 0);
    assert.equal(expired.timing, timing);
    assert.equal(tickRouteWait(expired, 111), expired);
    const alreadyDue = enterRoute(state, createRouteExecution(createRng(42), 0, 120));
    assert.deepEqual(alreadyDue.state.progress.checkpoint, { type: 'WAIT', remainingTicks: 0 });
    assert.deepEqual(execution.state(), { rngState: 42, nextNavigationRequestId: 0 });
  }
  const relative = enterRoute(createRouteState(createRouteDefinition(coreRoute({
    checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: 7 }],
  })), timing, true), createRouteExecution(createRng(42), 0, 100)).state;
  assert.deepEqual(tickRouteWait(relative, 105).progress.checkpoint, { type: 'WAIT', remainingTicks: 6 });
  assert.deepEqual(relative.progress.checkpoint, { type: 'WAIT', remainingTicks: 7 });
});

test('core route absolute waits reject overflow in derived wave and fragment deadlines', () => {
  const timing = createRouteTiming({ waveStartedAtTick: Number.MAX_SAFE_INTEGER, fragmentStartedAtTick: Number.MAX_SAFE_INTEGER });
  for (const type of ['WAIT_CURRENT_WAVE_TICKS', 'WAIT_CURRENT_FRAGMENT_TICKS']) {
    const definition = createRouteDefinition(coreRoute({ checkpoints: [{ type, targetElapsedTicks: 1 }] }));
    const state = createRouteState(definition, timing, true);
    assert.throws(() => enterRoute(state, createRouteExecution(createRng(42), 0, 0)), /target tick overflow/);
    assert.deepEqual(state.progress.checkpoint, { type: 'NOT_ENTERED' });
    state.progress.checkpoint = { type: 'WAIT', remainingTicks: 1 };
    assert.throws(() => tickRouteWait(state, 0), /target tick overflow/);
    assert.deepEqual(state.progress.checkpoint, { type: 'WAIT', remainingTicks: 1 });
  }
});

test('core routed waits distinguish ticking permission from route advancement and movement', () => {
  const relative = routedEnemyHarness({ checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: 3 }] });
  relative.step({ movementAllowed: false, waitTickAllowed: false });
  assert.equal(relative.enemy.locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 3);
  relative.step({ movementAllowed: false, routeAdvanceAllowed: false });
  assert.equal(relative.enemy.locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 2);
  relative.step({ movementAllowed: false, routeAdvanceAllowed: false });
  relative.step({ movementAllowed: false, routeAdvanceAllowed: false });
  assert.equal(relative.enemy.locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 0);
  assert.equal(relative.enemy.locomotion.mainRoute.route.progress.phase, 'CHECKPOINTS');
  relative.step({ movementAllowed: false, waitTickAllowed: false });
  assert.equal(relative.enemy.locomotion.mainRoute.route.progress.phase, 'END');

  const absolute = routedEnemyHarness({ initialTick: 100, timing: { waveStartedAtTick: 40, fragmentStartedAtTick: 80 },
    checkpoints: [{ type: 'WAIT_CURRENT_FRAGMENT_TICKS', targetElapsedTicks: 22 }],
  });
  absolute.step({ movementAllowed: false, waitTickAllowed: false });
  absolute.step({ movementAllowed: false, waitTickAllowed: false });
  assert.equal(absolute.enemy.locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 2);
  absolute.step({ movementAllowed: false, routeAdvanceAllowed: false });
  assert.equal(absolute.enemy.locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 0);
  assert.equal(absolute.enemy.locomotion.mainRoute.route.progress.checkpointIndex, 0);
  absolute.step({ movementAllowed: false });
  assert.equal(absolute.enemy.locomotion.mainRoute.route.progress.phase, 'END');
  assert.deepEqual(absolute.enemy.position, [0, 0]);
});

test('core patrol successors loop only at a patrol tail with a preceding non-MOVE segment', () => {
  const route = types => createRouteDefinition(coreRoute({ checkpoints: types.map(type => {
    if (type === 'WAIT_FOR_TICKS') return { type, durationTicks: 1 };
    if (type === 'ALERT' || type === 'DISAPPEAR') return { type };
    return { ...coreMove(1), type };
  }) }));
  for (const [types, index, expected] of [
    [['PATROL_MOVE'], 0, 1],
    [['MOVE', 'PATROL_MOVE'], 1, 2],
    [['PATROL_MOVE', 'WAIT_FOR_TICKS'], 0, 1],
    [['PATROL_MOVE', 'WAIT_FOR_TICKS'], 1, 2],
    [['WAIT_FOR_TICKS', 'PATROL_MOVE', 'MOVE'], 1, 0],
    [['MOVE', 'WAIT_FOR_TICKS', 'MAP_OFFSET_MOVE', 'PATROL_MOVE', 'MOVE'], 3, 1],
    [['ALERT', 'DISAPPEAR', 'PATROL_MOVE'], 2, 0],
    [['PATROL_MOVE', 'PATROL_MOVE', 'PATROL_MOVE'], 2, 0],
  ]) {
    const definition = route(types), before = JSON.stringify(definition);
    assert.equal(nextCheckpointIndex(definition, index), expected);
    assert.equal(JSON.stringify(definition), before);
  }
});

test('core MAP_OFFSET_MOVE adds fixed reach offset while MOVE and PATROL randomization replaces it', () => {
  for (const type of ['MOVE', 'PATROL_MOVE', 'MAP_OFFSET_MOVE']) {
    for (const randomizeReachOffset of [false, true]) {
      const checkpoint = { ...coreMove(2, { reachOffset: [0.25, 0], randomizeReachOffset }), type };
      const definition = createRouteDefinition(coreRoute({ checkpoints: [checkpoint] }));
      const rng = createRng(42), expectedRng = createRng(42);
      let calls = 0;
      const execution = createRouteExecution({ ...rng, next() { calls++; return rng.next(); } }, 7, 0);
      const entered = enterRoute(createRouteState(definition, createRouteTiming({ waveStartedAtTick: 0, fragmentStartedAtTick: 0 }), true), execution);
      let x = 0.25;
      if (randomizeReachOffset) {
        x = -0.25 + expectedRng.next() * 0.5 + (type === 'MAP_OFFSET_MOVE' ? 0.25 : 0);
        expectedRng.next();
      }
      assert.deepEqual(entered.request.goal.position, [2 + x, 0]);
      assert.equal(entered.request.id, 7);
      assert.equal(entered.state.progress.checkpoint.goal, entered.request.goal);
      assert.equal(calls, randomizeReachOffset ? 2 : 0);
      assert.deepEqual(execution.state(), { rngState: expectedRng.state(), nextNavigationRequestId: 8 });
      assert.equal(enterRoute(entered.state, execution).state, entered.state);
      assert.equal(calls, randomizeReachOffset ? 2 : 0);
    }
  }
});

test('core patrol reentry creates a new goal and request while pure successor queries preserve RNG and restart budget', () => {
  const definition = createRouteDefinition(coreRoute({ checkpoints: [
    { ...coreMove(1, { randomizeReachOffset: true, reachOffset: [0.2, 0.1] }), type: 'PATROL_MOVE' },
    { ...coreMove(2), type: 'PATROL_MOVE' },
  ] }));
  const execution = createRouteExecution(createRng(42), 0, 0), expected = createRng(42);
  const firstX = -0.2 + expected.next() * 0.4, firstY = -0.1 + expected.next() * 0.2;
  let state = enterRoute(createRouteState(definition, createRouteTiming({ waveStartedAtTick: 0, fragmentStartedAtTick: 0 }), true), execution).state;
  const firstGoal = state.progress.checkpoint.goal;
  assert.deepEqual(firstGoal.position, [1 + firstX, firstY]);
  state = advanceRoute(state, execution).state;
  assert.equal(state.progress.checkpointIndex, 1);
  assert.equal(state.progress.checkpoint.navigationRequestId, 1);
  const before = execution.state();
  for (let query = 0; query < 1000; query++) assert.equal(nextCheckpointIndex(definition, 1), 0);
  assert.deepEqual(execution.state(), before);
  const secondX = -0.2 + expected.next() * 0.4, secondY = -0.1 + expected.next() * 0.2;
  state = advanceRoute(state, execution).state;
  assert.equal(state.progress.checkpointIndex, 0);
  assert.equal(state.progress.checkpoint.navigationRequestId, 2);
  assert.notEqual(state.progress.checkpoint.goal, firstGoal);
  assert.deepEqual(state.progress.checkpoint.goal.position, [1 + secondX, secondY]);
  assert.equal(execution.state().rngState, expected.state());
  for (let restart = 1; restart < 51; restart++) {
    state = advanceRoute(advanceRoute(state, execution).state, execution).state;
    assert.equal(state.progress.checkpointIndex, 0);
  }
  const nextFrame = createRouteExecution(createRng(execution.state().rngState), execution.state().nextNavigationRequestId, 1);
  const restarted = advanceRoute(advanceRoute(state, nextFrame).state, nextFrame);
  assert.equal(restarted.state.progress.checkpointIndex, 0);
  state = advanceRoute(advanceRoute(state, execution).state, execution).state;
  assert.equal(state.progress.phase, 'END');
  assert.equal(execution.state().nextNavigationRequestId, 105);
});

test('core routed patrol and MAP_OFFSET_MOVE remain active through tick movement without reentering on replanning', () => {
  const patrol = routedEnemyHarness({ checkpoints: [
    { ...coreMove(1), type: 'PATROL_MOVE' }, { ...coreMove(2), type: 'PATROL_MOVE' },
  ] });
  patrol.step();
  assert.deepEqual(patrol.enemy.position, [1, 0]);
  assert.equal(patrol.enemy.locomotion.mainRoute.route.progress.checkpointIndex, 1);
  patrol.step();
  assert.deepEqual(patrol.enemy.position, [2, 0]);
  assert.equal(patrol.enemy.locomotion.mainRoute.route.progress.checkpointIndex, 0);
  assert.equal(patrol.nextNavigationRequestId, 3);
  patrol.step();
  assert.deepEqual(patrol.enemy.position, [1, 0]);
  assert.equal(patrol.enemy.locomotion.mainRoute.route.progress.phase, 'CHECKPOINTS');
  const offset = routedEnemyHarness({ checkpoints: [
    { ...coreMove(2, { reachOffset: [0.25, 0], randomizeReachOffset: true }), type: 'MAP_OFFSET_MOVE' },
  ], routeOverrides: { spawnOffset: [0.1, 0] } });
  const goal = offset.enemy.locomotion.mainRoute.route.progress.checkpoint.goal;
  const saved = offset.rngState;
  offset.setMotionMode('FLY');
  offset.step({ moveMultiplier: 0 });
  assert.equal(offset.enemy.locomotion.mainRoute.route.progress.checkpoint.goal, goal);
  assert.equal(offset.rngState, saved);
  assert.deepEqual(offset.enemy.locomotion.mainRoute.navigation.execution.locatorOffset, [-0.1, 0]);
  offset.step();
  approx(offset.enemy.position[0], goal.position[0] + 0.1, 'MAP_OFFSET world x');
  assert.equal(offset.enemy.locomotion.mainRoute.route.progress.phase, 'END');
});

test('raw routes preserve APPEAR fixed offsets and reject mode-specific or unknown instructions', () => {
  const raw = {
    motionMode: 'WALK', startPosition: { row: 3, col: 4 }, endPosition: { row: 0, col: 0 },
    spawnOffset: { x: 0, y: 0 }, spawnRandomRange: { x: 0, y: 0 },
    allowDiagonalMove: true, visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true,
    checkpoints: [{ type: 'APPEAR_AT_POS', position: { row: 1, col: 2 }, reachOffset: { x: 0.1, y: -0.2 }, randomizeReachOffset: true }],
  };
  const definition = parseRouteDefinition(raw);
  assert.deepEqual(definition.checkpoints[0], { type: 'APPEAR_AT_POS', position: [1, 2], reachOffset: [0.1, -0.2] });
  assert.deepEqual(parseRouteDefinition({ ...raw, checkpoints: [{ type: 'WAIT_FOR_SECONDS', time: -1 }] }).checkpoints[0], { type: 'WAIT_FOR_TICKS', durationTicks: 0 });
  assert.deepEqual(parseRouteDefinition({ ...raw, checkpoints: [{ type: 'WAIT_FOR_SECONDS', time: 0.15 }] }).checkpoints[0], { type: 'WAIT_FOR_TICKS', durationTicks: 5 });
  assert.throws(() => parseRouteDefinition({ ...raw, motionMode: 'E_NUM' }), /motion mode/);
  assert.throws(() => parseRouteDefinition({ ...raw, checkpoints: [{ type: 'WAIT_BOSSRUSH_WAVE', time: 1 }] }), /checkpoint type/);
  assert.throws(() => parseRouteDefinition({ ...raw, checkpoints: [{ type: 'INVALID' }] }), /checkpoint type/);
  assert.throws(() => parseRouteDefinition({ ...raw, unknownRule: true }), /unsupported field/);
});


test('core route instants enter once and emit fixed APPEAR without consuming RNG or request identities', () => {
  const route = createRouteDefinition(coreRoute({ checkpoints: [
    { type: 'DISAPPEAR' }, { type: 'APPEAR_AT_POS', position: [2, 3], reachOffset: [0.2, -0.3] },
    { type: 'ALERT' },
  ] }));
  const execution = createRouteExecution(createRng(41), 9, 0);
  const initial = createRouteState(route, createRouteTiming({ waveStartedAtTick: 0, fragmentStartedAtTick: 0 }), true);
  const hidden = enterRoute(initial, execution);
  assert.deepEqual(hidden.signals, [{ type: 'DISAPPEAR' }]);
  assert.equal(hidden.state.progress.checkpoint.type, 'ENTERED');
  const repeated = enterRoute(hidden.state, execution);
  assert.equal(repeated.state, hidden.state);
  assert.deepEqual(repeated.signals, []);
  const appeared = advanceRoute(hidden.state, execution);
  assert.deepEqual(appeared.signals, [{ type: 'APPEAR_AT_POS', position: [3.2, 1.7] }]);
  assert.deepEqual(advanceRoute(appeared.state, execution).signals, [{ type: 'ALERT' }]);
  assert.deepEqual(execution.state(), { rngState: 41, nextNavigationRequestId: 9 });
  assert.equal(initial.progress.checkpoint.type, 'NOT_ENTERED');
});

test('core route lookahead crosses controls without entering, sampling or assigning identities', () => {
  for (const type of ['MOVE', 'PATROL_MOVE', 'MAP_OFFSET_MOVE']) {
    const route = createRouteDefinition(coreRoute({ checkpoints: [
      { type: 'WAIT_FOR_TICKS', durationTicks: 3 }, { type: 'DISAPPEAR' },
      { type: 'APPEAR_AT_POS', position: [1, 0], reachOffset: [0, 0] }, { type: 'ALERT' },
      { type, target: { position: [0, 2], reachOffset: [0.2, -0.1], randomizeReachOffset: true, reachDistance: 0 } },
    ] }));
    const execution = createRouteExecution(createRng(73), 5, 0);
    const state = enterRoute(createRouteState(route,
      createRouteTiming({ waveStartedAtTick: 0, fragmentStartedAtTick: 0 }), true), execution).state;
    const before = structuredClone(state);
    for (let repeat = 0; repeat < 3; repeat++) {
      assert.deepEqual(predictRouteTarget(state), {
        type: 'CHECKPOINT_TARGET', checkpointIndex: 4, targetTile: [0, 2],
        goal: { position: type === 'MAP_OFFSET_MOVE' ? [2.2, -0.1] : [2, 0], reachDistance: 0.05 },
      });
    }
    assert.deepEqual(execution.state(), { rngState: 73, nextNavigationRequestId: 5 });
    assert.deepEqual(state, before);
    let entered = state;
    for (let i = 0; i < 4; i++) entered = advanceRoute(entered, execution).state;
    assert.equal(predictRouteTarget(entered).goal, entered.progress.checkpoint.goal);
    assert.equal(execution.state().nextNavigationRequestId, 6);
  }
});

test('core wait previews keep navigation cursor history without creating a second move request', () => {
  const h = routedEnemyHarness({ speedPerTick: 0.1, checkpoints: [
    { type: 'WAIT_FOR_TICKS', durationTicks: 10 }, coreMove(3, { reachOffset: [0.2, 0] }),
  ], routeOverrides: { visitEveryNodeCenter: true } });
  const seed = h.rngState;
  h.step();
  const first = h.enemy.locomotion.mainRoute.navigation;
  assert.equal(first.execution.activity.type, 'PREVIEWING');
  assert.equal(first.execution.activity.path.request.id, undefined);
  assert.ok(Object.isFrozen(first.execution.activity.path.request));
  assert.ok(Object.isFrozen(first.execution.activity.path.request.goal));
  assert.ok(Object.isFrozen(first.execution.activity.path.request.options));
  assert.deepEqual(first.execution.activity.path.request.goal.position, [3, 0]);
  assert.equal(h.nextNavigationRequestId, 0);
  assert.deepEqual(h.enemy.position, [0, 0]);
  const snapshot = copyUnitSnapshot(h.enemy);
  const previousCursor = structuredClone(first.execution.activity.cursor);
  snapshot.locomotion.mainRoute.navigation.execution.activity.cursor.type = 'FIELD';
  snapshot.locomotion.mainRoute.navigation.execution.activity.cursor.nextNode = [0, 4];
  snapshot.locomotion.mainRoute.navigation.execution.visits.visitedCenters.push([0, 4]);
  assert.deepEqual(first.execution.activity.cursor, previousCursor);
  assert.equal(first.execution.visits.visitedCenters.some(tile => tile[1] === 4), false);
  h.step();
  assert.equal(h.enemy.locomotion.mainRoute.navigation.execution.activity.path, first.execution.activity.path);
  assert.equal(h.nextNavigationRequestId, 0);
  assert.equal(h.rngState, seed);
  h.setMotionMode('FLY');
  assert.equal(h.enemy.locomotion.mainRoute.navigation.execution.activity.type, 'IDLE');
  h.step();
  assert.equal(h.enemy.locomotion.mainRoute.navigation.execution.activity.path.field.map, h.maps.FLY);
  assert.equal(h.nextNavigationRequestId, 0);
});

test('core zero wait advances in the heading phase while a live wait damps previous velocity', () => {
  const zero = routedEnemyHarness({ speedPerTick: 0.1,
    checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: 0 }, coreMove(3)] });
  zero.step();
  assert.equal(zero.enemy.locomotion.mainRoute.route.progress.checkpointIndex, 1);
  assert.deepEqual(zero.enemy.position, [0.1, 0]);
  const wait = routedEnemyHarness({ speedPerTick: 0.1,
    checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: 3 }, coreMove(3)] });
  wait.enemy.locomotion.steering.lastVelocity = [0.1, 0];
  wait.enemy.definition = createEnemyDefinition({ ...wait.enemy.definition,
    locomotion: { ...wait.enemy.definition.locomotion,
      steeringParameters: createSteeringParameters({ steeringFactor: 0.25, maxSteeringForce: 1 }) } });
  wait.step();
  assert.ok(Math.abs(wait.enemy.position[0] - 0.075) < 1e-12);
  assert.ok(Math.abs(wait.enemy.locomotion.steering.lastVelocity[0] - 0.075) < 1e-12);
  assert.deepEqual(wait.enemy.locomotion.mainRoute.route.progress.checkpoint, { type: 'WAIT', remainingTicks: 2 });
});

test('core checkpoint spatial skipping is independent of geometric arrival and cannot skip END', () => {
  for (const outside of [false, true]) {
    for (const alwaysCheckCurrentPoint of [false, true]) {
      const h = routedEnemyHarness({ alwaysCheckCurrentPoint, speedPerTick: 0,
        checkpoints: [coreMove(2), { type: 'WAIT_FOR_TICKS', durationTicks: 2 }] });
      if (outside) h.displace([-2, 0]);
      else h.setMaps({ ...h.maps, WALK: fieldMap(1, 5,
        Array.from({ length: 5 }, (_, index) => fieldCell({ passable: index !== 2 }))) });
      const step = h.step();
      assert.equal(step.outcomes.some(outcome => outcome.type === 'ARRIVED'), false);
      assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpointIndex, alwaysCheckCurrentPoint ? 0 : 1);
    }
  }
  const end = routedEnemyHarness({ alwaysCheckCurrentPoint: false, checkpoints: [], speedPerTick: 0 });
  end.displace([-2, 0]);
  end.step();
  assert.equal(end.enemy.locomotion.mainRoute.route.progress.phase, 'END');
});

test('core visitEveryCheckPoint independently gates early END during waits and temporary takeover', () => {
  for (const visitEveryCheckPoint of [false, true]) {
    for (const takeover of [false, true]) {
      const h = routedEnemyHarness({ speedPerTick: 0,
        checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: 10 }, coreMove(1)],
        routeOverrides: { visitEveryCheckPoint } });
      if (takeover) h.setAlternative(createRouteDefinition(coreRoute({
        checkpoints: [coreMove(2)], endPosition: [0, 3],
      })));
      h.displace([4, 0]);
      const step = h.step({ movementAllowed: false });
      assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, visitEveryCheckPoint ? 'CHECKPOINTS' : 'COMPLETED');
      assert.equal(step.outcomes.some(outcome => outcome.type === 'ARRIVED' && outcome.requestId === 0), false);
    }
  }
});

test('core disappearance preserves identity and APPEAR uses fixed world position without locator compensation', () => {
  const h = routedEnemyHarness({ speedPerTick: 0.1, checkpoints: [
    { type: 'DISAPPEAR' }, { type: 'WAIT_FOR_TICKS', durationTicks: 2 },
    { type: 'APPEAR_AT_POS', position: [0, 2], reachOffset: [0.4, 0.3] }, coreMove(4),
  ], routeOverrides: { spawnOffset: [0.1, -0.2] } });
  const seed = h.rngState;
  assert.equal(h.enemy.spatialPresence.present, false);
  assert.deepEqual(h.initialSignals, [{ signal: { type: 'DISAPPEAR' }, position: [0.1, -0.2] }]);
  h.step();
  assert.deepEqual(h.enemy.position, [0.1, -0.2]);
  assert.deepEqual(h.enemy.locomotion.mainRoute.route.progress.checkpoint, { type: 'WAIT', remainingTicks: 2 });
  assert.deepEqual(h.step().signals, []);
  const appeared = h.step();
  assert.equal(appeared.enemy.id, 1);
  assert.equal(appeared.enemy.spatialPresence.present, true);
  assert.equal(appeared.enemy.locomotion.moving, false);
  assert.deepEqual(appeared.enemy.position, [2.4, 0.3]);
  assert.deepEqual(appeared.signals, [{ signal: { type: 'APPEAR_AT_POS', position: [2.4, 0.3] }, position: [2.4, 0.3] }]);
  assert.deepEqual(appeared.enemy.locomotion.mainRoute.navigation.execution.locatorOffset, [-0.1, 0.2]);
  assert.equal(h.rngState, seed);
  assert.equal(h.nextNavigationRequestId, 0);
  assert.deepEqual(h.step({ movementAllowed: false, routeAdvanceAllowed: false }).signals, []);
});

test('core alternative route expires its own wait and the main wait without automatically releasing control', () => {
  const h = routedEnemyHarness({ speedPerTick: 0, checkpoints: [
    { type: 'WAIT_FOR_TICKS', durationTicks: 2 }, coreMove(3, { randomizeReachOffset: true, reachOffset: [0.2, 0.1] }),
  ] });
  h.setAlternative(createRouteDefinition(coreRoute({ checkpoints: [], endPosition: [0, 0] })));
  const seed = h.rngState, nextId = h.nextNavigationRequestId;
  h.step();
  assert.equal(h.enemy.locomotion.alternativeRoute.route.progress.phase, 'COMPLETED');
  h.step();
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpointIndex, 0);
  assert.deepEqual(h.enemy.locomotion.mainRoute.route.progress.checkpoint, { type: 'WAIT', remainingTicks: 0 });
  assert.equal(h.enemy.locomotion.alternativeRoute.route.progress.phase, 'COMPLETED');
  assert.equal(h.rngState, seed);
  assert.equal(h.nextNavigationRequestId, nextId);
  h.clearAlternative();
  h.step();
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpointIndex, 1);
  assert.equal(h.nextNavigationRequestId, nextId + 1);
  assert.notEqual(h.rngState, seed);
});

test('core temporary navigation preserves main intent through mode and map changes before explicit restoration', () => {
  const h = routedEnemyHarness({ speedPerTick: 0.1, checkpoints: [
    coreMove(3, { randomizeReachOffset: true, reachOffset: [0.2, 0.1] }),
  ], routeOverrides: { spawnOffset: [0.1, 0.2] } });
  h.step();
  const main = h.enemy.locomotion.mainRoute, request = routedEnemyRequest(h.enemy);
  h.setAlternative(createRouteDefinition(coreRoute({ checkpoints: [], endPosition: [0, 2] })));
  const seed = h.rngState, nextId = h.nextNavigationRequestId;
  h.step({ moveMultiplier: 0 });
  assert.deepEqual(h.enemy.locomotion.alternativeRoute.navigation.execution.locatorOffset, [0, 0]);
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.checkpoint.goal, main.route.progress.checkpoint.goal);
  assert.equal(routedEnemyRequest(h.enemy), request);
  h.setMotionMode('FLY');
  h.setMaps({ ...h.maps, FLY: fieldMap(1, 5, Array.from({ length: 5 }, () => fieldCell()), 'FLY', 1) });
  h.step({ moveMultiplier: 0 });
  h.clearAlternative();
  h.step({ moveMultiplier: 0 });
  const restored = h.enemy.locomotion.mainRoute;
  assert.equal(restored.navigation.pathMotionMode, 'FLY');
  assert.equal(restored.navigation.execution.activity.path.field.map, h.maps.FLY);
  assert.equal(restored.navigation.execution.visits, main.navigation.execution.visits);
  assert.deepEqual(restored.navigation.execution.locatorOffset, main.navigation.execution.locatorOffset);
  assert.equal(routedEnemyRequest(h.enemy), request);
  assert.equal(h.rngState, seed);
  assert.equal(h.nextNavigationRequestId, nextId);
});

test('core original h07_02 teleport and patrol routes execute their unchanged false checkpoint flags', () => {
  const raw = JSON.parse(readFileSync(new URL('../fixtures/arknights/level_act1autochess_h07_02.json', import.meta.url), 'utf8'));
  const map = parseBattlefieldMap(raw.mapData);
  const maps = { WALK: projectStaticNavigationMap(map, 'WALK', 0), FLY: projectStaticNavigationMap(map, 'FLY', 0) };
  const fieldCache = createNavigationFieldCache();
  const definition = createEnemyDefinition({ id: 'enemy_route_fixture', vitality: { maxHp: 100 }, locomotion: {
    moveSpeedPerTick: 0.1, steeringParameters: createSteeringParameters({ steeringFactor: 10 / 30, maxSteeringForce: 100 / 900 }),
  } });
  function run(routeIndex, ticks) {
    const route = parseRouteDefinition(raw.routes[routeIndex]);
    assert.equal(route.visitEveryCheckPoint, false);
    let { enemy, rngState, nextNavigationRequestId } = initializeRoutedEnemy({
      id: 1, tick: 0, definition, route, rngState: 31, nextNavigationRequestId: 0,
      alwaysCheckCurrentPoint: true, timing: createRouteTiming({ waveStartedAtTick: 0, fragmentStartedAtTick: 0 }),
    });
    const trace = [];
    for (let tick = 0; tick < ticks && enemy.locomotion.mainRoute.route.progress.phase !== 'COMPLETED'; tick++) {
      const moved = stepRoutedEnemy(enemy, { tick, maps, fieldCache, moveMultiplier: 1,
        movementAllowed: true, waitTickAllowed: true, routeAdvanceAllowed: true, rngState, nextNavigationRequestId });
      enemy = moved.enemy;
      ({ rngState, nextNavigationRequestId } = moved);
      trace.push({ tick, position: enemy.position, present: enemy.spatialPresence.present,
        progress: enemy.locomotion.mainRoute.route.progress, signals: moved.signals });
    }
    return { enemy, trace };
  }
  const teleport = run(2, 1800);
  assert.equal(teleport.enemy.locomotion.mainRoute.route.progress.phase, 'COMPLETED');
  assert.deepEqual(teleport.trace.flatMap(step => step.signals.map(({ signal }) => signal.type)), ['DISAPPEAR', 'APPEAR_AT_POS']);
  assert.ok(teleport.trace.filter(step => !step.present).length >= 90);
  const appear = teleport.trace.find(step => step.signals.some(({ signal }) => signal.type === 'APPEAR_AT_POS'));
  assert.deepEqual(appear.signals[0].position, [10, 5]);
  assert.deepEqual(run(2, 1800), teleport);
  const patrol = run(6, 500);
  assert.equal(patrol.enemy.locomotion.mainRoute.route.progress.phase, 'CHECKPOINTS');
  assert.deepEqual(new Set(patrol.trace.map(step => step.progress.checkpointIndex)), new Set([0, 1, 2]));
  assert.ok(patrol.trace.filter((step, index, trace) => index > 0
    && step.progress.checkpointIndex === 0 && trace[index - 1].progress.checkpointIndex === 2).length >= 2);
});


test('core END completes after committed motion and keeps steering toward its centre inside the arrival radius', () => {
  const leaving = routedEnemyHarness({ speedPerTick: 0.01, checkpoints: [] });
  leaving.enemy.definition = createEnemyDefinition({ ...leaving.enemy.definition,
    locomotion: { ...leaving.enemy.definition.locomotion,
      steeringParameters: createSteeringParameters({ steeringFactor: 0.25, maxSteeringForce: 0 }) } });
  leaving.enemy.locomotion.steering.lastVelocity = [-0.01, 0];
  leaving.displace([3.951, 0]);
  const departed = leaving.step();
  assert.deepEqual(departed.outcomes, []);
  assert.ok(Math.abs(departed.enemy.position[0] - 3.941) < 1e-12);
  assert.equal(departed.enemy.locomotion.mainRoute.route.progress.phase, 'END');
  assert.equal(departed.enemy.locomotion.mainRoute.navigation.execution.activity.type, 'FOLLOWING');
  leaving.displace([4, 0]);
  const completed = leaving.step({ movementAllowed: false });
  assert.equal(completed.enemy.locomotion.mainRoute.route.progress.phase, 'COMPLETED');
  assert.deepEqual(completed.outcomes, [{ type: 'ARRIVED', requestId: 0 }]);
  const approaching = routedEnemyHarness({ speedPerTick: 0.01, checkpoints: [] });
  approaching.displace([3.96, 0]);
  const arrived = approaching.step();
  assert.ok(Math.abs(arrived.enemy.position[0] - 3.97) < 1e-12);
  assert.equal(arrived.enemy.locomotion.mainRoute.route.progress.phase, 'COMPLETED');
  assert.deepEqual(arrived.outcomes, [{ type: 'ARRIVED', requestId: 0 }]);
});


test('core actual outside-map movement returns directly without changing steering or binding a path', () => {
  const h = routedEnemyHarness({ speedPerTick: 0.1, checkpoints: [], routeOverrides: { spawnOffset: [-1, 0] } });
  const initial = h.enemy.locomotion.mainRoute.navigation;
  const velocity = [-0.07, 0];
  h.enemy.locomotion.steering.lastVelocity = velocity;
  const seed = h.rngState, nextId = h.nextNavigationRequestId;
  const returned = h.step();
  assert.deepEqual(returned.enemy.position, [-0.9, 0]);
  assert.equal(returned.enemy.locomotion.steering.lastVelocity, velocity);
  assert.equal(returned.enemy.locomotion.mainRoute.navigation.execution, initial.execution);
  assert.deepEqual(returned.outcomes, []);
  assert.equal(h.rngState, seed);
  assert.equal(h.nextNavigationRequestId, nextId);
  for (let tick = 0; tick < 20; tick++) h.step();
  assert.ok(h.enemy.position[0] > 0);
  assert.equal(h.enemy.locomotion.mainRoute.route.progress.phase, 'END');
});

test('core locator-only outside-map movement uses normal steering or a one-unit prediction snap', () => {
  for (const speedPerTick of [0.1, 10]) {
    const h = routedEnemyHarness({ speedPerTick, checkpoints: [], routeOverrides: { spawnOffset: [1, 0] } });
    h.displace([0, 0]);
    const velocity = [0, 0];
    h.enemy.locomotion.steering.lastVelocity = velocity;
    const returned = h.step();
    assert.deepEqual(returned.enemy.position, [speedPerTick === 10 ? 1 : 0.1, 0]);
    assert.equal(returned.enemy.locomotion.mainRoute.navigation.execution.activity.type, 'NEEDS_PATH');
    assert.deepEqual(returned.outcomes, []);
    if (speedPerTick === 10) assert.equal(returned.enemy.locomotion.steering.lastVelocity, velocity);
    else assert.deepEqual(returned.enemy.locomotion.steering.lastVelocity, [0.1, 0]);
  }
});

test('core outside-map recovery leaves spatial skipping to the single post-movement transition and keeps waits ticking', () => {
  const h = routedEnemyHarness({ speedPerTick: 0.1, alwaysCheckCurrentPoint: false,
    checkpoints: [coreMove(1), coreMove(2), coreMove(3)] });
  h.displace([-2, 0]);
  const moved = h.step();
  assert.deepEqual(moved.enemy.position, [-1.9, 0]);
  assert.equal(moved.enemy.locomotion.mainRoute.route.progress.checkpointIndex, 1);
  assert.equal(h.nextNavigationRequestId, 2);
  assert.deepEqual(moved.outcomes, []);
  const waiting = routedEnemyHarness({ speedPerTick: 0.1,
    checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: 3 }, coreMove(3)] });
  waiting.displace([-1, 0]);
  waiting.step();
  assert.deepEqual(waiting.enemy.position, [-0.9, 0]);
  assert.deepEqual(waiting.enemy.locomotion.mainRoute.route.progress.checkpoint, { type: 'WAIT', remainingTicks: 2 });
  assert.equal(waiting.nextNavigationRequestId, 0);
});
