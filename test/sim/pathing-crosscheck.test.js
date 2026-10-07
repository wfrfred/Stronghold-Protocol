import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Grid } from '../../server/sim/grid.js';
import { getDefaultSource, hasGeneratedData } from '../../server/sim/simdata.js';
import { GEO } from '../../shared/constants.js';
import { flowFieldForGrid } from '../../dist/legacy/navigation.js';
import { createNavigationMap } from '../../dist/core/tactical/battlefield/navigation/map.js';
import { buildRawNavigationField, buildNavigationField } from '../../dist/core/tactical/battlefield/navigation/pathfinding.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEVELS = join(ROOT, '.cache', 'gamedata', 'levels', 'activities');
const STAGES = ['act1autochess_m01', 'act1autochess_m02', 'act1autochess_m03', 'act1autochess_m04', 'act2autochess_m01', 'act2autochess_m02', 'act2autochess_m03', 'act2autochess_m04'];
const file = (sid) => join(LEVELS, sid.slice(0, 13), `level_${sid}.json`);
const SKIP = { skip: (!hasGeneratedData() && 'no generated data') || (!STAGES.every((s) => existsSync(file(s))) && 'no .cache/gamedata levels') };
const FOUR = [[1, 0], [0, 1], [-1, 0], [0, -1]];

