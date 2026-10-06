import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattlefieldMap, BattlefieldMap } from '../../dist/core/tactical/map/map.js';
import { createTile } from '../../dist/core/tactical/map/tile.js';
import { projectStaticNavigationMap } from '../../dist/core/tactical/battle/battlefield/navigation.js';
import { createNavigationMap, NavigationMap } from '../../dist/core/tactical/navigation/map.js';
import { createNavigationRequest } from '../../dist/core/tactical/navigation/request.js';
import { deriveNavigationFieldQuery } from '../../dist/core/tactical/navigation/field.js';
import { createNavigationPath } from '../../dist/core/tactical/navigation/path.js';
import {
  bindNavigationPath, createNavigationState, predictNavigation,
  setNavigationMotionMode, startNavigationRequest, steerNavigation,
} from '../../dist/core/tactical/navigation/state.js';
import { createRouteDefinition } from '../../dist/core/tactical/route/definition.js';
import { createRouteClock, createRouteClockBinding, createRouteState } from '../../dist/core/tactical/route/progress.js';
import { initializeRouteSpawn } from '../../dist/core/tactical/route/initialize.js';
import { parseBattlefieldMap } from '../../dist/data/arknights/map.js';
import { parseRouteDefinition } from '../../dist/data/arknights/route.js';
import { Grid, OBSTACLE_COST, bresenhamTiles } from '../../server/sim/grid.js';
import { flowFieldForGrid, navigationMapFromGrid, waypointsForGrid } from '../../dist/legacy/navigation.js';
import { buildRawNavigationField, buildNavigationField } from '../../dist/core/tactical/navigation/pathfinding.js';
import { createNavigationFieldCache } from '../../dist/core/tactical/navigation/cache.js';
import { smoothNavigationField } from '../../dist/core/tactical/navigation/smoothing.js';
import {
  initializeNavigationCursor, selectNavigationPredictionTarget, selectNavigationSteeringTarget,
} from '../../dist/core/tactical/navigation/execute.js';
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

test('core diagonal smoothing checks narrow rectangles and high costs while axis smoothing only checks collinearity', () => {
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
    assert.ok(Object.isFrozen(first) && Object.isFrozen(first.cursor) && Object.isFrozen(first.visits));
    assert.ok(Object.isFrozen(first.visits.visitedCenters) && first.visits.visitedCenters.every(Object.isFrozen));
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
  assert.ok(Object.isFrozen(prediction) && Object.isFrozen(prediction.state.execution));
  assert.ok(Object.isFrozen(steering) && Object.isFrozen(steering.outcomes));
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
    damagePerSecond: 100, attackBonusRatio: 0.2, attackSpeedBonus: 20, activeUntilSeconds: 60,
  } } });
  const markers = [{ type: 'START', position: [0, 0] }];
  const edges = [{ position: [0, 0], direction: 'RIGHT', blockMask: 'WALK_ONLY' }];
  const map = createBattlefieldMap(1, 2, [tile, coreGround()], markers, edges);
  tile.mechanism.params.damagePerSecond = 999;
  markers[0].position[1] = 1;
  edges[0].blockMask = 'ALL';
  assert.equal(map.tiles[0].mechanism.params.damagePerSecond, 100);
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
    coreGround({ terrain: 'WORD' }), coreGround({ passableMask: 'FLY_ONLY' }),
  ], [], [
    { position: [0, 1], direction: 'RIGHT', blockMask: 'WALK_ONLY' },
    { position: [0, -1], direction: 'RIGHT', blockMask: 'ALL' },
  ]);
  assert.throws(() => projectStaticNavigationMap(map, 'WALK', 0), /explicit mechanism cost/);
  const walk = projectStaticNavigationMap(map, 'WALK', 2, [{ position: [0, 2], moveCost: 1000 }]);
  const fly = projectStaticNavigationMap(map, 'FLY', 2);
  assert.deepEqual(walk.cells.map(cell => cell.moveCost), [1, 1_000_000, 1000, 1]);
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
  const mire = { stackIntervalSeconds: 1, attackSpeedPerStack: -5, moveSpeedRatioPerStack: -0.1, maxStacks: 5 };
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

test('route constructors keep clocks explicit, snapshots isolated and progress local to each instance', () => {
  const input = coreRoute({ checkpoints: [{ type: 'WAIT_FOR_SECONDS', durationSeconds: -1 }] });
  const definition = createRouteDefinition(input);
  input.checkpoints[0].durationSeconds = 9;
  assert.equal(definition.checkpoints[0].durationSeconds, -1);
  const binding = createRouteClockBinding({ waveStartedAtSeconds: 10, fragmentStartedAtSeconds: 12 });
  const a = createRouteState(definition, binding, false), b = createRouteState(definition, binding, true);
  a.progress.checkpointIndex = 1;
  assert.equal(b.progress.checkpointIndex, 0);
  assert.equal(a.definition, definition);
  assert.equal(b.definition, definition);
  assert.equal(a.clockBinding, binding);
  assert.equal(b.clockBinding, binding);
  assert.ok(Object.isFrozen(definition) && Object.isFrozen(definition.checkpoints));
  const clock = createRouteClock({ fixedPlayTimeSeconds: 15, userFixedPlayTimeSeconds: 13, deltaTimeSeconds: 1 / 30 });
  assert.notEqual(clock.fixedPlayTimeSeconds, clock.userFixedPlayTimeSeconds);
  assert.throws(() => createRouteState(definition, binding), TypeError);
  assert.throws(() => createRouteClock({ ...clock, deltaTimeSeconds: -1 }), RangeError);
  assert.throws(() => createRouteClockBinding({ waveStartedAtSeconds: 0, fragmentStartedAtSeconds: NaN }), RangeError);
  assert.throws(() => createRouteDefinition(coreRoute({ checkpoints: [,] })), TypeError);
  assert.throws(() => createRouteDefinition(coreRoute({ startPosition: [0, 0, 1] })), TypeError);
  assert.throws(() => createRouteDefinition(coreRoute({ spawnOffset: [0, Infinity] })), TypeError);
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
  assert.throws(() => parseRouteDefinition({ ...raw, motionMode: 'E_NUM' }), /motion mode/);
  assert.throws(() => parseRouteDefinition({ ...raw, checkpoints: [{ type: 'WAIT_BOSSRUSH_WAVE', time: 1 }] }), /checkpoint type/);
  assert.throws(() => parseRouteDefinition({ ...raw, checkpoints: [{ type: 'INVALID' }] }), /checkpoint type/);
  assert.throws(() => parseRouteDefinition({ ...raw, unknownRule: true }), /unsupported field/);
});