function legacyReference(sid, { crates: extraCrates = [], blocks: extraBlocks = [], rect = null, prefer = true } = {}) {
  const lv = JSON.parse(readFileSync(file(sid), 'utf8'));
  const md = lv.mapData;
  const H = md.map.length, W = md.map[0].length;
  const tile = (r, c) => md.tiles[md.map[H - 1 - r][c]];
  const crates = new Set(), blocked = new Set();
  for (const t of lv.predefines?.tokenInsts || []) {
    if (t.hidden) continue;
    const k = `${t.position.row},${t.position.col}`;
    if (t.inst.characterKey === 'trap_1105_accrate') crates.add(k);
    if (t.inst.characterKey === 'trap_1106_achplat' || t.inst.characterKey === 'trap_032_mound') blocked.add(k);
  }
  for (const [r, c] of extraCrates) crates.add(`${r},${c}`);
  for (const [r, c] of extraBlocks) blocked.add(`${r},${c}`);
  const inside = (r, c) => (rect ? r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1 : r >= 0 && r < H && c >= 0 && c < W);
  const passable = (r, c) => inside(r, c) && ['ALL', 'WALK_ONLY'].includes(tile(r, c).passableMask) && !blocked.has(`${r},${c}`);
  // non-blockable walkable terrain: not LOWLAND buildable for melee (floor, gates, goal, teleports) — and the 深水区,
  // which refuses deployment whatever its buildableType (PRTS 深水区 地形信息 "拒绝部署（待补充）"; player report #3
  // after 0.1.0)
  const nb = (r, c) => {
    const t = tile(r, c);
    if (t.tileKey === 'tile_deepsea') return true;
    return !(t.heightType === 'LOWLAND' && (t.buildableType === 'ALL' || t.buildableType === 'MELEE'));
  };
  const bres = ([r0, c0], [r1, c1], clear) => {
    const dr = Math.abs(r1 - r0), dc = Math.abs(c1 - c0), sr = r1 > r0 ? 1 : -1, sc = c1 > c0 ? 1 : -1;
    let err = dc - dr, r = r0, c = c0;
    const out = [[r, c]];
    while (r !== r1 || c !== c1) {
      const e2 = 2 * err;
      let nr = r, nc = c;
      if (e2 > -dr) { err -= dr; nc += sc; }
      if (e2 < dc) { err += dc; nr += sr; }
      if (nr !== r && nc !== c) out.push([nr, c], [r, nc]);
      r = nr; c = nc;
      out.push([r, c]);
    }
    return clear ? out.every(([a, b]) => clear(a, b)) : out;
  };
  // tiles the centre-to-centre segment a → b passes through with positive length (Liang–Barsky clip per tile)
  const through = ([r0, c0], [r1, c1]) => {
    const out = [];
    for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) {
      for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) {
        let t0 = 0, t1 = 1;
        for (const [pp, qq] of [[-(c1 - c0), c0 - (c - 0.5)], [c1 - c0, c + 0.5 - c0], [-(r1 - r0), r0 - (r - 0.5)], [r1 - r0, r + 0.5 - r0]]) {
          if (pp === 0) { if (qq < 0) t1 = -1; continue; }
          if (pp < 0) t0 = Math.max(t0, qq / pp); else t1 = Math.min(t1, qq / pp);
        }
        if (t1 - t0 > 1e-9) out.push([r, c]);
      }
    }
    return out;
  };
  const key = (p) => p.join();
  const unkey = (k) => k.split(',').map(Number);
  const losClear = (y, x) => passable(y, x) && !crates.has(`${y},${x}`);
  return (dest) => {
    const D = dest.join();
    const spfa = (usePen) => {
      const dist = new Map([[D, 0]]);
      const pen = new Map([[D, 0]]);
      const par = new Map();
      const q = [dest];
      const inq = new Set([D]);
      while (q.length) {
        const cur = q.shift();
        const ck = cur.join();
        inq.delete(ck);
        for (const [dr, dc] of FOUR) {
          const nb2 = [cur[0] + dr, cur[1] + dc];
          const nk = nb2.join();
          if (!passable(nb2[0], nb2[1])) continue;
          const nd = dist.get(ck) + (crates.has(nk) ? 1000 : 1);
          const np = pen.get(ck) + (usePen && nb(nb2[0], nb2[1]) ? 1 : 0);
          if (!dist.has(nk) || nd < dist.get(nk) || (usePen && nd === dist.get(nk) && np < pen.get(nk))) {
            dist.set(nk, nd);
            pen.set(nk, np);
            par.set(nk, cur);
            if (!inq.has(nk)) { q.push(nb2); inq.add(nk); }
          }
        }
      }
      return { dist, par };
    };
    // row-major in-place smoothing; `guard` (0.1.0's preference smoothing): the line of sight toward ancestor a may
    // also cover non-blockable tiles (Bresenham footprint, diagonal-step corners included) only on the tile's own raw
    // chain between the tile and a — the jump stops at the first ancestor it cannot see so
    const smooth = ({ dist, par }, guard) => {
      const nxt = new Map(par);
      for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) {
          const k = `${r},${c}`;
          if (!nxt.has(k)) continue;
          const chain = new Set();
          if (guard) for (let x = [r, c]; x; x = par.get(x.join())) chain.add(x.join());
          const sees = (a) => bres([r, c], a, (y, x) => losClear(y, x)
            && (!guard || !nb(y, x) || (chain.has(`${y},${x}`) && dist.get(`${y},${x}`) >= dist.get(a.join()))));
          let b = nxt.get(k);
          while (nxt.has(b.join()) && sees(nxt.get(b.join()))) b = nxt.get(b.join());
          nxt.set(k, b);
        }
      }
      return nxt;
    };
    const off = spfa(false);
    const dist = off.dist;
    const segNb = (a, b) => through(a, b).filter(([y, x]) => !(y === a[0] && x === a[1]) && nb(y, x)).length;
    let nxt = smooth(off, false);
    if (prefer) {
      // per tile in increasing distance: the preference pointer when its route crosses fewer non-blockable tiles (or as
      // few while it only skips the official waypoint: o strictly inside the segment a → p, and o's chosen pointer is p)
      const nxtP = smooth(spfa(true), true);
      const cost = new Map([[D, 0]]);
      const chosen = new Map();
      const skips = (a, o, p) => {
        const t = through(a, p);
        return key(o) !== key(a) && key(o) !== key(p) && (o[0] - a[0]) * (p[1] - a[1]) === (o[1] - a[1]) * (p[0] - a[0]) && t.some((x) => key(x) === key(o));
      };
      for (const k of [...dist.keys()].sort((a, b) => dist.get(a) - dist.get(b))) {
        if (k === D) continue;
        const a = unkey(k), o = nxt.get(k), p = nxtP.get(k);
        const co = segNb(a, o) + cost.get(key(o)), cp = segNb(a, p) + cost.get(key(p));
        const useP = cp < co || (cp === co && key(o) !== key(p) && key(chosen.get(key(o)) ?? []) === key(p) && skips(a, o, p));
        chosen.set(k, useP ? p : o);
        cost.set(k, useP ? cp : co);
      }
      nxt = chosen;
    }
    const chainOf = (start) => {
      if (!dist.has(start.join())) return null;
      const out = [start];
      let k = start.join();
      while (k !== D && out.length < 100) { const n = nxt.get(k); out.push(n); k = n.join(); }
      return out;
    };
    const fn = (start) => { const ch = chainOf(start); return ch ? ch.map((p) => `(${p})`).join(' ') : null; };
    fn.dist = (start) => dist.get(start.join()) ?? -1;
    fn.crossedNb = (start) => {
      const ch = chainOf(start);
      if (!ch) return null;
      let n = 0;
      for (let i = 1; i < ch.length; i++) n += segNb(ch[i - 1], ch[i]);
      return n;
    };
    return fn;
  };
}

function simGrid(sid, rect, extra = {}) {
  const st = getDefaultSource().getStage(sid);
  const g = new Grid(st, rect);
  for (const d of st.raw.devices) {
    if (!d.active || !d.pos) continue;
    if (d.role === 'crate') g.setObstacle(d.pos[0], d.pos[1], true, 'crate');
    if (d.role === 'platform' || d.role === 'mound') g.setObstacle(d.pos[0], d.pos[1], true);
  }
  for (const [r, c] of extra.crates || []) g.setObstacle(r, c, true, 'crate');
  for (const [r, c] of extra.blocks || []) g.setObstacle(r, c, true);
  return g;
}

function compare(sid, rect, dests, extra = {}, officialRect = null) {
  const off = legacyReference(sid, { ...extra, rect: officialRect, prefer: true });
  const g = simGrid(sid, rect, extra);
  let n = 0;
  for (const dest of dests) {
    const chainOf = off(dest);
    const core = flowFieldForGrid(g, dest[0], dest[1]);
    for (let r = rect.r0; r <= rect.r1; r++) {
      for (let c = rect.c0; c <= rect.c1; c++) {
        if (!g.walkable(r, c)) continue;
        const wp = g.waypoints(r, c, dest[0], dest[1]);
        assert.equal(wp ? wp.map((p) => `(${p})`).join(' ') : null, chainOf([r, c]), `${sid} (${r},${c}) → (${dest}) ${JSON.stringify(extra)}`);
        assert.equal(core.dist[r * g.cols + c], chainOf.dist([r, c]), `${sid} core raw (${r},${c}) → (${dest}) ${JSON.stringify(extra)}`);
        n++;
      }
    }
  }
  return n;
}

test('legacy road-preference chains and core raw distances match the full-map reference on 8 stages', SKIP, () => {
  let n = 0;
  for (const sid of STAGES) {
    n += compare(sid, GEO.NORMAL_RECT, [[9, 2]]);
    n += compare(sid, GEO.UNITE_RECT, [[9, 2]]);
    n += compare(sid, GEO.BOSS_RECT, [[1, 3], [1, 17], [2, 2], [2, 18]]);
  }
  assert.ok(n > 1500, `${n} chains`);
});

test('random legacy crate / block layouts preserve road-preference chains and core raw distances', SKIP, () => {
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  let n = 0;
  for (let t = 0; t < 400; t++) {
    const sid = STAGES[t % STAGES.length];
    const crates = [], blocks = [];
    for (let i = 0; i < 6; i++) crates.push([9 + Math.floor(rnd() * 4), Math.floor(rnd() * 11)]);
    for (let i = 0; i < 2; i++) blocks.push([9 + Math.floor(rnd() * 4), 3 + Math.floor(rnd() * 7)]);
    n += compare(sid, GEO.NORMAL_RECT, [[9, 2]], { crates, blocks }, GEO.NORMAL_RECT);
  }
  assert.ok(n > 5000, `${n} chains`);
});

test('legacy blockable-ground preference preserves raw distance and crosses fewer non-blockable tiles', SKIP, () => {
  let n = 0, fewer = 0;
  const fields = [[GEO.NORMAL_RECT, [[9, 2]]], [GEO.UNITE_RECT, [[9, 2]]], [GEO.BOSS_RECT, [[1, 3], [1, 17], [2, 2], [2, 18]]]];
  for (const sid of STAGES) {
    const pure = legacyReference(sid, { prefer: false });
    const ours = legacyReference(sid, { prefer: true });
    for (const [rect, dests] of fields) {
      const g = simGrid(sid, rect);
      for (const dest of dests) {
        const p = pure(dest), o = ours(dest);
        const f = g.flowField(dest[0], dest[1]);
        for (let r = rect.r0; r <= rect.r1; r++) {
          for (let c = rect.c0; c <= rect.c1; c++) {
            if (!g.walkable(r, c) || p.dist([r, c]) < 0) continue;
            assert.equal(f.dist[r * 21 + c], p.dist([r, c]), `${sid} (${r},${c}) → (${dest}): official length`);
            const a = p.crossedNb([r, c]), b = o.crossedNb([r, c]);
            assert.ok(b <= a, `${sid} (${r},${c}) → (${dest}): ${b} non-blockable tiles vs official ${a}`);
            if (b < a) fewer++;
            n++;
          }
        }
      }
    }
  }
  assert.ok(n > 1500 && fewer > 0, `${n} chains, ${fewer} with fewer non-blockable tiles`);
  // the user's report: 战场#01 lower gate — official climbs the col-9 floor lane, ours keeps to the col-8 road
  assert.equal(legacyReference('act1autochess_m01', { prefer: false })([9, 2])([9, 10]), '(9,10) (9,9) (12,8) (12,4) (9,4) (9,2)');
  assert.equal(legacyReference('act1autochess_m01', { prefer: true })([9, 2])([9, 10]), '(9,10) (9,8) (12,8) (12,4) (9,4) (9,2)');
});

function dijkstraDistances(map, target) {
  const distance = Array(map.cells.length).fill(Infinity);
  const settled = Array(map.cells.length).fill(false);
  const goal = target[0] * map.columns + target[1];
  if (!map.cells[goal].passable) return distance.map(() => -1);
  distance[goal] = 0;
  while (true) {
    let current = -1;
    for (let index = 0; index < distance.length; index++) {
      if (!settled[index] && distance[index] < (current < 0 ? Infinity : distance[current])) current = index;
    }
    if (current < 0) break;
    settled[current] = true;
    const row = Math.floor(current / map.columns), col = current % map.columns;
    for (let source = 0; source < map.cells.length; source++) {
      const cell = map.cells[source];
      if (!cell.passable || settled[source]) continue;
      const sourceRow = Math.floor(source / map.columns), sourceCol = source % map.columns;
      const dRow = row - sourceRow, dCol = col - sourceCol;
      if (Math.abs(dRow) + Math.abs(dCol) !== 1) continue;
      const direction = dRow === 1 ? 'UP' : dRow === -1 ? 'DOWN' : dCol === 1 ? 'RIGHT' : 'LEFT';
      if (!cell.departures[direction]) continue;
      distance[source] = Math.min(distance[source], distance[current] + cell.moveCost);
    }
  }
  return distance.map(value => Number.isFinite(value) ? value : -1);
}

function bellmanFordDistances(map, target) {
  const distance = Array(map.cells.length).fill(Infinity);
  const goal = target[0] * map.columns + target[1];
  if (!map.cells[goal].passable) return distance.map(() => -1);
  distance[goal] = 0;
  const edges = [];
  const offsets = { UP: [1, 0], RIGHT: [0, 1], DOWN: [-1, 0], LEFT: [0, -1] };
  for (let from = 0; from < map.cells.length; from++) {
    if (!map.cells[from].passable) continue;
    const row = Math.floor(from / map.columns), col = from % map.columns;
    for (const [direction, [dRow, dCol]] of Object.entries(offsets)) {
      if (!map.cells[from].departures[direction]) continue;
      const nextRow = row + dRow, nextCol = col + dCol;
      if (nextRow < 0 || nextRow >= map.rows || nextCol < 0 || nextCol >= map.columns) continue;
      const to = nextRow * map.columns + nextCol;
      if (map.cells[to].passable) edges.push([from, to, map.cells[from].moveCost]);
    }
  }
  for (let pass = 0; pass < map.cells.length; pass++) {
    let changed = false;
    for (const [from, to, cost] of edges) {
      if (distance[from] > distance[to] + cost) {
        distance[from] = distance[to] + cost;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return distance.map(value => Number.isFinite(value) ? value : -1);
}

function assertFieldInvariants(field) {
  const { map, query, nodes } = field;
  const targetIndex = query.targetTile[0] * map.columns + query.targetTile[1];
  assert.equal(nodes.length, map.rows * map.columns);
  assert.ok(Object.isFrozen(field) && Object.isFrozen(query) && Object.isFrozen(query.targetTile));
  assert.ok(Object.isFrozen(nodes) && nodes.every(Object.isFrozen));
  assert.equal(nodes.filter(node => node.type === 'TARGET').length, map.cells[targetIndex].passable ? 1 : 0);
  if (!map.cells[targetIndex].passable) assert.ok(nodes.every(node => node.type === 'UNREACHABLE'));
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.type === 'UNREACHABLE') continue;
    assert.ok(map.cells[index].passable);
    if (node.type === 'TARGET') {
      assert.equal(index, targetIndex);
      assert.equal(node.distance, 0);
      continue;
    }
    assert.equal(node.type, 'REACHABLE');
    assert.ok(Number.isInteger(node.distance) && node.distance > 0 && node.distance <= 0x7fffffff);
    for (const next of [node.rawNext, node.next]) {
      assert.ok(Object.isFrozen(next));
      assert.ok(Number.isInteger(next[0]) && next[0] >= 0 && next[0] < map.rows);
      assert.ok(Number.isInteger(next[1]) && next[1] >= 0 && next[1] < map.columns);
      const successor = nodes[next[0] * map.columns + next[1]];
      assert.notEqual(successor.type, 'UNREACHABLE');
      assert.ok(successor.distance < node.distance);
    }
    const row = Math.floor(index / map.columns), col = index % map.columns;
    const dRow = node.rawNext[0] - row, dCol = node.rawNext[1] - col;
    assert.equal(Math.abs(dRow) + Math.abs(dCol), 1);
    const direction = dRow === 1 ? 'UP' : dRow === -1 ? 'DOWN' : dCol === 1 ? 'RIGHT' : 'LEFT';
    assert.ok(map.cells[index].departures[direction]);
    assert.equal(node.distance, nodes[node.rawNext[0] * map.columns + node.rawNext[1]].distance + map.cells[index].moveCost);
    if (!query.allowDiagonalMove) assert.ok(node.next[0] === row || node.next[1] === col);
  }
}

test('core random directed weighted fields agree with independent Dijkstra and Bellman-Ford distances', () => {
  let seed = 0x6e617669;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const costs = [1, 2, 9, 1000, 1_000_000];
  for (let sample = 0; sample < 200; sample++) {
    const rows = 1 + Math.floor(random() * 7), columns = 1 + Math.floor(random() * 8);
    const pathMotionMode = sample % 5 === 0 ? 'FLY' : 'WALK';
    const cells = Array.from({ length: rows * columns }, () => ({
      passable: random() >= 0.2,
      moveCost: pathMotionMode === 'FLY' ? 1 : costs[Math.floor(random() * costs.length)],
      departures: { UP: random() >= 0.2, RIGHT: random() >= 0.2, DOWN: random() >= 0.2, LEFT: random() >= 0.2 },
    }));
    const map = createNavigationMap({ rows, columns, pathMotionMode, revision: sample, cells });
    const target = [Math.floor(random() * rows), Math.floor(random() * columns)];
    const query = { targetTile: target, allowDiagonalMove: sample % 2 === 0 };
    const input = JSON.stringify({ map, query });
    const raw = buildRawNavigationField(map, query);
    const rawSnapshot = JSON.stringify(raw);
    const smooth = buildNavigationField(map, query);
    assert.equal(JSON.stringify({ map, query }), input);
    assert.equal(JSON.stringify(raw), rawSnapshot);
    assertFieldInvariants(raw);
    assertFieldInvariants(smooth);
    const actual = raw.nodes.map(node => node.type === 'UNREACHABLE' ? -1 : node.distance);
    assert.deepEqual(actual, dijkstraDistances(map, target), `Dijkstra sample ${sample}`);
    assert.deepEqual(actual, bellmanFordDistances(map, target), `Bellman-Ford sample ${sample}`);
    assert.deepEqual(smooth.nodes.map(node => node.type === 'UNREACHABLE' ? -1 : node.distance), actual, `smoothing sample ${sample}`);
    for (let index = 0; index < raw.nodes.length; index++) {
      const node = raw.nodes[index];
      if (node.type !== 'REACHABLE') continue;
      assert.deepEqual(node.next, node.rawNext);
      assert.deepEqual(smooth.nodes[index].rawNext, node.rawNext);
      const next = smooth.nodes[index].next;
      assert.ok(actual[next[0] * columns + next[1]] < node.distance, `successor sample ${sample}, node ${index}`);
    }
  }
});
