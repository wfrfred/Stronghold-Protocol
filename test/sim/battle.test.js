// Battle-level rules: DP & redeploy, pathing around crates, FLY checkpoints, leaks/results, time limit, unite & boss
// fields, shared boss pool, wire format, determinism, robustness, deployment order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Battle } from '../../server/sim/Battle.js';
import { makeBattle, chessRec, enemyRec, flatStage, hashOf, checkInvariants } from '../helpers/battleHarness.js';
import { UF, ANIM, BOND_LAYER_CAP } from '../../shared/constants.js';
import { EV } from '../../shared/protocol.js';
import { getDefaultSource, spawnsFromTemplate, hasGeneratedData } from '../../server/sim/simdata.js';
import { LocalBossPool } from '../../server/sim/spec.js';
import { BattlefieldRuntime } from '../../dist/core/tactical/battlefield/runtime.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map.js';
import { createMechanismDefinition, createMechanismRuntime } from '../../dist/core/tactical/battlefield/mechanism.js';
import { createNavigationEffectDefinition, createNavigationSpatialEffect, createSpatialEffectRegion } from '../../dist/core/tactical/battlefield/navigation-effect.js';
import { createRng } from '../../dist/core/common/rng.js';
import { createBattleSpec } from '../../dist/core/tactical/battle/spec.js';
import { BattleRuntime, simulateBattle } from '../../dist/core/tactical/battle/runtime.js';
import { advanceSpawnSchedule, cloneScheduleState, createSpawnScheduleDefinition, createSpawnScheduleState, getSpawnedCount, getUnspawnedCount, isSpawnScheduleCompleted, recordScheduleSpawns, resolveScheduleUnits } from '../../dist/core/tactical/battle/schedule.js';
import { createSteeringParameters } from '../../dist/core/tactical/unit/capability/locomotion/steering.js';
import { createEnemyDefinition } from '../../dist/core/tactical/unit/enemy.js';
import { createRouteDefinition } from '../../dist/core/tactical/route/definition.js';
import { TICKS_PER_SECOND } from '../../dist/core/tactical/tick.js';
import { secondsToTicks } from '../../dist/data/arknights/tick.js';
import { parseLevelDefinition } from '../../dist/data/arknights/level.js';
import { parseEnemyMovementContent, parseEnemyMovementDefinition } from '../../dist/data/arknights/enemy.js';
import { parseEnemyMovementPrefab, parsePredefinedPrefab } from '../../dist/data/arknights/prefab.js';
import { parsePredefinedInstanceDefinition } from '../../dist/data/arknights/predefined.js';
import { compileSpawnSchedule } from '../../dist/data/arknights/schedule.js';
import { compileLevelMovementFragment } from '../../dist/data/arknights/movement-fragment.js';
import { loadMovementScenario } from '../../dist/data/arknights/movement-scenario.js';
import { createLegacyCombatBattle } from '../../dist/legacy/combat.js';

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const guard = (o = {}) => chessRec({ id: 't_guard', profession: 'WARRIOR', stats: { atk: 300, blockCnt: 2 }, skill: null, ...o });
const walker = (o = {}) => enemyRec({ key: 'enemy_walker', hp: 1e6, speed: 1, ...o });

function arknightsFixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/arknights/${name}.json`, import.meta.url), 'utf8'));
}

function slimeMovementProfile(steeringParameters = createSteeringParameters({ steeringFactor: 10 / 30, maxSteeringForce: 100 / 900 })) {
  return { ...parseEnemyMovementPrefab(arknightsFixture('prefab_enemy_1007_slime')), steeringParameters };
}

function slimeMovementFragment(rawLevel = arknightsFixture('level_act1autochess_01'), actionIndices = [0],
  steeringParameters = createSteeringParameters({ steeringFactor: 10 / 30, maxSteeringForce: 100 / 900 })) {
  const rawEnemy = arknightsFixture('enemy_1007_slime');
  const profile = slimeMovementProfile(steeringParameters);
  const level = parseLevelDefinition(rawLevel);
  const fragment = compileLevelMovementFragment(level, { waveIndex: 0, fragmentIndex: 0, actionIndices }, {
    rngState: 123,
    resolveEnemy: reference => parseEnemyMovementContent(rawEnemy, reference.level, profile, reference.overwrittenData),
  });
  return { rawLevel, level, ...fragment };
}

function withTimelineSpawns(spec, spawns) {
  return { ...spec, schedule: { type: 'TIMELINE', spawns } };
}

function routeCommandBattle(checkpoints, options = {}) {
  const { spec } = slimeMovementFragment();
  const source = spec.schedule.spawns[0];
  const route = createRouteDefinition({ ...source.route, visitEveryCheckPoint: true, checkpoints,
    spawnOffset: [0, 0], spawnRandomRange: [0, 0], ...options.route });
  const definition = createEnemyDefinition({ ...source.definition,
    locomotion: { ...source.definition.locomotion, moveSpeedPerTick: options.speed ?? 0 } });
  return { ...withTimelineSpawns(spec, [{ ...source, tick: 0, definition, route, alwaysCheckCurrentPoint: true }]),
    maxTicks: options.maxTicks ?? 20, ...options.spec };
}

function nativeSpawn(overrides = {}) {
  return { ...arknightsFixture('level_act1autochess_01').waves[0].fragments[0].actions[0],
    count: 1, preDelay: 0, interval: 0, ...overrides };
}

function nativeFragment(actions, preDelay = 0) {
  return { preDelay, actions };
}

function nativeWave(fragments, overrides = {}) {
  return { preDelay: 0, postDelay: 0, maxTimeWaitingForNextWave: -1, advancedWaveTag: null, fragments, ...overrides };
}

function syntheticSpawnSchedule(waves, branches = {}, ignoredKeys = []) {
  const raw = arknightsFixture('level_act1autochess_01');
  const rawEnemy = arknightsFixture('enemy_1007_slime');
  const profile = slimeMovementProfile();
  raw.waves = waves;
  raw.branches = branches;
  const actions = waves.flatMap(wave => wave.fragments.flatMap(fragment => fragment.actions));
  const branchActions = Object.values(branches).flatMap(branch => branch.phases.flatMap(phase => phase.actions));
  raw.enemyDbRefs = [...new Set([...actions, ...branchActions].map(action => action.key))].map(id => ({
    useDb: true, id, level: 0,
    overwrittenData: ignoredKeys.includes(id) ? { attributes: {}, notCountInTotal: { m_defined: true, m_value: true } } : null,
  }));
  const level = parseLevelDefinition(raw);
  const compilation = compileSpawnSchedule(level, {
    actions: waves.flatMap((wave, waveIndex) => wave.fragments.flatMap((fragment, fragmentIndex) =>
      fragment.actions.map((_, actionIndex) => ({ waveIndex, fragmentIndex, actionIndex })))),
    branches: Object.keys(branches),
  }, reference => parseEnemyMovementContent({ ...rawEnemy, Key: reference.id }, reference.level, profile, reference.overwrittenData));
  return { level, schedule: createSpawnScheduleDefinition(compilation.schedule) };
}

function dispatchSchedule(schedule, state, tick, unitIds = [], triggers = []) {
  const advanced = advanceSpawnSchedule(schedule, state, { tick, triggers });
  return { spawns: advanced.spawns, state: recordScheduleSpawns(advanced.state, advanced.spawns, unitIds) };
}

test('initial deployment order: top→bottom then left→right; right boss side right→left', () => {
  const h = makeBattle({
    defs: { chess: { a: guard({ id: 'a' }), b: guard({ id: 'b' }), c: guard({ id: 'c' }), d: guard({ id: 'd' }) } },
    units: [{ chessId: 'a', row: 9, col: 5 }, { chessId: 'b', row: 12, col: 7 }, { chessId: 'c', row: 12, col: 3 }, { chessId: 'd', row: 10, col: 4 }],
    content: 'none',
  });
  h.step();
  assert.deepEqual(h.hooksOf('deploy').filter((c) => c.initial).map((c) => c.unit.defId), ['c', 'b', 'd', 'a']);
  assert.equal(h.hooksOf('battleStart').length, 1);
  const hb = makeBattle({
    kind: 'boss',
    defs: { chess: { a: guard({ id: 'a' }), b: guard({ id: 'b' }) } },
    players: [{ playerId: 'R1', side: 'R', colOffset: 8, units: [{ uid: 1, chessId: 'a', row: 10, col: 3 }, { uid: 2, chessId: 'b', row: 10, col: 6 }] }],
    content: 'none',
  });
  hb.step();
  const order = hb.hooksOf('deploy').filter((c) => c.initial).map((c) => [c.unit.defId, c.unit.tileR, c.unit.tileC, c.unit.facing]);
  // board row 10 → boss row 3; mirrored cols: 3 → 17, 6 → 14; right→left in field coords
  assert.deepEqual(order, [['a', 3, 17, -1], ['b', 3, 14, -1]]);
});

test('DP: starts at 10, +1/s, cap 99; dead operator redeploys after respawnTime when DP ≥ cost', () => {
  const h = makeBattle({
    defs: { chess: { t_guard: guard({ stats: { respawnTime: 5, cost: 20 } }) } },
    units: [{ chessId: 't_guard', row: 9, col: 5 }], content: 'none', timeLimit: 200,
  });
  h.step();
  const pl = h.b.getPlayer('p1');
  approx(pl.dp, 10 + 1 / 30);
  const g = h.unit('t_guard');
  h.b.dealDamage(null, g, { amount: 1e9, type: 'true' });
  assert.equal(g.alive, false);
  assert.equal(h.result().perPlayer.p1.deaths, 1);
  h.run(5.2);
  assert.equal(g.alive, false, 'respawn time elapsed but DP (≈15) < cost 20');
  h.run(5);
  assert.equal(g.alive, true, 'redeployed once DP reached 20');
  assert.ok(pl.dp < 2, `dp spent (${pl.dp})`);
  approx(g.hp, g.s.maxHp);
  h.run(150);
  assert.equal(pl.dp, 99);
  assert.equal(h.eventsOf('deploy').length, 2);
});

test('battle.redeploy(unit) is instant and free; retreat() keeps respawn timers', () => {
  const h = makeBattle({ defs: { chess: { t_guard: guard({ stats: { respawnTime: 50, cost: 50 } }) } }, units: [{ chessId: 't_guard', row: 9, col: 5 }], content: 'none' });
  h.step();
  const g = h.unit('t_guard');
  h.b.retreat(g);
  assert.equal(g.alive, false);
  assert.equal(h.result().perPlayer.p1.deaths, 0, 'retreat is not a death');
  assert.equal(h.b.redeploy(g), true);
  assert.equal(g.alive, true);
});

test('pathing: enemies walk around crates and re-path when a crate is destroyed', () => {
  // wall off rows 10–12 at col 6 except via a crate on (9,6): the only route goes through the crate
  const rows = { 10: '##hrrr#rrrfrrrrrrrf##', 11: '##hrrr#rrrfrrrrrrrf##', 12: '##hrrr#rrrSrrrrrrrS##' };
  const h = makeBattle({
    flat: { rows, crates: [[9, 6]] },
    defs: { enemies: { enemy_walker: walker({ atk: 500, bat: 1 }) } },
    enemies: [{ key: 'enemy_walker' }], content: 'none', autoFinish: false,
  });
  h.step();
  const crate = h.b.allyUnits.find((u) => u.kind === 'device');
  assert.ok(crate && crate.obstacle, 'crate spawned from stage devices');
  assert.ok(h.b.grid.isObstacle(9, 6));
  const e = h.enemy('enemy_walker');
  h.runUntil(() => e.blockedBy === crate, 20);
  assert.equal(e.blockedBy, crate, 'no way around: blocked by the crate');
  h.runUntil(() => !crate.alive, 10);
  assert.equal(crate.alive, false, 'enemy destroyed the crate');
  assert.equal(h.b.grid.isObstacle(9, 6), false);
  h.runUntil(() => !e.alive, 30);
  assert.equal(h.result().perPlayer.p1.leaked.length, 1);

  // with a detour available the crate is avoided entirely
  const h2 = makeBattle({ flat: { crates: [[9, 6]] }, defs: { enemies: { enemy_walker: walker() } }, enemies: [{ key: 'enemy_walker' }], content: 'none', autoFinish: false });
  const e2 = h2.b.units;
  let touched = false;
  h2.b.on('tick', () => { for (const u of h2.b.enemies) if (Math.round(u.y) === 9 && Math.round(u.x) === 6) touched = true; });
  h2.runUntil(() => h2.b.enemies.length === 0 && h2.b.time > 1, 40);
  assert.equal(touched, false, 'detoured around the crate');
  assert.ok(e2.find((u) => u.kind === 'device').alive);
  // re-path when a new obstacle appears mid-walk
  const h3 = makeBattle({ defs: { enemies: { enemy_walker: walker() } }, enemies: [{ key: 'enemy_walker' }], content: 'none', autoFinish: false });
  h3.run(1);
  const e3 = h3.enemy('enemy_walker');
  h3.b.setObstacle(9, 5, true);
  let crossed = false;
  h3.b.on('tick', () => { if (e3.alive && Math.round(e3.y) === 9 && Math.round(e3.x) === 5) crossed = true; });
  h3.runUntil(() => !e3.alive, 40);
  assert.equal(crossed, false);
});

test('FLY enemies follow their checkpoint route and ignore ground obstacles', () => {
  const route = { motion: 'FLY', start: [9, 10], end: [9, 2], checkpoints: [[12, 9], [12, 4]] };
  const h = makeBattle({
    defs: { enemies: { enemy_fly: enemyRec({ key: 'enemy_fly', hp: 1e6, speed: 2, motion: 'FLY' }) } },
    enemies: [{ key: 'enemy_fly', route }], content: 'none', autoFinish: false,
  });
  const pts = [];
  h.b.on('tick', () => { const e = h.b.enemies[0]; if (e) pts.push([e.y, e.x]); });
  h.runUntil(() => h.b.enemies.length === 0 && h.b.time > 0.5, 60);
  assert.ok(pts.some(([y, x]) => Math.abs(y - 12) < 0.05 && Math.abs(x - 9) < 0.05), 'passed checkpoint (12,9)');
  assert.ok(pts.some(([y, x]) => Math.abs(y - 12) < 0.05 && Math.abs(x - 4) < 0.05), 'passed checkpoint (12,4)');
  const maxY = Math.max(...pts.map((p) => p[0]));
  assert.ok(maxY <= 12 + 1e-9);
  assert.equal(h.result().perPlayer.p1.leaked.length, 1);
});

test('route steps: disappear / wait / appear (teleport) are honoured', () => {
  const route = { motion: 'WALK', start: [9, 10], end: [9, 2], steps: [{ t: 'move', p: [9, 8] }, { t: 'disappear' }, { t: 'wait', s: 2 }, { t: 'appear', p: [9, 4] }] };
  const h = makeBattle({ defs: { enemies: { enemy_walker: walker({ speed: 2 }) } }, enemies: [{ key: 'enemy_walker', route }], content: 'none', autoFinish: false });
  h.run(2.1);
  const e = h.enemy('enemy_walker');
  assert.equal(e.hidden, true);
  assert.ok(!h.snapshot().units.some((t) => t[0] === e.id), 'hidden enemies are not in snapshots');
  h.run(2);
  assert.equal(e.hidden, false);
  assert.ok(e.x <= 4 + 1e-9);
  assert.ok(h.eventsOf('fx').some((f) => f[1] === 'appear'));
});

test('leaks: recorded per player with enemyKey/mods/lpr/sourcePlayerId; perfect=false; cleared when all gone', () => {
  const h = makeBattle({
    defs: { enemies: { enemy_walker: walker({ speed: 3, lpr: 2 }) } },
    enemies: [{ key: 'enemy_walker', mods: { hpMul: 2 }, sourcePlayerId: 'pX' }], content: 'none',
  });
  const r = h.runToEnd(60);
  assert.equal(r.reason, 'cleared');
  const pp = r.perPlayer.p1;
  assert.equal(pp.leaked.length, 1);
  assert.deepEqual({ ...pp.leaked[0] }, { enemyKey: 'enemy_walker', mods: { hpMul: 2 }, lpr: 2, sourcePlayerId: 'pX', tag: null, counted: true, boss: undefined, spawned: true });
  assert.equal(pp.perfect, false);
  assert.equal(pp.killed, 0);
  assert.equal(pp.total, 1);
  assert.equal(h.eventsOf('leak').length, 1);
  assert.equal(h.hooksOf('enemyLeak').length, 1);
  assert.equal(h.hooksOf('battleEnd').length, 1);
});

test('kills: killed/total counters, bounty coins to the killer\'s owner, perfect clear', () => {
  const h = makeBattle({
    defs: { chess: { t_guard: guard({ stats: { atk: 5000 } }) }, enemies: { enemy_walker: walker({ hp: 1000 }) } },
    units: [{ chessId: 't_guard', row: 9, col: 6 }],
    enemies: [{ key: 'enemy_walker', count: 3, interval: 1, bounty: { coins: 2 } }], content: 'none',
  });
  const r = h.runToEnd(60);
  assert.equal(r.reason, 'cleared');
  assert.equal(r.perPlayer.p1.killed, 3);
  assert.equal(r.perPlayer.p1.total, 3);
  assert.equal(r.perPlayer.p1.perfect, true);
  assert.equal(r.perPlayer.p1.coins, 6);
  assert.equal(h.eventsOf('bounty').length, 3);
  assert.equal(h.b.killed, 3);
  assert.equal(h.snapshot().killed, 3);
  assert.equal(h.unit('t_guard').stats.kills, 3);
});

test('time limit: battle ends at timeLimit, remaining enemies count as leaked, unspawned ones are dropped', () => {
  const h = makeBattle({
    defs: { enemies: { enemy_walker: walker({ speed: 0.01 }) } },
    enemies: [{ key: 'enemy_walker', count: 2 }, { key: 'enemy_walker', time: 100 }], timeLimit: 10, content: 'none',
  });
  const r = h.runToEnd(30);
  assert.equal(r.reason, 'timeout');
  approx(r.time, 10, 1 / 30 + 1e-9);
  assert.equal(r.perPlayer.p1.leaked.length, 2);
  assert.equal(r.unspawned.length, 1);
  assert.equal(r.total, 2);
  assert.equal(r.perPlayer.p1.total, 2);
  assert.equal(r.perPlayer.p1.perfect, false);
});

test('forceEnd: forced ends immediately, timeout counts leaks; step after finish is a no-op', () => {
  const h = makeBattle({ defs: { enemies: { enemy_walker: walker() } }, enemies: [{ key: 'enemy_walker' }], content: 'none' });
  h.run(1);
  h.b.forceEnd('forced');
  assert.equal(h.b.finished, true);
  assert.equal(h.result().reason, 'forced');
  const t = h.b.time;
  h.step(5);
  assert.equal(h.b.time, t);
  const h2 = makeBattle({ defs: { enemies: { enemy_walker: walker() } }, enemies: [{ key: 'enemy_walker' }], content: 'none' });
  h2.run(1);
  h2.b.forceEnd('timeout');
  assert.equal(h2.result().reason, 'timeout');
  assert.equal(h2.result().perPlayer.p1.leaked.length, 1);
});

test('unite field: two helpers (colOffset 0 / +8), carryState, per-half attribution, no layer gains', () => {
  const h = makeBattle({
    kind: 'unite',
    defs: { chess: { t_guard: guard({ stats: { atk: 1e5 } }), t_b: guard({ id: 't_b', stats: { atk: 0, maxHp: 1e6, blockCnt: 0 } }) }, enemies: { enemy_walker: walker({ hp: 100, speed: 2 }) } },
    players: [
      { playerId: 'A', seat: 0, side: 'L', colOffset: 0, units: [{ uid: 11, chessId: 't_guard', row: 9, col: 4, carryState: { hpPct: 0.4, sp: 0 } }] },
      { playerId: 'B', seat: 1, side: 'L', colOffset: 8, units: [{ uid: 21, chessId: 't_b', row: 9, col: 7 }] },
    ],
    enemies: [{ key: 'enemy_walker', route: 0, sourcePlayerId: 'A' }, { key: 'enemy_walker', route: 0, time: 0.5, sourcePlayerId: 'B' }],
    content: 'none',
  });
  h.step();
  const a = h.b.allyUnits.find((u) => u.uid === 11), b = h.b.allyUnits.find((u) => u.uid === 21);
  assert.deepEqual([a.tileR, a.tileC, a.facing], [9, 4, 1]);
  assert.deepEqual([b.tileR, b.tileC, b.facing], [9, 15, 1]);
  approx(a.hpRatio, 0.4, 1e-9);
  assert.equal(h.b.flags.layerGainsEnabled, false);
  assert.equal(h.b.addLayers('A', 'yanShip', 5), 0, 'no IN_BATTLE gains in unite');
  const r = h.runToEnd(60);
  assert.equal(r.reason, 'cleared');
  // enemies spawn on the right half (col 18) ⇒ attributed to B's half
  assert.equal(r.perPlayer.B.total, 2);
  assert.equal(r.perPlayer.B.killed, 2);
  assert.equal(r.perPlayer.A.total, 0);
  assert.ok(r.perPlayer.A.damageDealt > 0, 'A dealt the damage');
  assert.equal(r.perPlayer.A.unitsEnd[0].uid, 11);
});

test('boss field: side R is mirrored and faces left; range grid mirrored', () => {
  const sn = chessRec({ id: 't_sn', profession: 'SNIPER', subProfessionId: 'closerange', stats: { atk: 100 }, rangeGrid: [[0, 0], [0, 1], [0, 2]], skill: null });
  const h = makeBattle({
    kind: 'boss',
    defs: { chess: { t_sn: sn }, enemies: { enemy_dummy: enemyRec({ key: 'enemy_dummy', hp: 1e6, speed: 0 }) } },
    players: [
      { playerId: 'L1', side: 'L', colOffset: 0, units: [{ uid: 1, chessId: 't_sn', row: 11, col: 5 }] },
      { playerId: 'R1', side: 'R', colOffset: 8, units: [{ uid: 2, chessId: 't_sn', row: 11, col: 5 }] },
    ],
    enemies: [{ key: 'enemy_dummy', pos: [4, 13] }, { key: 'enemy_dummy', pos: [4, 7] }],
    content: 'none', autoFinish: false,
  });
  h.run(2);
  const l = h.b.allyUnits.find((u) => u.uid === 1), r = h.b.allyUnits.find((u) => u.uid === 2);
  assert.deepEqual([l.tileR, l.tileC, l.facing], [4, 5, 1]);
  assert.deepEqual([r.tileR, r.tileC, r.facing], [4, 15, -1]);
  const [e1, e2] = h.b.units.filter((u) => u.defId === 'enemy_dummy');
  assert.ok(e1.stats.taken > 0, 'right player hits (4,13) to its left');
  assert.ok(e2.stats.taken > 0, 'left player hits (4,7) to its right');
  assert.equal(e1.ownerId, 'R1');
  assert.equal(e2.ownerId, 'L1');
});

test('shared boss pool: damage routed to the pool from two battles; victory when it reaches 0', () => {
  const pool = {
    hp: 20000, maxHp: 20000, byPlayer: {},
    damage(pid, amount) { const d = Math.min(this.hp, amount); this.hp -= d; this.byPlayer[pid] = (this.byPlayer[pid] ?? 0) + d; },
  };
  const mk = (pid) => makeBattle({
    kind: 'boss', sharedBoss: pool,
    defs: { chess: { t_guard: guard({ stats: { atk: 2000, maxHp: 1e6 } }) }, enemies: { enemy_boss: enemyRec({ key: 'enemy_boss', rank: 'BOSS', hp: 999, speed: 0 }) } },
    players: [{ playerId: pid, side: 'L', units: [{ uid: 1, chessId: 't_guard', row: 10, col: 4 }] }],
    enemies: [{ key: 'enemy_boss', pos: [3, 5], tag: 'boss' }], content: 'none',
  });
  const h1 = mk('P1'), h2 = mk('P2');
  h1.step(); h2.step();
  const boss1 = h1.enemy('enemy_boss');
  assert.equal(boss1.isBoss, true);
  assert.equal(Math.round(boss1.s.maxHp), 20000);
  assert.equal(h1.b.total, 0, 'boss not counted in total');
  while (!h1.b.finished || !h2.b.finished) { h1.b.step(); h2.b.step(); if (h1.b.time > 60) break; }
  assert.equal(pool.hp, 0);
  const r1 = h1.result(), r2 = h2.result();
  assert.equal(r1.reason, 'cleared');
  assert.equal(r2.reason, 'cleared');
  assert.equal(r1.bossHpLeft, 0);
  approx(r1.perPlayer.P1.bossDamage + r2.perPlayer.P2.bossDamage, 20000, 1e-6);
  assert.ok(pool.byPlayer.P1 > 0 && pool.byPlayer.P2 > 0);
  assert.ok(h1.snapshot().boss);
});

test('boss field with a shared pool: an emptied field (leader leaked) keeps running until the pool is 0 or the match ends it', () => {
  // DESIGN §5.5: boss battles end by the pool or the match — never 'cleared' just because the field emptied.
  const mk = (pool) => makeBattle({
    kind: 'boss', sharedBoss: pool,
    defs: { enemies: { enemy_boss: enemyRec({ key: 'enemy_boss', rank: 'BOSS', hp: 999, speed: 4, lpr: 2 }) } },
    players: [{ playerId: 'P', side: 'L', units: [] }],
    enemies: [{ key: 'enemy_boss', route: 0, tag: 'boss' }], content: 'none',
  });
  const pool = new LocalBossPool(50000);
  const h = mk(pool);
  assert.ok(h.runUntil(() => h.hooks.enemyLeak.length > 0, 60), 'the leader walks into the objective');
  h.run(300);
  assert.equal(h.b.finished, false, 'no "cleared" while the pool is above 0');
  assert.equal(h.b.enemies.length, 0);
  pool.sync(0, 0);   // another field emptied the shared pool
  h.step();
  assert.equal(h.result().reason, 'cleared');
  const h2 = mk(new LocalBossPool(50000));
  h2.run(60);
  h2.b.forceEnd('forced'); // team LP 0 (overtime drain)
  const r = h2.result();
  assert.equal(r.reason, 'forced');
  assert.deepEqual(r.perPlayer.P.leaked.map((l) => [l.enemyKey, l.lpr, l.boss]), [['enemy_boss', 2, true]]);
  // without a shared pool (sandboxes, tools) a boss-kind battle still ends when it empties
  const h3 = mk(null);
  assert.equal(h3.runToEnd(120).reason, 'cleared');
});

test('Final Assault h07_04 (pair): 昆图斯 walking into the objective does not end the field while the pool is full', { skip: !hasGeneratedData() && 'no generated data' }, () => {
  // Regression: the official pair route of the leader has no wait step; with nobody blocking him he leaked at ~180 s
  // and the field used to finish 'cleared' at once, ending the Final Assault as a defeat with team LP left.
  // Officially he is 自缚 (PRTS 天赋; content/bosses.js SELF_BOUND, user playtest #5) and never walks it — the engine
  // rule is still checked by lifting the 自缚 buff.
  const pool = new LocalBossPool(708750);
  const opts = { kind: 'boss', stageId: 'act2autochess_m02', rect: { r0: 0, r1: 5, c0: 0, c1: 20 }, waveTemplate: 'act1autochess_h07_04', sharedBoss: pool, units: [] };
  const bound = makeBattle({ ...opts, sharedBoss: new LocalBossPool(708750) });
  bound.run(400);
  assert.ok(!bound.hooks.enemyLeak.some((x) => x.enemy.defId === 'enemy_1521_dslily'), '自缚: he stays');
  assert.equal(bound.b.finished, false);
  const h = makeBattle(opts);
  assert.ok(h.runUntil(() => h.b.enemies.some((e) => e.defId === 'enemy_1521_dslily'), 5));
  for (const e of h.b.enemies) if (e.defId === 'enemy_1521_dslily') h.b.removeBuff(e, 'boss:selfBound');
  assert.ok(h.runUntil(() => h.hooks.enemyLeak.some((x) => x.enemy.defId === 'enemy_1521_dslily'), 400), 'the leader leaks');
  h.run(200);
  assert.equal(h.b.finished, false);
  assert.equal(pool.hp, 708750);
  h.b.forceEnd('forced');
  assert.equal(h.result().reason, 'forced');
});

test('boss battles: infinite time limit, leaks carry lpr, match ends via forceEnd', () => {
  const h = makeBattle({
    kind: 'boss',
    defs: { enemies: { enemy_walker: walker({ speed: 4, lpr: 3 }), enemy_boss: enemyRec({ key: 'enemy_boss', hp: 1e9, speed: 0 }) } },
    players: [{ playerId: 'P', side: 'L', units: [] }],
    enemies: [{ key: 'enemy_walker', route: 0 }, { key: 'enemy_boss', pos: [3, 9], tag: 'boss' }], content: 'none',
  });
  h.run(200);
  assert.equal(h.b.finished, false);
  assert.equal(h.b.timeLimit, Infinity);
  h.b.forceEnd('forced');
  const r = h.result();
  assert.equal(r.reason, 'forced');
  assert.equal(r.perPlayer.P.leaked[0].lpr, 3);
});

test('snapshot / event wire format (DESIGN §8.2)', () => {
  const h = makeBattle({
    defs: { chess: { t_guard: guard({ stats: { atk: 100, maxHp: 5000 } }) }, enemies: { enemy_walker: walker({ atk: 100, hp: 3000 }), enemy_fly: enemyRec({ key: 'enemy_fly', hp: 500, speed: 3, motion: 'FLY' }) } },
    units: [{ chessId: 't_guard', row: 9, col: 5 }],
    enemies: [{ key: 'enemy_walker' }, { key: 'enemy_fly', route: 2 }], content: 'generic', fieldId: 'n:p1',
  });
  h.run(10.5); // walker (0.5 tiles/s) reaches the guard at ~9 s
  const snap = h.snapshot();
  assert.deepEqual(Object.keys(snap).slice(0, 6), ['fieldId', 't', 'units', 'dp', 'killed', 'total']);
  assert.equal(snap.fieldId, 'n:p1');
  for (const u of snap.units) {
    assert.equal(u.length, 9);
    const [id, x, y, hp, maxHp, sp, spMax, flags, anim] = u;
    assert.ok(Number.isInteger(id) && Number.isInteger(hp) && Number.isInteger(maxHp) && Number.isInteger(flags) && Number.isInteger(anim));
    for (const v of [x, y, sp, spMax]) assert.ok(Number.isFinite(v));
    assert.ok(Object.values(ANIM).includes(anim));
    assert.ok(hp <= maxHp);
  }
  const g = snap.units.find((u) => u[0] === h.unit('t_guard').id);
  assert.ok(g[7] & UF.BLOCKED, 'guard is blocking');
  const allEv = h.events;
  const kinds = new Set(Object.values(EV));
  for (const ev of allEv) assert.ok(kinds.has(ev[0]), `known event ${ev[0]}`);
  const spawn = allEv.find((e) => e[0] === 'spawn');
  assert.deepEqual(Object.keys(spawn[1]).filter((k) => spawn[1][k] !== undefined).slice(0, 15).sort(),
    ['avatar', 'defId', 'dir', 'facing', 'golden', 'id', 'kind', 'maxHp', 'name', 'ownerId', 'side', 'spine', 'tier', 'x', 'y'].sort());
  assert.ok(['UP', 'RIGHT', 'DOWN', 'LEFT'].includes(spawn[1].dir), 'UnitInfo.dir is a direction');
  const atk = allEv.find((e) => e[0] === 'atk');
  assert.equal(atk.length, 4);
  const dmg = allEv.find((e) => e[0] === 'dmg');
  assert.equal(dmg.length, 4);
  assert.ok(['phys', 'arts', 'true', 'burn', 'neural', 'necrosis', 'apoptosis'].includes(dmg[3]));
  const flyInSnap = h.b.units.find((u) => u.defId === 'enemy_fly');
  if (flyInSnap.alive) assert.ok(snap.units.find((u) => u[0] === flyInSnap.id)[7] & UF.FLYING);
  assert.deepEqual(h.b.drainEvents(), [], 'drained');
  const meta = h.b.fieldMeta();
  assert.equal(meta.kind, 'normal');
  assert.ok(Array.isArray(meta.units));
  JSON.stringify(snap); // serialisable
});

test('determinism: same seed ⇒ identical result and event stream; different seed may differ', () => {
  const ds = getDefaultSource();
  const tpl = ds.getWave('act1autochess_05');
  const run = (seed) => {
    const { routes, spawns, maxPlayTime } = spawnsFromTemplate(tpl);
    const b = new Battle({
      seed, kind: 'normal', stageId: 'act2autochess_m03', timeLimit: maxPlayTime, routes, spawns, logger: { error() {}, warn() {} },
      players: [{ playerId: 'p', units: [
        { uid: 1, chessId: 'chess_char_1_02_a', row: 9, col: 7 }, { uid: 2, chessId: 'chess_char_1_01_a', row: 10, col: 5 },
        { uid: 3, chessId: 'chess_char_4_09_a', row: 12, col: 6 }, { uid: 4, chessId: 'chess_char_2_02_a', row: 11, col: 5 },
        { uid: 5, chessId: 'chess_char_3_08_a', row: 10, col: 6 },
      ] }],
    });
    const ev = [];
    while (!b.finished) { b.step(); if (b.tickCount % 3 === 0) ev.push(b.snapshot()); ev.push(b.drainEvents()); }
    return { res: hashOf(b.result()), ev: hashOf(ev) };
  };
  const a = run(1234), b = run(1234);
  assert.deepEqual(a, b);
});

test('robustness: throwing content handlers / kits never crash the battle', () => {
  const h = makeBattle({
    defs: { chess: { t_guard: guard({ stats: { atk: 2000 } }) }, enemies: { enemy_walker: walker({ hp: 2000 }) } },
    units: [{ chessId: 't_guard', row: 9, col: 5 }],
    enemies: [{ key: 'enemy_walker', count: 3, interval: 1 }],
    kits: { t_guard: () => { throw new Error('bad kit'); } },
    setup: (b) => {
      b.on('hit', () => { throw new Error('bad hit handler'); });
      b.on('tick', () => { throw new Error('bad tick handler'); });
      b.after(1, () => { throw new Error('bad timer'); });
      b.addBuff(b.allyUnits[0], { key: 'x', onTick: () => { throw new Error('bad buff'); } });
    },
  });
  const r = h.runToEnd(60);
  assert.equal(r.reason, 'cleared');
  assert.ok(h.b.errorCount > 0);
  assert.ok(h.b.errors.some((e) => /bad kit/.test(e.message)));
  assert.ok(h.b.errors.length < 20, 'errors are logged once per key');
  checkInvariants(h.b);
});

test('hook bus: priority order, owner removal, once, off by handle', () => {
  const h = makeBattle({ content: 'none' });
  const order = [];
  const owner = {};
  h.b.on('custom', () => order.push('p0'));
  h.b.on('custom', () => order.push('p10'), { priority: 10 });
  h.b.on('custom', () => order.push('p0b'));
  h.b.on('custom', () => order.push('owned'), { owner });
  const once = h.b.on('custom', () => order.push('once'), { once: true, priority: 5 });
  h.b.emit('custom', {});
  assert.deepEqual(order, ['p10', 'once', 'p0', 'p0b', 'owned']);
  order.length = 0;
  h.b.offOwner(owner);
  h.b.emit('custom', {});
  assert.deepEqual(order, ['p10', 'p0', 'p0b']);
  assert.ok(once.removed);
});

test('scheduling: after / every with cancel', () => {
  const h = makeBattle({ content: 'none' });
  let a = 0, e = 0;
  h.b.after(1, () => a++);
  const ev = h.b.every(0.5, () => e++);
  h.run(2.01);
  assert.equal(a, 1);
  assert.equal(e, 4);
  ev.cancel();
  h.run(2);
  assert.equal(e, 4);
});

test('layers & coins: addLayers records gains (normal field) and emits client events', () => {
  const h = makeBattle({ content: 'none', bonds: { yanShip: { count: 3, active: true, tier: 1, layers: 10 } } });
  h.step();
  assert.equal(h.b.addLayers('p1', 'yanShip', 3, 'test'), 3);
  assert.equal(h.b.getPlayer('p1').bonds.yanShip.layers, 13);
  h.b.addCoins('p1', 2);
  h.b.forceEnd('forced');
  const r = h.result();
  assert.deepEqual(r.perPlayer.p1.layerGains, { yanShip: 3 });
  assert.equal(r.perPlayer.p1.coins, 2);
  assert.ok(h.eventsOf('layer').some((e) => e[1] === 'p1' && e[2] === 'yanShip' && e[3] === 3));
  const h2 = makeBattle({ content: 'none', flags: { layerGainsEnabled: false } });
  assert.equal(h2.b.addLayers('p1', 'yanShip', 3), 0);
});

test('layers: an IN_BATTLE gain stops at BOND_LAYER_CAP (999, MAX_GARRISON_STACK) — the battle\'s count and the reported gain', () => {
  assert.equal(BOND_LAYER_CAP, 999);
  const h = makeBattle({ content: 'none', bonds: { yanShip: { count: 3, active: true, tier: 1, layers: 995 } } });
  h.step();
  assert.equal(h.b.addLayers('p1', 'yanShip', 3, 'test'), 3);
  assert.equal(h.b.addLayers('p1', 'yanShip', 5, 'test'), 1, 'only the room left under the cap');
  assert.equal(h.b.addLayers('p1', 'yanShip', 5, 'test'), 0, 'at the cap: nothing');
  assert.equal(h.b.getPlayer('p1').bonds.yanShip.layers, 999);
  h.b.forceEnd('forced');
  assert.deepEqual(h.result().perPlayer.p1.layerGains, { yanShip: 4 });
  assert.deepEqual(h.eventsOf('layer').map((e) => e[3]), [3, 1], 'the client sees what was added');
});

test('tokens: spawnToken deploys a token next to its owner; manual token pieces deploy from input', () => {
  const ds = getDefaultSource();
  const h = makeBattle({
    units: [{ chessId: 'chess_char_2_02_a', row: 10, col: 4, uid: 7 }, { kind: 'token', tokenId: 'token_10000_silent_healrb', ownerUid: 7, row: 10, col: 5, uid: 8 }],
    content: 'generic',
  });
  h.step();
  const tok = h.b.allyUnits.find((u) => u.kind === 'token');
  assert.ok(tok && tok.alive);
  assert.ok(tok.s.flags.untargetable, '医疗探机 cannot be attacked');
  assert.equal(tok.profile.dmgType, 'heal');
  const t2 = h.b.spawnToken(h.unit(7), 'token_10000_silent_healrb', 11, 4, { duration: 1 });
  assert.ok(t2 && t2.alive);
  h.run(1.1);
  assert.equal(t2.alive, false, 'expired');
  assert.ok(ds.getToken('token_10000_silent_healrb', 'chess_char_2_02_b').stats.atk > ds.getToken('token_10000_silent_healrb', 'chess_char_2_02_a').stats.atk);
});

test('displacement helper moves enemies along passable tiles and re-paths', () => {
  const h = makeBattle({ defs: { enemies: { enemy_walker: walker({ speed: 0.01 }) } }, enemies: [{ key: 'enemy_walker', pos: [10, 6] }], content: 'none', autoFinish: false });
  h.step();
  const e = h.enemy('enemy_walker');
  const moved = h.b.displace(e, { x: 1, y: 0 }, 2, { force: 1 });
  assert.ok(moved > 1.8);
  approx(Math.round(e.x), 8);
  const blocked = h.b.displace(e, { x: 0, y: 1 }, 5);
  assert.ok(e.y <= 12.5);
  assert.ok(blocked <= 3);
});

test('content modules: a throwing install() is logged and skipped; units outside the rect are not deployed', () => {
  let ran = false;
  const h = makeBattle({
    defs: { chess: { t_guard: guard() }, enemies: { enemy_walker: walker({ hp: 100 }) } },
    units: [{ chessId: 't_guard', row: 9, col: 5 }, { chessId: 't_guard', row: 3, col: 5, abs: true }],
    enemies: [{ key: 'enemy_walker' }],
    extraContent: [{ install() { throw new Error('broken module'); } }, { install(b) { b.on('battleStart', () => { ran = true; }); } }],
  });
  const r = h.runToEnd(60);
  assert.equal(ran, true, 'later modules still installed');
  assert.ok(h.b.errors.some((e) => /broken module/.test(e.message)));
  assert.equal(h.b.allyUnits.filter((u) => u.deployed || u.alive).length, 1);
  assert.equal(r.reason, 'cleared');
  checkInvariants(h.b);
});

test('core raw 01 slime fragment preserves map, route flags and stats; spawns at tick left edges 90 and 240', () => {
  const { rawLevel, level, spec, omittedActions, inactiveBranches } = slimeMovementFragment();
  assert.equal(spec.map, level.map);
  assert.equal(spec.map.rows, rawLevel.mapData.map.length);
  assert.equal(spec.map.columns, rawLevel.mapData.map[0].length);
  assert.deepEqual(spec.schedule.spawns.map(spawn => spawn.tick), [90, 240]);
  assert.equal(spec.schedule.spawns[0].route, level.routes[0]);
  assert.equal(spec.schedule.spawns[1].route, level.routes[0]);
  assert.equal(spec.schedule.spawns[0].route.visitEveryCheckPoint, false);
  assert.equal(spec.schedule.spawns[0].alwaysCheckCurrentPoint, false);
  assert.deepEqual(spec.schedule.spawns[0].route.checkpoints, []);
  assert.equal(spec.schedule.spawns[0].definition.vitality.maxHp, 550);
  assert.equal(spec.schedule.spawns[0].definition.locomotion.moveSpeedPerTick, 1 / 30);
  assert.equal(spec.moveMultiplier, 0.5);
  assert.equal(spec.maxTicks, 1350);
  assert.deepEqual(omittedActions, ['waves[0].fragments[0].actions[1]', 'waves[0].fragments[0].actions[2]']);
  assert.deepEqual(inactiveBranches, ['dragon']);
  const runtime = new BattleRuntime(spec);
  const expectedRng = createRng(123);
  while (runtime.snapshot().tickIndex < 90) assert.deepEqual(runtime.step().events, []);
  assert.equal(runtime.snapshot().tickIndex, 90);
  assert.deepEqual(runtime.snapshot().units, []);
  const firstStep = runtime.step();
  assert.deepEqual(firstStep.events, [{ type: 'ENEMY_SPAWNED', unitId: 0, tick: 90 }]);
  expectedRng.next();
  expectedRng.next();
  const first = runtime.snapshot();
  assert.equal(first.spawning.cursor, 1);
  assert.equal(first.spawning.spawnedCount, 1);
  assert.deepEqual(first.spawning.managedFinalUnitIds, [0]);
  assert.deepEqual(first.execution, { rngState: expectedRng.state(), nextUnitId: 1, nextNavigationRequestId: 1, nextMechanismId: 0, nextSpatialEffectId: 0 });
  assert.equal(first.units[0].vitality.hp, 550);
  assert.equal(first.units[0].locomotion.mainRoute.route.progress.move.navigationRequestId, 0);
  assert.deepEqual(first.units[0].locomotion.mainRoute.route.timing, { waveStartedAtTick: 0, fragmentStartedAtTick: 0 });
  assert.equal(first.units[0].position[1], 9);
  approx(10 - first.units[0].position[0], 0.5 * 10 / TICKS_PER_SECOND ** 2);
  while (runtime.snapshot().tickIndex < 240) runtime.step();
  assert.equal(runtime.snapshot().tickIndex, 240);
  assert.deepEqual(runtime.snapshot().units.map(unit => unit.id), [0]);
  const secondStep = runtime.step();
  assert.deepEqual(secondStep.events, [{ type: 'ENEMY_SPAWNED', unitId: 1, tick: 240 }]);
  expectedRng.next();
  expectedRng.next();
  const second = runtime.snapshot();
  assert.equal(second.spawning.cursor, 2);
  assert.equal(second.spawning.spawnedCount, 2);
  assert.deepEqual(second.spawning.managedFinalUnitIds, [0, 1]);
  assert.deepEqual(second.execution, { rngState: expectedRng.state(), nextUnitId: 2, nextNavigationRequestId: 2, nextMechanismId: 0, nextSpatialEffectId: 0 });
  assert.deepEqual(second.units.map(unit => unit.locomotion.mainRoute.route.progress.move.navigationRequestId), [0, 1]);
  assert.deepEqual(second.units.map(unit => unit.locomotion.mainRoute.route.timing), [
    { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
    { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
  ]);
  const { spec: forceLimited } = slimeMovementFragment(rawLevel, [0], createSteeringParameters({
    steeringFactor: 100 / 30, maxSteeringForce: 0.3 / 900,
  }));
  const forceRuntime = new BattleRuntime(withTimelineSpawns(forceLimited, [{ ...forceLimited.schedule.spawns[0], tick: 0 }]));
  forceRuntime.step();
  approx(10 - forceRuntime.snapshot().units[0].position[0], 1 / 3000);
});

test('core raw 01 movement fragment replays every tick and completes routes with SCRIPT removals', () => {
  const { spec } = slimeMovementFragment();
  const first = new BattleRuntime(spec);
  const second = new BattleRuntime(spec);
  const events = [];
  const tickBudget = spec.maxTicks;
  for (let tick = 0; tick < tickBudget && first.result === null; tick++) {
    assert.deepEqual(first.snapshot(), second.snapshot());
    const step = first.step();
    assert.deepEqual(step, second.step());
    events.push(...step.events);
  }
  assert.deepEqual(first.snapshot(), second.snapshot());
  assert.equal(first.result.reason, 'SCHEDULE_COMPLETED');
  assert.equal(first.result.spawnedCount, 2);
  assert.equal(first.result.completedRouteCount, 2);
  assert.equal(first.result.unspawnedCount, 0);
  assert.deepEqual(first.result.remainingUnitIds, []);
  assert.equal(Object.hasOwn(first.result, 'killed'), false);
  assert.deepEqual(first.snapshot().units, []);
  assert.deepEqual(events.filter(event => event.type === 'ROUTE_COMPLETED').map(event => event.unitId), [0, 1]);
  assert.deepEqual(events.filter(event => event.type === 'UNIT_REMOVED').map(event => [event.unitId, event.reason]), [[0, 'SCRIPT'], [1, 'SCRIPT']]);
  assert.deepEqual(events.filter(event => event.type === 'NAVIGATION' && event.outcome.type === 'ARRIVED').map(event => event.outcome.requestId), [0, 1]);
  assert.deepEqual(simulateBattle(spec), first.result);
  const finished = first.snapshot();
  assert.deepEqual(first.step(), { events: [], result: first.result });
  assert.deepEqual(first.snapshot(), finished);
});

test('core battle snapshots isolate vitality, locomotion, route progress, navigation and counters', () => {
  const { spec } = slimeMovementFragment();
  const inputTiming = { ...spec.schedule.spawns[0].timing };
  const isolated = createBattleSpec(withTimelineSpawns(spec, [{ ...spec.schedule.spawns[0], timing: inputTiming }]));
  inputTiming.fragmentStartedAtTick = 99;
  assert.equal(isolated.schedule.spawns[0].timing.fragmentStartedAtTick, 0);
  const runtime = new BattleRuntime(spec);
  while (runtime.snapshot().tickIndex < 91) runtime.step();
  const before = runtime.snapshot();
  const snapshot = runtime.snapshot();
  const unit = snapshot.units[0];
  unit.vitality.hp = 1;
  unit.locomotion.moving = false;
  unit.locomotion.steering.lastVelocity = [100, 100];
  unit.locomotion.mainRoute.route.progress.move.navigationRequestId = 99;
  unit.locomotion.mainRoute.navigation.pathMotionMode = 'FLY';
  unit.locomotion.mainRoute.navigation.execution.visits.visitedCenters.push([99, 99]);
  unit.locomotion.mainRoute.navigation.execution.activity.cursor = { type: 'GOAL' };
  snapshot.spawning.cursor = 99;
  snapshot.spawning.managedFinalUnitIds.push(99);
  snapshot.execution.rngState = 99;
  snapshot.execution.nextUnitId = 99;
  snapshot.execution.nextNavigationRequestId = 99;
  snapshot.units.push(unit);
  snapshot.completedRouteCount = 99;
  snapshot.tickIndex = 99;
  assert.throws(() => { unit.position[0] = 99; }, TypeError);
  assert.throws(() => { unit.definition.vitality.maxHp = 99; }, TypeError);
  assert.throws(() => { unit.locomotion.mainRoute.route.timing.fragmentStartedAtTick = 99; }, TypeError);
  assert.deepEqual(runtime.snapshot(), before);
  const replica = new BattleRuntime(spec);
  while (replica.snapshot().tickIndex < 91) replica.step();
  assert.deepEqual(runtime.step(), replica.step());
  assert.deepEqual(runtime.snapshot(), replica.snapshot());
});

test('core battle initializes all route waits at the birth tick and replays their exact completion edges', () => {
  const { spec } = slimeMovementFragment();
  const spawn = spec.schedule.spawns[0];
  const definition = createEnemyDefinition({ ...spawn.definition,
    locomotion: { ...spawn.definition.locomotion, moveSpeedPerTick: 0 },
  });
  const cases = [
    [{ type: 'WAIT_FOR_TICKS', durationTicks: 3 }, 7],
    [{ type: 'WAIT_FOR_PLAY_TICK', targetPlayTick: 10 }, 10],
    [{ type: 'WAIT_CURRENT_WAVE_TICKS', targetElapsedTicks: 10 }, 12],
    [{ type: 'WAIT_CURRENT_FRAGMENT_TICKS', targetElapsedTicks: 10 }, 13],
  ];
  for (const [checkpoint, deadline] of cases) {
    const route = createRouteDefinition({ ...spawn.route, visitEveryCheckPoint: true, checkpoints: [checkpoint] });
    const input = { ...withTimelineSpawns(spec, [{ ...spawn, definition, route, alwaysCheckCurrentPoint: true,
      tick: 5, timing: { waveStartedAtTick: 2, fragmentStartedAtTick: 3 },
    }]), maxTicks: deadline + 1 };
    const runtime = new BattleRuntime(input), replay = new BattleRuntime(input);
    while (runtime.result === null) {
      const tick = runtime.snapshot().tickIndex;
      assert.deepEqual(runtime.step(), replay.step());
      const snapshot = runtime.snapshot();
      assert.deepEqual(snapshot, replay.snapshot());
      if (tick < 5) {
        assert.deepEqual(snapshot.units, []);
        continue;
      }
      const unit = snapshot.units[0], progress = unit.locomotion.mainRoute.route.progress;
      assert.deepEqual(unit.locomotion.mainRoute.route.timing, { waveStartedAtTick: 2, fragmentStartedAtTick: 3 });
      assert.deepEqual(unit.position, [10, 9]);
      if (tick < deadline) {
        assert.equal(progress.phase, 'CHECKPOINTS');
        assert.equal(progress.checkpoint.remainingTicks, deadline - tick);
        assert.equal(snapshot.execution.nextNavigationRequestId, 0);
      } else {
        assert.equal(progress.phase, 'END');
        assert.equal(progress.move.navigationRequestId, 0);
        assert.equal(snapshot.execution.nextNavigationRequestId, 1);
      }
    }
    assert.equal(runtime.result.reason, 'TIME_LIMIT');
    assert.equal(runtime.result.completedRouteCount, 0);
    assert.deepEqual(runtime.snapshot().spawning.managedFinalUnitIds, [0]);
  }
});

test('core route absolute waits retain birth timing after the scheduler enters a later wave', () => {
  const { spec } = slimeMovementFragment();
  for (const [type, deadline] of [['WAIT_CURRENT_WAVE_TICKS', 8], ['WAIT_CURRENT_FRAGMENT_TICKS', 13]]) {
    const { schedule } = syntheticSpawnSchedule([
      nativeWave([nativeFragment([nativeSpawn({ dontBlockWave: true })], 3 / 30)], { preDelay: 2 / 30 }),
      nativeWave([nativeFragment([nativeSpawn({ preDelay: 10 / 30 })])], { preDelay: 2 / 30 }),
    ]);
    const firstWave = schedule.waves[0], fragment = firstWave.fragments[0], action = fragment.actions[0];
    const route = createRouteDefinition({ ...action.spawn.route, visitEveryCheckPoint: true,
      checkpoints: [{ type, targetElapsedTicks: 8 }],
    });
    const definition = createEnemyDefinition({ ...action.spawn.definition,
      locomotion: { ...action.spawn.definition.locomotion, moveSpeedPerTick: 0 },
    });
    const runtime = new BattleRuntime({ ...spec, maxTicks: 16, schedule: { ...schedule, waves: [
      { ...firstWave, fragments: [{ ...fragment, actions: [{ ...action,
        spawn: { ...action.spawn, definition, route, alwaysCheckCurrentPoint: true },
      }] }] }, schedule.waves[1],
    ] } });
    while (runtime.snapshot().tickIndex <= deadline) {
      const tick = runtime.snapshot().tickIndex;
      runtime.step();
      if (tick < 5) continue;
      const snapshot = runtime.snapshot(), state = snapshot.units[0].locomotion.mainRoute.route;
      assert.equal(snapshot.spawning.waveIndex, 1);
      assert.equal(snapshot.spawning.waveStartedAtTick, 5);
      assert.equal(snapshot.spawning.fragmentStartedAtTick, tick < 7 ? 5 : 7);
      assert.deepEqual(state.timing, { waveStartedAtTick: 0, fragmentStartedAtTick: 5 });
      if (tick < deadline) {
        assert.equal(state.progress.checkpoint.remainingTicks, deadline - tick);
      } else {
        assert.equal(state.progress.phase, 'END');
      }
    }
    assert.deepEqual(runtime.snapshot().spawning.managedFinalUnitIds, [0]);
  }
});

test('core patrol stays registered and pending in the spawn schedule through deterministic loop reentries', () => {
  const { spec } = slimeMovementFragment();
  const spawn = spec.schedule.spawns[0];
  const route = createRouteDefinition({ ...spawn.route, visitEveryCheckPoint: true, checkpoints: [10, 9].map(column => ({
    type: 'PATROL_MOVE', target: { position: [9, column], reachOffset: [0, 0], randomizeReachOffset: false, reachDistance: 0 },
  })) });
  const definition = createEnemyDefinition({ ...spawn.definition,
    locomotion: { ...spawn.definition.locomotion, moveSpeedPerTick: 4 },
  });
  const input = { ...withTimelineSpawns(spec, [{ ...spawn, tick: 0, definition, route, alwaysCheckCurrentPoint: true }]), maxTicks: 24 };
  const runtime = new BattleRuntime(input), replay = new BattleRuntime(input), events = [];
  while (runtime.result === null) {
    const step = runtime.step();
    assert.deepEqual(step, replay.step());
    events.push(...step.events);
    const snapshot = runtime.snapshot();
    assert.deepEqual(snapshot, replay.snapshot());
    assert.deepEqual(snapshot.spawning.managedFinalUnitIds, [0]);
    assert.equal(snapshot.units[0].locomotion.mainRoute.route.progress.phase, 'CHECKPOINTS');
  }
  assert.deepEqual(runtime.result, {
    reason: 'TIME_LIMIT', elapsedTicks: 24, spawnedCount: 1, completedRouteCount: 0, remainingUnitIds: [0], unspawnedCount: 0,
  });
  assert.deepEqual(events.filter(event => event.type === 'ROUTE_COMPLETED' || event.type === 'UNIT_REMOVED'), []);
  assert.ok(runtime.snapshot().execution.nextNavigationRequestId > 4);
});

test('core absolute wait overflow rolls back same-tick spawns, expiry, identities and RNG', () => {
  const { spec } = slimeMovementFragment();
  const spawn = spec.schedule.spawns[0];
  const route = createRouteDefinition({ ...spawn.route, visitEveryCheckPoint: true, checkpoints: [
    { type: 'WAIT_FOR_TICKS', durationTicks: 1 },
    { type: 'WAIT_CURRENT_WAVE_TICKS', targetElapsedTicks: Number.MAX_SAFE_INTEGER },
  ] });
  const mechanism = createMechanismRuntime({ id: 0, definition: createMechanismDefinition({ id: 'wait-expiry' }), active: true });
  const effect = createNavigationSpatialEffect({
    id: 0, definition: createNavigationEffectDefinition({ id: 'wait-expiry',
      WALK: { denyPassage: false, deniedDepartures: [], costFloor: 2 }, FLY: null,
    }), source: { type: 'MECHANISM', mechanismId: 0 }, active: true,
    region: createSpatialEffectRegion({ type: 'FIXED', position: [9, 6], range: [[0, 0]], direction: 'RIGHT' }),
    expiresAtTick: 5,
  });
  const runtime = new BattleRuntime({ ...withTimelineSpawns(spec, [
    { ...spawn, tick: 5 },
    { ...spawn, tick: 5, route, alwaysCheckCurrentPoint: true, timing: { waveStartedAtTick: 2, fragmentStartedAtTick: 3 } },
  ]), initialMechanisms: [mechanism], initialEffects: [effect] });
  while (runtime.snapshot().tickIndex < 5) runtime.step();
  const before = runtime.snapshot(), maps = runtime.navigationMaps;
  for (let retry = 0; retry < 2; retry++) {
    assert.throws(() => runtime.step(), /route wait target tick overflow/);
    assert.deepEqual(runtime.snapshot(), before);
    assert.equal(runtime.navigationMaps, maps);
  }
});

test('core instant route signals retain identity and scheduler ownership through disappearance and appearance', () => {
  const input = routeCommandBattle([
    { type: 'DISAPPEAR' }, { type: 'WAIT_FOR_TICKS', durationTicks: 3 }, { type: 'ALERT' },
    { type: 'APPEAR_AT_POS', position: [9, 5], reachOffset: [0.25, 0] },
    { type: 'WAIT_FOR_TICKS', durationTicks: 30 },
  ]);
  const runtime = new BattleRuntime(input), replay = new BattleRuntime(input), events = [];
  let appeared = false, observedHidden = false;
  while (runtime.result === null) {
    const step = runtime.step();
    assert.deepEqual(step, replay.step());
    assert.deepEqual(runtime.snapshot(), replay.snapshot());
    events.push(...step.events);
    const snapshot = runtime.snapshot(), unit = snapshot.units[0];
    assert.equal(unit.id, 0);
    assert.equal(unit.vitality.hp, 550);
    assert.deepEqual(snapshot.spawning.managedFinalUnitIds, [0]);
    if (step.events.some(event => event.type === 'ROUTE' && event.signal.type === 'APPEAR_AT_POS')) appeared = true;
    if (appeared) {
      assert.equal(unit.spatialPresence.present, true);
      assert.deepEqual(unit.position, [5.25, 9]);
    } else {
      assert.equal(unit.spatialPresence.present, false);
      observedHidden = true;
    }
  }
  const signals = events.filter(event => event.type === 'ROUTE');
  assert.equal(observedHidden, true);
  assert.equal(appeared, true);
  assert.deepEqual(signals.map(event => event.signal.type), ['DISAPPEAR', 'ALERT', 'APPEAR_AT_POS']);
  assert.deepEqual(signals.map(event => event.position), [[10, 9], [10, 9], [5.25, 9]]);
  assert.deepEqual(events.slice(0, 2).map(event => event.type), ['ENEMY_SPAWNED', 'ROUTE']);
  assert.deepEqual(events.filter(event => event.type === 'ROUTE_COMPLETED' || event.type === 'UNIT_REMOVED'), []);
  assert.equal(runtime.result.reason, 'TIME_LIMIT');
  assert.equal(runtime.result.completedRouteCount, 0);
  assert.deepEqual(runtime.result.remainingUnitIds, [0]);
});

test('core birth and same-tick route signals record each instruction position rather than the final pose', () => {
  const runtime = new BattleRuntime(routeCommandBattle([
    { type: 'ALERT' }, { type: 'APPEAR_AT_POS', position: [9, 6], reachOffset: [-0.25, 0] },
    { type: 'DISAPPEAR' }, { type: 'WAIT_FOR_TICKS', durationTicks: 30 },
  ]));
  const first = runtime.step();
  assert.deepEqual(first.events.filter(event => event.type === 'ROUTE').map(event => ({
    signal: event.signal.type, position: event.position, tick: event.tick, unitId: event.unitId,
  })), [
    { signal: 'ALERT', position: [10, 9], tick: 0, unitId: 0 },
    { signal: 'APPEAR_AT_POS', position: [5.75, 9], tick: 0, unitId: 0 },
    { signal: 'DISAPPEAR', position: [5.75, 9], tick: 0, unitId: 0 },
  ]);
  assert.equal(runtime.snapshot().units[0].spatialPresence.present, false);
  assert.deepEqual(runtime.snapshot().units[0].position, [5.75, 9]);
  assert.deepEqual(runtime.step().events.filter(event => event.type === 'ROUTE'), []);
});

test('core alternative route commands preserve resolved main targets, continue main waits and isolate snapshots', () => {
  const waiting = new BattleRuntime(routeCommandBattle([{ type: 'WAIT_FOR_TICKS', durationTicks: 12 }]));
  waiting.step();
  const waitRoute = createRouteDefinition({ ...waiting.snapshot().units[0].locomotion.mainRoute.route.definition,
    checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: 30 }] });
  waiting.step([{ type: 'SET_ALTERNATIVE_ROUTE', unitId: 0, route: waitRoute, alwaysCheckCurrentPoint: true }]);
  const active = waiting.snapshot().units[0];
  assert.equal(active.locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 10);
  assert.equal(active.locomotion.alternativeRoute.route.progress.checkpoint.remainingTicks, 29);
  const snapshot = waiting.snapshot();
  snapshot.units[0].locomotion.alternativeRoute.route.progress.checkpoint.remainingTicks = 999;
  snapshot.units[0].spatialPresence.present = false;
  assert.deepEqual(waiting.snapshot().units[0], active);
  waiting.step();
  assert.equal(waiting.snapshot().units[0].locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 9);
  waiting.step([{ type: 'CLEAR_ALTERNATIVE_ROUTE', unitId: 0 }]);
  assert.equal(waiting.snapshot().units[0].locomotion.alternativeRoute, null);
  assert.equal(waiting.snapshot().units[0].locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 8);

  const input = routeCommandBattle([{ type: 'MOVE', target: {
    position: [9, 8], reachOffset: [0.25, 0], randomizeReachOffset: true, reachDistance: 0,
  } }]);
  const runtime = new BattleRuntime(input), replay = new BattleRuntime(input);
  assert.deepEqual(runtime.step(), replay.step());
  const main = runtime.snapshot().units[0].locomotion.mainRoute;
  const originalRng = runtime.snapshot().execution.rngState;
  const route = createRouteDefinition({ ...main.route.definition, startPosition: [100, 100], endPosition: [9, 10],
    spawnOffset: [100, 100], spawnRandomRange: [100, 100],
    checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: 3 }] });
  for (let tick = 1; tick < 10; tick++) {
    const commands = tick === 1 ? [{ type: 'SET_ALTERNATIVE_ROUTE', unitId: 0, route, alwaysCheckCurrentPoint: true }] : [];
    assert.deepEqual(runtime.step(commands), replay.step(commands));
    assert.deepEqual(runtime.snapshot(), replay.snapshot());
    const unit = runtime.snapshot().units[0];
    assert.deepEqual(unit.locomotion.mainRoute.route.progress, main.route.progress);
    assert.deepEqual(unit.position, [10, 9]);
    assert.equal(runtime.snapshot().execution.rngState, originalRng);
  }
  assert.equal(runtime.snapshot().units[0].locomotion.alternativeRoute.route.progress.phase, 'COMPLETED');
  const clear = [{ type: 'CLEAR_ALTERNATIVE_ROUTE', unitId: 0 }];
  assert.deepEqual(runtime.step(clear), replay.step(clear));
  assert.deepEqual(runtime.snapshot(), replay.snapshot());
  assert.equal(runtime.snapshot().units[0].locomotion.alternativeRoute, null);
  assert.deepEqual(runtime.snapshot().units[0].locomotion.mainRoute.route.progress, main.route.progress);
});

test('core alternative route commands preserve hidden presence and emit ordered one-time teleport signals', () => {
  const runtime = new BattleRuntime(routeCommandBattle([
    { type: 'DISAPPEAR' }, { type: 'WAIT_FOR_TICKS', durationTicks: 30 },
  ]));
  runtime.step();
  assert.equal(runtime.snapshot().units[0].spatialPresence.present, false);
  const main = runtime.snapshot().units[0].locomotion.mainRoute;
  const route = createRouteDefinition({ ...main.route.definition, checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: 30 }] });
  runtime.step([{ type: 'SET_ALTERNATIVE_ROUTE', unitId: 0, route, alwaysCheckCurrentPoint: true }]);
  assert.equal(runtime.snapshot().units[0].spatialPresence.present, false);
  const teleport = createRouteDefinition({ ...route, checkpoints: [
    { type: 'APPEAR_AT_POS', position: [9, 7], reachOffset: [0, 0] },
    { type: 'WAIT_FOR_TICKS', durationTicks: 30 },
  ] });
  const step = runtime.step([
    { type: 'SET_ALTERNATIVE_ROUTE', unitId: 0, route: teleport, alwaysCheckCurrentPoint: true },
    { type: 'CLEAR_ALTERNATIVE_ROUTE', unitId: 0 },
  ]);
  assert.deepEqual(step.events.filter(event => event.type === 'ROUTE'), [
    { type: 'ROUTE', unitId: 0, signal: { type: 'APPEAR_AT_POS', position: [7, 9] }, position: [7, 9], tick: 2 },
  ]);
  const unit = runtime.snapshot().units[0];
  assert.equal(unit.spatialPresence.present, true);
  assert.deepEqual(unit.position, [7, 9]);
  assert.equal(unit.locomotion.alternativeRoute, null);
  assert.equal(unit.locomotion.mainRoute.route.progress.checkpointIndex, main.route.progress.checkpointIndex);
  assert.deepEqual(runtime.step().events.filter(event => event.type === 'ROUTE'), []);
});

test('core failed alternative route commands roll back same-tick expiry, births, RNG and navigation identities', () => {
  const initial = routeCommandBattle([{ type: 'WAIT_FOR_TICKS', durationTicks: 30 }]);
  const spawn = initial.schedule.spawns[0];
  const mechanism = createMechanismRuntime({ id: 0, definition: createMechanismDefinition({ id: 'alternative-expiry' }), active: true });
  const effect = createNavigationSpatialEffect({
    id: 0, definition: createNavigationEffectDefinition({ id: 'alternative-expiry',
      WALK: { denyPassage: false, deniedDepartures: [], costFloor: 2 }, FLY: null,
    }), source: { type: 'MECHANISM', mechanismId: 0 }, active: true,
    region: createSpatialEffectRegion({ type: 'FIXED', position: [9, 6], range: [[0, 0]], direction: 'RIGHT' }),
    expiresAtTick: 1,
  });
  const input = { ...withTimelineSpawns(initial, [spawn, { ...spawn, tick: 1 }]), initialMechanisms: [mechanism], initialEffects: [effect] };
  const runtime = new BattleRuntime(input), replay = new BattleRuntime(input);
  runtime.step(); replay.step();
  const before = runtime.snapshot(), maps = runtime.navigationMaps;
  const route = createRouteDefinition({ ...spawn.route, checkpoints: [{ type: 'MOVE', target: {
    position: [9, 8], reachOffset: [0.25, 0], randomizeReachOffset: true, reachDistance: 0,
  } }] });
  const command = { type: 'SET_ALTERNATIVE_ROUTE', unitId: 0, route, alwaysCheckCurrentPoint: true };
  for (let retry = 0; retry < 2; retry++) {
    assert.throws(() => runtime.step([command, { type: 'CLEAR_ALTERNATIVE_ROUTE', unitId: 999 }]), /unknown alternative route unit/);
    assert.deepEqual(runtime.snapshot(), before);
    assert.equal(runtime.navigationMaps, maps);
  }
  assert.deepEqual(runtime.step([command]), replay.step([command]));
  assert.deepEqual(runtime.snapshot(), replay.snapshot());
  const fixed = new BattleRuntime({ ...initial, predefines: [{ id: 0, alias: null, initiallyPresent: true,
    creation: { type: 'UNIT', definition: Object.freeze({ id: 'fixed' }), position: [10, 9], navigationEffects: [] },
  }] });
  const fixedBefore = fixed.snapshot();
  assert.throws(() => fixed.step([{ ...command, unitId: 0 }]), /no routed locomotion/);
  assert.deepEqual(fixed.snapshot(), fixedBefore);
});

test('core battle publishes every tick once and retries a final-stage failure without losing state or events', () => {
  for (const reason of ['TIME_LIMIT', 'SCHEDULE_COMPLETED']) {
    const base = routeCommandBattle([{ type: 'WAIT_FOR_TICKS', durationTicks: 30 }], { speed: 1 / 30, maxTicks: 2 });
    const source = base.schedule.spawns[0];
    const completedRoute = createRouteDefinition({ ...source.route, endPosition: source.route.startPosition, checkpoints: [] });
    const initialMechanism = createMechanismRuntime({
      id: 0, definition: createMechanismDefinition({ id: 'late-failure-initial' }), active: true,
    });
    const restriction = createNavigationEffectDefinition({
      id: 'late-failure-restriction', WALK: { denyPassage: false, deniedDepartures: [], costFloor: 3 }, FLY: null,
    });
    const initialEffect = createNavigationSpatialEffect({
      id: 0, definition: restriction, source: { type: 'MECHANISM', mechanismId: 0 }, active: true,
      region: createSpatialEffectRegion({ type: 'FIXED', position: [9, 6], range: [[0, 0]], direction: 'RIGHT' }),
      expiresAtTick: 1,
    });
    const predefinedUnit = Object.freeze({ id: 'late-failure-predefined', vitality: Object.freeze({ maxHp: 25 }) });
    const input = {
      ...withTimelineSpawns(base, [
        ...(reason === 'TIME_LIMIT' ? [source] : []),
        { ...source, tick: 1, route: completedRoute },
      ]),
      initialMechanisms: [initialMechanism], initialEffects: [initialEffect],
      predefines: [
        { id: 0, alias: null, initiallyPresent: true,
          creation: { type: 'UNIT', definition: predefinedUnit, position: Object.freeze([8, 9]), navigationEffects: [] } },
        { id: 1, alias: null, initiallyPresent: false,
          creation: { type: 'MECHANISM', definition: createMechanismDefinition({ id: 'late-failure-created' }), navigationEffects: [
            { definition: restriction,
              region: createSpatialEffectRegion({ type: 'FIXED', position: [9, 7], range: [[0, 0]], direction: 'RIGHT' }) },
          ] } },
        { id: 2, alias: null, initiallyPresent: false,
          creation: { type: 'UNIT', definition: predefinedUnit, position: Object.freeze([8, 9]), navigationEffects: [] } },
      ],
    };
    const runtime = new BattleRuntime(input), replay = new BattleRuntime(input);
    assert.deepEqual(runtime.step(), replay.step());
    const before = runtime.snapshot(), maps = runtime.navigationMaps;
    const commands = [
      { type: 'REMOVE_PREDEFINED', definitionId: 0, reason: 'SCRIPT' },
      { type: 'APPEAR_PREDEFINED', definitionId: 1 },
      { type: 'APPEAR_PREDEFINED', definitionId: 2 },
    ];
    const expected = replay.step(commands), expectedSnapshot = replay.snapshot();
    assert.equal(expected.result.reason, reason);
    assert.equal(expected.result.completedRouteCount, 1);
    assert.equal(expectedSnapshot.units.length, reason === 'TIME_LIMIT' ? 2 : 1);
    assert.equal(expected.events.filter(event => event.type === 'ENEMY_SPAWNED').length, 1);
    assert.equal(expected.events.filter(event => event.type === 'UNIT_REMOVED').length, 2);
    assert.notEqual(expectedSnapshot.execution.rngState, before.execution.rngState);
    assert.ok(expectedSnapshot.execution.nextNavigationRequestId > before.execution.nextNavigationRequestId);
    assert.ok(expectedSnapshot.execution.nextUnitId > before.execution.nextUnitId);
    assert.ok(expectedSnapshot.execution.nextMechanismId > before.execution.nextMechanismId);
    assert.ok(expectedSnapshot.execution.nextSpatialEffectId > before.execution.nextSpatialEffectId);
    const transact = BattlefieldRuntime.prototype.transact;
    let failures = 0;
    try {
      BattlefieldRuntime.prototype.transact = function(operation) {
        return transact.call(this, field => {
          operation(field);
          assert.deepEqual(field.unitIds, expectedSnapshot.units.map(unit => unit.id));
          assert.deepEqual(field.mechanismIds, expectedSnapshot.mechanisms.map(mechanism => mechanism.id));
          assert.deepEqual(field.effectIds, [1]);
          assert.deepEqual(runtime.snapshot(), before);
          assert.equal(runtime.navigationMaps, maps);
          failures++;
          throw new Error('late-stage failure');
        });
      };
      for (let retry = 0; retry < 2; retry++) {
        assert.throws(() => runtime.step(commands), /late-stage failure/);
        assert.deepEqual(runtime.snapshot(), before);
        assert.equal(runtime.navigationMaps, maps);
      }
    } finally {
      BattlefieldRuntime.prototype.transact = transact;
    }
    assert.equal(failures, 2);
    assert.deepEqual(runtime.step(commands), expected);
    assert.deepEqual(runtime.snapshot(), expectedSnapshot);
  }
});

test('core schedule removal feedback advances the next wave only on the next tick', () => {
  const base = routeCommandBattle([]);
  const source = base.schedule.spawns[0];
  const route = createRouteDefinition({ ...source.route, endPosition: source.route.startPosition });
  const spawn = { ...source, route };
  const fragment = { preDelayTicks: 0, actions: [{
    spawn, offsetsTicks: [0], managedByScheduler: true, dontBlockWave: false, forceBlockWaveInBranch: false,
  }] };
  const wave = { preDelayTicks: 0, postDelayTicks: 0, maxWaitingTicks: null, fragments: [fragment] };
  const runtime = new BattleRuntime({ ...base, schedule: { type: 'WAVES', waves: [wave, wave], branches: {} } });
  const first = runtime.step();
  assert.deepEqual(first.events.filter(event => event.type === 'ENEMY_SPAWNED'), [{ type: 'ENEMY_SPAWNED', unitId: 0, tick: 0 }]);
  assert.deepEqual(first.events.filter(event => event.type === 'ROUTE_COMPLETED'), [{ type: 'ROUTE_COMPLETED', unitId: 0, tick: 0 }]);
  assert.equal(first.result, null);
  const afterFirst = runtime.snapshot();
  assert.equal(afterFirst.spawning.waveIndex, 0);
  assert.equal(afterFirst.spawning.main.phase, 'WAITING');
  assert.deepEqual(afterFirst.spawning.managedWaveUnitIds, []);
  assert.deepEqual(afterFirst.spawning.managedFinalUnitIds, []);
  const second = runtime.step();
  assert.deepEqual(second.events.filter(event => event.type === 'ENEMY_SPAWNED'), [{ type: 'ENEMY_SPAWNED', unitId: 1, tick: 1 }]);
  assert.deepEqual(second.events.filter(event => event.type === 'ROUTE_COMPLETED'), [{ type: 'ROUTE_COMPLETED', unitId: 1, tick: 1 }]);
  assert.equal(second.result, null);
  assert.equal(runtime.snapshot().spawning.waveIndex, 1);
  const final = runtime.step();
  assert.deepEqual(final.events, []);
  assert.deepEqual(final.result, {
    reason: 'SCHEDULE_COMPLETED', elapsedTicks: 3, spawnedCount: 2, completedRouteCount: 2,
    remainingUnitIds: [], unspawnedCount: 0,
  });
});

test('core clearing derived navigation fields preserves every tick, event and RNG transition', () => {
  const input = routeCommandBattle([
    { type: 'MOVE', target: { position: [9, 8], reachOffset: [0.25, 0.25], randomizeReachOffset: true, reachDistance: 0.05 } },
    { type: 'WAIT_FOR_TICKS', durationTicks: 2 },
    { type: 'MOVE', target: { position: [9, 6], reachOffset: [0.25, 0.25], randomizeReachOffset: true, reachDistance: 0.05 } },
  ], { speed: 1 / 5, maxTicks: 100 });
  const runtime = new BattleRuntime(input), replay = new BattleRuntime(input);
  const transact = BattlefieldRuntime.prototype.transact;
  let clearCount = 0;
  for (let tick = 0; runtime.result === null; tick++) {
    const expected = replay.step();
    let actual;
    try {
      BattlefieldRuntime.prototype.transact = function(operation) {
        this.fieldCache.clear();
        clearCount++;
        return transact.call(this, operation);
      };
      actual = runtime.step();
    } finally {
      BattlefieldRuntime.prototype.transact = transact;
    }
    assert.deepEqual(actual, expected);
    assert.deepEqual(runtime.snapshot(), replay.snapshot());
  }
  assert.ok(clearCount > 10);
  assert.equal(runtime.result.reason, 'SCHEDULE_COMPLETED');
  assert.equal(runtime.result.completedRouteCount, 1);
});

test('core battle deadline keeps live units separate from spawns due at the excluded final edge', () => {
  const { spec } = slimeMovementFragment();
  const limited = createBattleSpec({ ...spec, maxTicks: 240 });
  const runtime = new BattleRuntime(limited);
  const events = [];
  while (runtime.result === null) events.push(...runtime.step().events);
  assert.deepEqual(runtime.result, {
    reason: 'TIME_LIMIT', elapsedTicks: 240, spawnedCount: 1, completedRouteCount: 0,
    remainingUnitIds: [0], unspawnedCount: 1,
  });
  assert.deepEqual(events.filter(event => event.type === 'ENEMY_SPAWNED'), [{ type: 'ENEMY_SPAWNED', unitId: 0, tick: 90 }]);
  assert.deepEqual(events.filter(event => event.type === 'UNIT_REMOVED' || event.type === 'ROUTE_COMPLETED'), []);
  assert.equal(runtime.snapshot().units[0].vitality.hp, 550);
  assert.deepEqual(simulateBattle(limited), runtime.result);
  const result = runtime.result;
  const snapshot = runtime.snapshot();
  result.remainingUnitIds.push(99);
  snapshot.result.remainingUnitIds[0] = 99;
  assert.deepEqual(runtime.result.remainingUnitIds, [0]);
  const finished = runtime.snapshot();
  assert.deepEqual(runtime.step(), { events: [], result: runtime.result });
  assert.deepEqual(runtime.snapshot(), finished);
});

test('core fragment binds wave and fragment starts and preserves original action order for simultaneous spawns', () => {
  const rawLevel = arknightsFixture('level_act1autochess_01');
  rawLevel.waves[0].preDelay = 2;
  rawLevel.waves[0].fragments[0].preDelay = 1;
  const actions = rawLevel.waves[0].fragments[0].actions;
  actions[1] = { ...actions[0], count: 1, routeIndex: 1 };
  const { level, spec, selection } = slimeMovementFragment(rawLevel, [1, 0]);
  assert.deepEqual(selection.actionIndices, [0, 1]);
  assert.deepEqual(spec.schedule.spawns.map(spawn => spawn.tick), [180, 180, 330]);
  assert.equal(spec.schedule.spawns[0].route, level.routes[0]);
  assert.equal(spec.schedule.spawns[1].route, level.routes[1]);
  assert.equal(spec.schedule.spawns[2].route, level.routes[0]);
  assert.deepEqual(spec.schedule.spawns.map(spawn => spawn.timing), [
    { waveStartedAtTick: 0, fragmentStartedAtTick: 90 },
    { waveStartedAtTick: 0, fragmentStartedAtTick: 90 },
    { waveStartedAtTick: 0, fragmentStartedAtTick: 90 },
  ]);
  const runtime = new BattleRuntime(spec);
  while (runtime.snapshot().tickIndex < 180) assert.deepEqual(runtime.step().events, []);
  assert.deepEqual(runtime.step().events, [
    { type: 'ENEMY_SPAWNED', unitId: 0, tick: 180 },
    { type: 'ENEMY_SPAWNED', unitId: 1, tick: 180 },
  ]);
  const units = runtime.snapshot().units;
  assert.deepEqual(units.map(unit => unit.id), [0, 1]);
  assert.equal(units[0].locomotion.mainRoute.route.definition, level.routes[0]);
  assert.equal(units[1].locomotion.mainRoute.route.definition, level.routes[1]);
  assert.deepEqual(units.map(unit => unit.locomotion.mainRoute.route.timing), [
    { waveStartedAtTick: 0, fragmentStartedAtTick: 90 },
    { waveStartedAtTick: 0, fragmentStartedAtTick: 90 },
  ]);
});

test('raw enemy movement levels inherit only defined values and reject sparse, unknown and invalid entries', () => {
  const fixture = arknightsFixture('enemy_1007_slime');
  const profile = slimeMovementProfile();
  const parseMovement = (value, level) => parseEnemyMovementDefinition(value, level, profile);
  assert.deepEqual(parseMovement(fixture, 0), {
    id: 'enemy_1007_slime', vitality: { maxHp: 550 }, locomotion: { moveSpeedPerTick: 1 / 30, steeringParameters: profile.steeringParameters },
  });
  assert.deepEqual(parseMovement(fixture, 1), {
    id: 'enemy_1007_slime', vitality: { maxHp: 2050 }, locomotion: { moveSpeedPerTick: 1 / 30, steeringParameters: profile.steeringParameters },
  });
  assert.deepEqual(parseMovement({ ...fixture, Value: [...fixture.Value].reverse() }, 1), parseMovement(fixture, 1));
  const ignored = structuredClone(fixture);
  ignored.Value[1].enemyData.attributes.moveSpeed.m_value = NaN;
  assert.equal(parseMovement(ignored, 1).locomotion.moveSpeedPerTick, 1 / 30);
  ignored.Value.push({ level: 2, enemyData: { attributes: {
    maxHp: { m_defined: false, m_value: 0 }, moveSpeed: { m_defined: false, m_value: 0 },
  } } });
  assert.equal(parseMovement(ignored, 2).vitality.maxHp, 550);
  const stationary = structuredClone(fixture);
  stationary.Value[1].enemyData.attributes.moveSpeed = { m_defined: true, m_value: 0 };
  assert.equal(parseMovement(stationary, 1).locomotion.moveSpeedPerTick, 0);
  assert.throws(() => parseMovement(fixture, 2), /unknown enemy level/);
  assert.throws(() => parseMovement({ ...fixture, Value: [...fixture.Value, fixture.Value[0]] }, 0), /duplicate enemy level/);
  const sparse = structuredClone(fixture);
  delete sparse.Value[0];
  assert.throws(() => parseMovement(sparse, 1), /dense/);
  assert.throws(() => parseMovement({ ...fixture, Value: [fixture.Value[1]] }, 1), /requires level 0/);
  const missing = structuredClone(fixture);
  missing.Value[0].enemyData.attributes.moveSpeed.m_defined = false;
  assert.throws(() => parseMovement(missing, 1), /requires a defined value/);
  for (const level of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseMovement(fixture, level), /enemy level/);
  }
  for (const [name, value] of [['maxHp', 0], ['maxHp', -1], ['maxHp', NaN], ['moveSpeed', -1], ['moveSpeed', Infinity], ['moveSpeed', '1']]) {
    const invalid = structuredClone(fixture);
    invalid.Value[0].enemyData.attributes[name].m_value = value;
    assert.throws(() => parseMovement(invalid, 0), /defined enemy/);
  }
  const invalidFlag = structuredClone(fixture);
  invalidFlag.Value[1].enemyData.attributes.moveSpeed.m_defined = 0;
  assert.throws(() => parseMovement(invalidFlag, 1), /m_defined must be boolean/);
});

test('core fragment projects periodic spawns from absolute source times without accumulating interval rounding', () => {
  const rawLevel = arknightsFixture('level_act1autochess_01');
  const action = rawLevel.waves[0].fragments[0].actions[0];
  action.preDelay = 0.05;
  action.interval = 0.15;
  action.count = 8;
  const { spec } = slimeMovementFragment(rawLevel);
  const expected = [2, 6, 11, 15, 20, 24, 29, 33];
  assert.deepEqual(spec.schedule.spawns.map(spawn => spawn.tick), expected);
  const runtime = new BattleRuntime({ ...spec, maxTicks: 34 });
  const events = [];
  while (runtime.result === null) events.push(...runtime.step().events);
  assert.deepEqual(events.filter(event => event.type === 'ENEMY_SPAWNED').map(event => event.tick), expected);
  assert.equal(runtime.result.spawnedCount, 8);
  assert.equal(runtime.result.elapsedTicks, 34);
});

test('core battle uses integer tick boundaries for spawning, effect expiry and deadlines', () => {
  const { spec } = slimeMovementFragment();
  const mechanism = createMechanismRuntime({ id: 0, definition: createMechanismDefinition({ id: 'expiry' }), active: true });
  const effect = createNavigationSpatialEffect({
    id: 0,
    definition: createNavigationEffectDefinition({ id: 'expiry', WALK: { denyPassage: false, deniedDepartures: [], costFloor: 2 }, FLY: null }),
    source: { type: 'MECHANISM', mechanismId: 0 },
    active: true,
    region: createSpatialEffectRegion({ type: 'FIXED', position: [9, 6], range: [[0, 0]], direction: 'RIGHT' }),
    expiresAtTick: secondsToTicks(0.9),
  });
  assert.equal(secondsToTicks(0.1 + 0.2), 9);
  assert.equal(secondsToTicks(1e-18), 1);
  assert.equal(secondsToTicks(0), 0);
  assert.equal(secondsToTicks(0.15), 5);
  for (const seconds of [NaN, Infinity, Number.MAX_VALUE]) assert.throws(() => secondsToTicks(seconds), RangeError);
  const boundary = createBattleSpec({ ...withTimelineSpawns(spec, [{ ...spec.schedule.spawns[0], tick: secondsToTicks(0.9) }]),
    maxTicks: secondsToTicks(1.2), initialMechanisms: [mechanism], initialEffects: [effect],
  });
  const runtime = new BattleRuntime(boundary);
  for (let index = 0; index < 27; index++) assert.deepEqual(runtime.step().events, []);
  assert.equal(runtime.snapshot().effects.length, 1);
  const step = runtime.step();
  assert.equal(step.events[0].type, 'ENEMY_SPAWNED');
  assert.equal(step.events[0].tick, 27);
  assert.equal(runtime.snapshot().effects.length, 0);
  assert.equal(runtime.snapshot().tickIndex, 28);
  while (runtime.result === null) runtime.step();
  assert.equal(runtime.result.reason, 'TIME_LIMIT');
  assert.equal(runtime.result.elapsedTicks, 36);
  const deadline = new BattleRuntime({ ...boundary, maxTicks: secondsToTicks(0.9) });
  for (let index = 0; index < 27; index++) deadline.step();
  assert.equal(deadline.snapshot().tickIndex, 27);
  assert.equal(deadline.result.reason, 'TIME_LIMIT');
  assert.equal(deadline.result.spawnedCount, 0);
  assert.equal(deadline.result.unspawnedCount, 1);
  assert.equal(deadline.result.elapsedTicks, 27);
  const rounded = simulateBattle({ ...boundary, maxTicks: secondsToTicks(0.91) });
  assert.equal(rounded.elapsedTicks, 28);
  for (const rngState of [-1, 2 ** 32, 0.5, NaN]) {
    assert.throws(() => new BattleRuntime({ ...boundary, rngState }), /unsigned 32-bit/);
  }
  for (const maxTicks of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createBattleSpec({ ...boundary, maxTicks }), /tick budget/);
  }
  for (const tick of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createBattleSpec(withTimelineSpawns(boundary, [{ ...boundary.schedule.spawns[0], tick }])), /spawn.tick/);
  }
  assert.throws(() => createBattleSpec(withTimelineSpawns(boundary, [{ ...boundary.schedule.spawns[0],
    timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0.5 },
  }])), /fragmentStartedAtTick/);
});

test('core battle rolls back spawning, expiry, RNG and tick progress when movement cannot be computed', () => {
  const { spec } = slimeMovementFragment();
  const mechanism = createMechanismRuntime({ id: 0, definition: createMechanismDefinition({ id: 'overflow' }), active: true });
  const region = createSpatialEffectRegion({ type: 'FIXED', position: [0, 0], direction: 'RIGHT',
    range: Array.from({ length: spec.map.rows }, (_, row) => Array.from({ length: spec.map.columns }, (_, col) => [row, col])).flat(),
  });
  const effect = createNavigationSpatialEffect({ id: 0,
    definition: createNavigationEffectDefinition({ id: 'overflow', WALK: { denyPassage: false, deniedDepartures: [], costFloor: 0x7fffffff }, FLY: null }),
    source: { type: 'MECHANISM', mechanismId: 0 }, active: true, region, expiresAtTick: null,
  });
  const expired = createNavigationSpatialEffect({ ...effect, id: 1, expiresAtTick: 0 });
  const predefinedLevel = parseLevelDefinition(arknightsFixture('level_act1autochess_m02'), () => ({
    consumeTileBlackboard: (_, entry) => ['isValidHand', 'previewNotAlloed'].includes(entry.key),
  }));
  const hiddenCrate = parsePredefinedInstanceDefinition(0, predefinedLevel.predefines.tokenInsts[13],
    parsePredefinedPrefab(arknightsFixture('prefab_trap_1105_accrate')), arknightsFixture('character_trap_1105_accrate'));
  const runtime = new BattleRuntime({ ...withTimelineSpawns(spec, [{ ...spec.schedule.spawns[0], tick: 0 }]),
    predefines: [hiddenCrate], initialMechanisms: [mechanism], initialEffects: [effect, expired],
  });
  const before = runtime.snapshot();
  const maps = runtime.navigationMaps;
  assert.throws(() => runtime.step([{ type: 'APPEAR_PREDEFINED', definitionId: 0 }]), /distance exceeds int32/);
  assert.deepEqual(runtime.snapshot(), before);
  assert.equal(runtime.navigationMaps, maps);
  assert.throws(() => runtime.step([{ type: 'APPEAR_PREDEFINED', definitionId: 0 }]), /distance exceeds int32/);
  assert.deepEqual(runtime.snapshot(), before);
  assert.equal(runtime.navigationMaps, maps);
});

test('raw levels preserve predefined configuration and keep unsupported inputs outside the movement fragment', () => {
  const raw = arknightsFixture('level_act1autochess_01');
  const instance = arknightsFixture('trap_098_mire');
  instance.hidden = true;
  raw.predefines.tokenInsts.push(instance);
  const parsed = parseLevelDefinition(raw);
  const predefined = parsed.predefines.tokenInsts[0];
  assert.deepEqual(predefined.position, [18, 1]);
  assert.equal(predefined.direction, 'UP');
  assert.equal(predefined.hidden, true);
  assert.equal(predefined.inst.characterKey, 'trap_098_mire');
  assert.equal(predefined.skillIndex, 0);
  assert.equal(predefined.mainSkillLvl, 1);
  assert.deepEqual(predefined.overrideSkillBlackboard, instance.overrideSkillBlackboard);
  assert.equal(parsed.branches.dragon.phases[0].actions[0].key, 'enemy_9012_acloon');
  instance.inst.level = 99;
  instance.overrideSkillBlackboard[0].value = 99;
  raw.routes[0].endPosition.col = 99;
  assert.equal(predefined.inst.level, 1);
  assert.equal(predefined.overrideSkillBlackboard[0].value, -0.05);
  assert.deepEqual(parsed.routes[0].endPosition, [9, 2]);
  assert.throws(() => { predefined.overrideSkillBlackboard[0].value = 1; }, TypeError);
  assert.throws(() => slimeMovementFragment(raw), /predefined instances/);
  for (const mutate of [
    raw => { raw.waves[0].fragments[0].actions[0].routeIndex = 3; },
    raw => { raw.branches.dragon.phases[0].actions[0].routeIndex = 1; },
    raw => { raw.waves[0].fragments[0].actions[0].key = 'missing'; },
    raw => { raw.enemyDbRefs.push(raw.enemyDbRefs[0]); },
    raw => { raw.waves[0].fragments[0].actions[0].actionType = 'ACTIVATE_PREDEFINE'; },
    raw => { raw.waves[0].fragments[0].actions[0].unknownRule = true; },
    raw => { delete raw.waves[0].fragments[0].actions[0]; },
    raw => { raw.predefines.tokenCards.push({}); },
    raw => { raw.runes = [{}]; },
  ]) {
    const invalid = arknightsFixture('level_act1autochess_01');
    mutate(invalid);
    assert.throws(() => parseLevelDefinition(invalid));
  }
  for (const mutate of [
    raw => { raw.waves[0].fragments[0].actions[0].blockFragment = true; },
    raw => { raw.waves[0].fragments[0].actions[0].managedByScheduler = false; },
    raw => { raw.waves[0].fragments[0].actions[0].randomType = 'RANDOM'; },
    raw => { raw.options.steeringEnabled = false; },
  ]) {
    const unsupported = arknightsFixture('level_act1autochess_01');
    mutate(unsupported);
    assert.throws(() => slimeMovementFragment(unsupported), /require|unsupported/);
  }
});

test('native-format waves exhaust each queue before advancing, and SPAWN callbacks unblock fragments before units disappear', () => {
  const { schedule } = syntheticSpawnSchedule([
    nativeWave([
      nativeFragment([], 100),
      nativeFragment([nativeSpawn({ count: 2, preDelay: 1 / 30, interval: 2 / 30, blockFragment: true })], 1 / 30),
      nativeFragment([nativeSpawn()]),
    ], { preDelay: 2 / 30, postDelay: 2 / 30 }),
    nativeWave([nativeFragment([nativeSpawn()])], { preDelay: 1 / 30, postDelay: 1 / 30, maxTimeWaitingForNextWave: 0 }),
  ]);
  const initial = createSpawnScheduleState(schedule);
  let step = dispatchSchedule(schedule, initial, 0);
  assert.equal(step.state.main.phase, 'PRE_DELAY');
  assert.equal(getUnspawnedCount(schedule, step.state), 4);
  step = dispatchSchedule(schedule, step.state, 2);
  assert.equal(step.spawns.length, 0);
  assert.equal(step.state.main.fragmentIndex, 1);
  assert.equal(step.state.fragmentStartedAtTick, 3);
  step = dispatchSchedule(schedule, step.state, 4, [0]);
  assert.deepEqual(step.spawns.map(spawn => spawn.tick), [4]);
  assert.deepEqual(step.state.managedWaveUnitIds, [0]);
  assert.equal(step.state.main.phase, 'FRAGMENTS');
  step = dispatchSchedule(schedule, step.state, 5);
  assert.equal(step.spawns.length, 0);
  assert.equal(step.state.main.fragmentIndex, 1);
  step = dispatchSchedule(schedule, step.state, 6, [1, 2]);
  assert.deepEqual(step.spawns.map(spawn => spawn.tick), [6, 6]);
  assert.deepEqual(step.spawns.map(spawn => spawn.timing), [
    { waveStartedAtTick: 0, fragmentStartedAtTick: 3 },
    { waveStartedAtTick: 0, fragmentStartedAtTick: 6 },
  ]);
  assert.equal(step.state.main.phase, 'WAITING');
  assert.deepEqual(step.state.managedWaveUnitIds, [0, 1, 2]);
  assert.equal(getUnspawnedCount(schedule, step.state), 1);
  assert.deepEqual(initial, createSpawnScheduleState(schedule));
  const resolved = resolveScheduleUnits(step.state, [0, 1, 2]);
  step = dispatchSchedule(schedule, resolved, 7);
  assert.equal(step.state.main.phase, 'POST_DELAY');
  step = dispatchSchedule(schedule, step.state, 8);
  assert.equal(step.state.waveIndex, 0);
  step = dispatchSchedule(schedule, step.state, 9);
  assert.equal(step.state.waveIndex, 1);
  assert.equal(step.state.main.phase, 'PRE_DELAY');
  step = dispatchSchedule(schedule, step.state, 10, [3]);
  assert.deepEqual(step.spawns[0].timing, { waveStartedAtTick: 9, fragmentStartedAtTick: 10 });
  step = dispatchSchedule(schedule, step.state, 100);
  assert.equal(step.state.main.phase, 'WAITING');
  assert.equal(isSpawnScheduleCompleted(schedule, step.state), false);
  step = dispatchSchedule(schedule, resolveScheduleUnits(step.state, [3]), 101);
  assert.equal(step.state.main.phase, 'POST_DELAY');
  step = dispatchSchedule(schedule, step.state, 102);
  assert.equal(isSpawnScheduleCompleted(schedule, step.state), true);
  assert.equal(getSpawnedCount(step.state), 4);
  assert.equal(getUnspawnedCount(schedule, step.state), 0);
});

test('scheduler wave and final ownership follow managed, dontBlockWave, forceBlockWaveInBranch and enemy notCountInTotal', () => {
  const { schedule } = syntheticSpawnSchedule([
    nativeWave([nativeFragment([
      nativeSpawn(),
      nativeSpawn({ managedByScheduler: false }),
      nativeSpawn({ dontBlockWave: true }),
      nativeSpawn({ key: 'ignored' }),
      nativeSpawn({ forceBlockWaveInBranch: true }),
    ])]),
  ], { extra: { phases: [nativeFragment([
    nativeSpawn(),
    nativeSpawn({ forceBlockWaveInBranch: true }),
    nativeSpawn({ forceBlockWaveInBranch: true, dontBlockWave: true }),
    nativeSpawn({ key: 'ignored', forceBlockWaveInBranch: true }),
    nativeSpawn({ managedByScheduler: false, forceBlockWaveInBranch: true }),
  ])] } }, ['ignored']);
  let step = dispatchSchedule(schedule, createSpawnScheduleState(schedule), 0, [0, 1, 2, 3, 4]);
  assert.deepEqual(step.state.managedWaveUnitIds, [0, 4]);
  assert.deepEqual(step.state.managedFinalUnitIds, [0, 2, 4]);
  assert.equal(step.spawns[3].notCountInTotal, true);
  step = dispatchSchedule(schedule, step.state, 1, [5, 6, 7, 8, 9], [{ branchId: 'extra', isLoop: false }]);
  assert.deepEqual(step.state.managedWaveUnitIds, [0, 4, 6]);
  assert.deepEqual(step.state.managedFinalUnitIds, [0, 2, 4, 5, 6, 7]);
  assert.equal(getSpawnedCount(step.state), 10);
  assert.equal(getUnspawnedCount(schedule, step.state), 0);
  step = dispatchSchedule(schedule, resolveScheduleUnits(step.state, [0, 4, 6]), 2);
  assert.equal(step.state.main.phase, 'COMPLETED');
  assert.deepEqual(step.state.managedFinalUnitIds, [2, 5, 7]);
  assert.equal(isSpawnScheduleCompleted(schedule, step.state), false);
  assert.equal(isSpawnScheduleCompleted(schedule, resolveScheduleUnits(step.state, [2, 5, 7])), true);
});

test('wave timeout starts after its last queued action, clears only wave ownership, and final waves ignore that timeout', () => {
  const { schedule } = syntheticSpawnSchedule([
    nativeWave([nativeFragment([nativeSpawn({ count: 2, interval: 5 / 30 })])],
      { maxTimeWaitingForNextWave: 3 / 30, postDelay: 2 / 30 }),
    nativeWave([nativeFragment([nativeSpawn()])], { maxTimeWaitingForNextWave: 0 }),
  ]);
  let step = dispatchSchedule(schedule, createSpawnScheduleState(schedule), 0, [0]);
  step = dispatchSchedule(schedule, step.state, 4);
  assert.equal(step.state.main.phase, 'FRAGMENTS');
  assert.equal(step.state.waveIndex, 0);
  step = dispatchSchedule(schedule, step.state, 5, [1]);
  assert.equal(step.state.main.phase, 'WAITING');
  assert.equal(step.state.main.startedAtTick, 5);
  step = dispatchSchedule(schedule, step.state, 7);
  assert.equal(step.state.main.phase, 'WAITING');
  step = dispatchSchedule(schedule, step.state, 8);
  assert.equal(step.state.main.phase, 'POST_DELAY');
  assert.deepEqual(step.state.managedWaveUnitIds, []);
  assert.deepEqual(step.state.managedFinalUnitIds, [0, 1]);
  step = dispatchSchedule(schedule, step.state, 9);
  assert.equal(step.state.waveIndex, 0);
  step = dispatchSchedule(schedule, step.state, 10, [2]);
  assert.equal(step.state.waveIndex, 1);
  assert.deepEqual(step.state.managedWaveUnitIds, [2]);
  assert.deepEqual(step.state.managedFinalUnitIds, [0, 1, 2]);
  step = dispatchSchedule(schedule, step.state, 100);
  assert.equal(step.state.main.phase, 'WAITING');
  step = dispatchSchedule(schedule, resolveScheduleUnits(step.state, [2]), 101);
  assert.equal(step.state.main.phase, 'COMPLETED');
  assert.equal(isSpawnScheduleCompleted(schedule, step.state), false);
  assert.equal(isSpawnScheduleCompleted(schedule, resolveScheduleUnits(step.state, [0, 1])), true);
});

test('same-tick zero timeout never registers an old wave spawn as a new wave blocker', () => {
  const { schedule } = syntheticSpawnSchedule([
    nativeWave([nativeFragment([nativeSpawn()])], { maxTimeWaitingForNextWave: 0 }),
    nativeWave([nativeFragment([nativeSpawn()])]),
  ]);
  const advanced = advanceSpawnSchedule(schedule, createSpawnScheduleState(schedule), { tick: 0 });
  assert.deepEqual(advanced.spawns.map(spawn => spawn.schedule.waveIndex), [0, 1]);
  assert.equal(isSpawnScheduleCompleted(schedule, advanced.state), false);
  assert.throws(() => advanceSpawnSchedule(schedule, advanced.state, { tick: 1 }), /must be recorded/);
  assert.throws(() => recordScheduleSpawns(advanced.state, advanced.spawns, [0]), /pending spawn batch/);
  const state = recordScheduleSpawns(advanced.state, advanced.spawns, [0, 1]);
  assert.equal(state.waveIndex, 1);
  assert.deepEqual(state.managedWaveUnitIds, [1]);
  assert.deepEqual(state.managedFinalUnitIds, [0, 1]);
});

test('branches require explicit triggers, consume one phase each, support loops and allow overlapping phase queues', () => {
  const { level, schedule } = syntheticSpawnSchedule([
    nativeWave([nativeFragment([nativeSpawn({ preDelay: 1 })])]),
  ], { extra: { phases: [
    nativeFragment([nativeSpawn({ preDelay: 3 / 30 })]),
    nativeFragment([nativeSpawn()]),
  ] } });
  let step = dispatchSchedule(schedule, createSpawnScheduleState(schedule), 0);
  assert.equal(step.state.branchCursors.extra, 0);
  assert.equal(step.state.activeBranches.length, 0);
  assert.equal(getUnspawnedCount(schedule, step.state), 1);
  step = dispatchSchedule(schedule, step.state, 1, [], [{ branchId: 'extra', isLoop: false }]);
  assert.equal(step.state.branchCursors.extra, 1);
  assert.equal(getUnspawnedCount(schedule, step.state), 2);
  step = dispatchSchedule(schedule, step.state, 2, [0], [{ branchId: 'extra', isLoop: false }]);
  assert.equal(step.state.branchCursors.extra, 2);
  assert.equal(step.state.activeBranches.length, 1);
  assert.equal(step.spawns[0].route, level.extraRoutes[0]);
  assert.deepEqual(step.spawns[0].timing, { waveStartedAtTick: 0, fragmentStartedAtTick: 0 });
  assert.deepEqual(step.state.managedWaveUnitIds, []);
  step = dispatchSchedule(schedule, step.state, 3, [], [{ branchId: 'extra', isLoop: false }]);
  assert.equal(step.spawns.length, 0);
  step = dispatchSchedule(schedule, step.state, 4, [1]);
  assert.equal(step.state.activeBranches.length, 0);
  step = dispatchSchedule(schedule, step.state, 5, [2], [
    { branchId: 'extra', isLoop: true }, { branchId: 'extra', isLoop: true },
  ]);
  assert.equal(step.spawns.length, 1);
  assert.equal(step.state.branchCursors.extra, 2);
  assert.equal(step.state.activeBranches.length, 1);
  const snapshot = cloneScheduleState(step.state);
  snapshot.branchCursors.extra = 99;
  snapshot.activeBranches[0].spawns.length = 0;
  snapshot.main.queue.spawns.length = 0;
  snapshot.managedFinalUnitIds.push(99);
  assert.equal(step.state.branchCursors.extra, 2);
  assert.equal(step.state.activeBranches[0].spawns.length, 1);
  assert.equal(step.state.main.queue.spawns.length, 1);
  assert.deepEqual(step.state.managedFinalUnitIds, [0, 1, 2]);
  step = dispatchSchedule(schedule, step.state, 8, [3]);
  assert.equal(getSpawnedCount(step.state), 4);
  assert.equal(getUnspawnedCount(schedule, step.state), 1);
  const before = cloneScheduleState(step.state);
  assert.throws(() => advanceSpawnSchedule(schedule, step.state, { tick: 9, triggers: [{ branchId: 'missing', isLoop: false }] }), /unknown scheduler branch/);
  assert.deepEqual(step.state, before);
});

test('WAVES projection rounds absolute action times, including fractional fragment delays, without periodic drift', () => {
  const { schedule } = syntheticSpawnSchedule([
    nativeWave([nativeFragment([nativeSpawn({ preDelay: 0.05, interval: 0.15, count: 8 })], 0.05)]),
  ]);
  let state = createSpawnScheduleState(schedule);
  const ticks = [];
  for (let tick = 0; tick <= 35; tick++) {
    const advanced = advanceSpawnSchedule(schedule, state, { tick });
    ticks.push(...advanced.spawns.map(spawn => spawn.tick));
    state = recordScheduleSpawns(advanced.state, advanced.spawns, advanced.spawns.map((_, index) => ticks.length - advanced.spawns.length + index));
  }
  assert.deepEqual(ticks, [3, 8, 12, 17, 21, 26, 30, 35]);
  assert.equal(getUnspawnedCount(schedule, state), 0);
});

test('delayed branch births snapshot the current main fragment and wave at dispatch rather than at their trigger', () => {
  const { level, schedule } = syntheticSpawnSchedule([
    nativeWave([
      nativeFragment([nativeSpawn({ preDelay: 1 / 30, dontBlockWave: true })]),
      nativeFragment([nativeSpawn({ preDelay: 2 / 30, dontBlockWave: true })], 1 / 30),
    ], { postDelay: 1 / 30 }),
    nativeWave([nativeFragment([nativeSpawn({ preDelay: 2 / 30 })], 2 / 30)], { preDelay: 1 / 30 }),
  ], { extra: { phases: [nativeFragment([
    nativeSpawn({ preDelay: 3 / 30 }), nativeSpawn({ preDelay: 8 / 30 }),
  ])] } });
  let state = createSpawnScheduleState(schedule);
  let nextUnitId = 0;
  const births = [];
  for (let tick = 0; tick <= 10; tick++) {
    const triggers = tick === 0 ? [{ branchId: 'extra', isLoop: false }] : [];
    const advanced = advanceSpawnSchedule(schedule, state, { tick, triggers });
    for (const spawn of advanced.spawns) births.push({
      tick: spawn.tick, branch: spawn.route === level.extraRoutes[0], timing: spawn.timing,
    });
    state = recordScheduleSpawns(advanced.state, advanced.spawns, advanced.spawns.map(() => nextUnitId++));
  }
  assert.deepEqual(births, [
    { tick: 1, branch: false, timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 } },
    { tick: 3, branch: true, timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 2 } },
    { tick: 4, branch: false, timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 2 } },
    { tick: 8, branch: true, timing: { waveStartedAtTick: 5, fragmentStartedAtTick: 8 } },
    { tick: 10, branch: false, timing: { waveStartedAtTick: 5, fragmentStartedAtTick: 8 } },
  ]);
});

test('same-tick branch dispatch reads the main snapshot before that tick enters its first fragment', () => {
  const { schedule } = syntheticSpawnSchedule([
    nativeWave([nativeFragment([nativeSpawn()], 1)]),
  ], { extra: { phases: [nativeFragment([nativeSpawn()])] } });
  const step = dispatchSchedule(schedule, createSpawnScheduleState(schedule), 0, [0], [{ branchId: 'extra', isLoop: false }]);
  assert.deepEqual(step.spawns[0].timing, { waveStartedAtTick: 0, fragmentStartedAtTick: 0 });
  assert.equal(step.state.fragmentStartedAtTick, 30);
  assert.equal(step.state.main.queue.spawns[0].tick, 30);
});

test('battle schedule completion can leave unmanaged live units, and branch command failures roll back the whole tick', () => {
  const { spec } = slimeMovementFragment();
  const unmanaged = syntheticSpawnSchedule([nativeWave([nativeFragment([nativeSpawn({ managedByScheduler: false })])])]);
  const runtime = new BattleRuntime({ ...spec, schedule: unmanaged.schedule });
  const completed = runtime.step();
  assert.equal(completed.result.reason, 'SCHEDULE_COMPLETED');
  assert.equal(completed.result.spawnedCount, 1);
  assert.equal(completed.result.completedRouteCount, 0);
  assert.deepEqual(completed.result.remainingUnitIds, [0]);
  const branches = syntheticSpawnSchedule([nativeWave([nativeFragment([nativeSpawn({ preDelay: 1 })])])],
    { extra: { phases: [nativeFragment([nativeSpawn()])] } });
  const branchRuntime = new BattleRuntime({ ...spec, schedule: branches.schedule });
  branchRuntime.step();
  const before = branchRuntime.snapshot();
  assert.throws(() => branchRuntime.step([
    { type: 'TRIGGER_BRANCH', branchId: 'extra', isLoop: false },
    { type: 'TRIGGER_BRANCH', branchId: 'missing', isLoop: false },
  ]), /unknown scheduler branch/);
  assert.deepEqual(branchRuntime.snapshot(), before);
  const spawned = branchRuntime.step([{ type: 'TRIGGER_BRANCH', branchId: 'extra', isLoop: false }]);
  assert.deepEqual(spawned.events.filter(event => event.type === 'ENEMY_SPAWNED'), [{ type: 'ENEMY_SPAWNED', unitId: 0, tick: 1 }]);
  assert.equal(branchRuntime.snapshot().units[0].locomotion.mainRoute.route.definition, branches.level.extraRoutes[0]);
});

test('raw 01 dragon branch waits for an explicit trigger and uses its own actual flying prefab and extra route', () => {
  const raw = arknightsFixture('level_act1autochess_01');
  const catalog = {
    character: () => assert.fail('no selected predefined characters'),
    skill: () => assert.fail('no selected predefined skills'),
    enemy: key => arknightsFixture(key),
    prefab: key => arknightsFixture(`prefab_${key}`),
  };
  const selection = { actions: [{ waveIndex: 0, fragmentIndex: 0, actionIndex: 0 }], branches: ['dragon'], predefines: [] };
  const scenario = loadMovementScenario(raw, selection, catalog, 123);
  assert.deepEqual(scenario.inactiveBranches, []);
  const runtime = new BattleRuntime(scenario.spec);
  assert.deepEqual(runtime.snapshot().spawning.activeBranches, []);
  while (runtime.snapshot().tickIndex < 95) runtime.step();
  assert.deepEqual(runtime.snapshot().units.map(unit => unit.definition.id), ['enemy_1007_slime']);
  const first = runtime.step([{ type: 'TRIGGER_BRANCH', branchId: 'dragon', isLoop: false }]);
  assert.deepEqual(first.events.filter(event => event.type === 'ENEMY_SPAWNED'), [{ type: 'ENEMY_SPAWNED', unitId: 1, tick: 95 }]);
  const dragon = runtime.snapshot().units.find(unit => unit.id === 1);
  assert.equal(dragon.definition.id, 'enemy_9012_acloon');
  assert.equal(dragon.definition.locomotion.steeringParameters.steeringFactor, 8 / 30);
  assert.equal(dragon.definition.locomotion.steeringParameters.maxSteeringForce, 10 / 900);
  assert.equal(dragon.locomotion.mainRoute.route.definition, scenario.level.extraRoutes[0]);
  assert.equal(dragon.locomotion.mainRoute.navigation.pathMotionMode, 'FLY');
  assert.deepEqual(dragon.locomotion.mainRoute.route.timing, { waveStartedAtTick: 0, fragmentStartedAtTick: 0 });
  assert.deepEqual(runtime.snapshot().spawning.managedWaveUnitIds, [0]);
  assert.deepEqual(runtime.snapshot().spawning.managedFinalUnitIds, [0, 1]);
  assert.equal(runtime.step([{ type: 'TRIGGER_BRANCH', branchId: 'dragon', isLoop: false }])
    .events.filter(event => event.type === 'ENEMY_SPAWNED').length, 0);
  assert.deepEqual(runtime.step([{ type: 'TRIGGER_BRANCH', branchId: 'dragon', isLoop: true }])
    .events.filter(event => event.type === 'ENEMY_SPAWNED'), [{ type: 'ENEMY_SPAWNED', unitId: 2, tick: 97 }]);
  while (runtime.result === null) runtime.step();
  assert.equal(runtime.result.reason, 'SCHEDULE_COMPLETED');
  assert.equal(runtime.result.spawnedCount, 4);
  assert.equal(runtime.result.completedRouteCount, 4);
  assert.deepEqual(runtime.result.remainingUnitIds, []);
  const delayed = arknightsFixture('prefab_enemy_1007_slime');
  delayed.components.find(component => Object.hasOwn(component.fields, '_delayToBorn')).fields._delayToBorn = 1;
  assert.throws(() => loadMovementScenario(raw, selection, {
    ...catalog, prefab: key => key === 'enemy_1007_slime' ? delayed : catalog.prefab(key),
  }, 123), /synchronous enemy births/);
});

test('core blocked enemies at their route end stay in combat until their blocker dies', () => {
  const route = createRouteDefinition({
    pathMotionMode: 'WALK', startPosition: [0, 0], endPosition: [0, 0],
    spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [],
    allowDiagonalMove: false, visitEveryTileCenter: false,
    visitEveryNodeCenter: false, visitEveryCheckPoint: true,
  });
  const runtime = createLegacyCombatBattle({
    rows: 1, columns: 5, maxTicks: 20,
    operators: [{ definition: guard({ stats: { maxHp: 2, atk: 0, def: 0, blockCnt: 1 } }), position: [0, 0] }],
    enemies: [{ definition: walker({ hp: 100, atk: 1, bat: 0.1 }), route }],
  });
  const first = runtime.step();
  assert.equal(first.result, null);
  assert.ok(first.events.some(event => event.type === 'ATTACK' && event.sourceUnitId === 1 && event.targetUnitId === 0));
  assert.equal(first.events.some(event => event.type === 'ROUTE_COMPLETED' || event.type === 'UNIT_REMOVED'), false);
  const held = runtime.snapshot();
  assert.deepEqual(held.units.map(unit => unit.id), [0, 1]);
  assert.deepEqual(held.blockingRelations, [{ blockerUnitId: 0, blockedUnitId: 1 }]);
  assert.deepEqual(held.spawning.managedFinalUnitIds, [1]);
  assert.equal(held.units[1].locomotion.mainRoute.route.progress.phase, 'COMPLETED');
  assert.equal(held.units[0].vitality.hp, 1);
  for (let tick = 1; tick < 3; tick++) {
    const waiting = runtime.step();
    assert.equal(waiting.result, null);
    assert.equal(waiting.events.some(event => event.type === 'ROUTE_COMPLETED' || event.type === 'UNIT_REMOVED'), false);
    assert.deepEqual(runtime.snapshot().blockingRelations, held.blockingRelations);
  }
  const released = runtime.step();
  assert.deepEqual(released.events.filter(event => event.type === 'UNIT_REMOVED').map(event => [event.unitId, event.reason]), [[0, 'DEATH'], [1, 'SCRIPT']]);
  assert.deepEqual(released.events.filter(event => event.type === 'ROUTE_COMPLETED').map(event => event.unitId), [1]);
  assert.equal(released.result.reason, 'SCHEDULE_COMPLETED');
  assert.equal(released.result.elapsedTicks, 4);
  assert.equal(released.result.completedRouteCount, 1);
  assert.deepEqual(runtime.snapshot().blockingRelations, []);
  assert.deepEqual(runtime.snapshot().units, []);
});

test('core blocked route waits can teleport away, release their blocker and resume movement', () => {
  const route = createRouteDefinition({
    pathMotionMode: 'WALK', startPosition: [0, 0], endPosition: [0, 4],
    spawnOffset: [0, 0], spawnRandomRange: [0, 0],
    checkpoints: [
      { type: 'WAIT_FOR_TICKS', durationTicks: 2 },
      { type: 'APPEAR_AT_POS', position: [0, 3], reachOffset: [0, 0] },
    ],
    allowDiagonalMove: false, visitEveryTileCenter: false,
    visitEveryNodeCenter: false, visitEveryCheckPoint: true,
  });
  const runtime = createLegacyCombatBattle({
    rows: 1, columns: 5, maxTicks: 20,
    operators: [{ definition: guard({ stats: { maxHp: 100, atk: 0, def: 0, blockCnt: 1 } }), position: [0, 0] }],
    enemies: [{ definition: walker({ hp: 100, atk: 1, bat: 0.1 }), route }],
  });
  runtime.step();
  assert.deepEqual(runtime.snapshot().blockingRelations, [{ blockerUnitId: 0, blockedUnitId: 1 }]);
  assert.equal(runtime.snapshot().units[1].locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 1);
  const teleported = runtime.step();
  assert.deepEqual(teleported.events.filter(event => event.type === 'ROUTE'), [
    { type: 'ROUTE', unitId: 1, signal: { type: 'APPEAR_AT_POS', position: [3, 0] }, position: [3, 0], tick: 1 },
  ]);
  assert.deepEqual(runtime.snapshot().units[1].position, [3, 0]);
  assert.deepEqual(runtime.snapshot().blockingRelations, []);
  assert.equal(teleported.result, null);
  for (let tick = 2; tick <= 4; tick++) {
    const moving = runtime.step();
    assert.equal(moving.events.some(event => event.type === 'ATTACK' && event.sourceUnitId === 1), false);
    assert.deepEqual(runtime.snapshot().blockingRelations, []);
    assert.ok(runtime.snapshot().units[1].position[0] > 3);
    assert.equal(runtime.snapshot().units[1].locomotion.moving, true);
    assert.equal(runtime.snapshot().units[0].vitality.hp, 99);
  }
});

test('core same-position alternative disappearance and appearance replace an existing blocking relation', () => {
  const route = createRouteDefinition({
    pathMotionMode: 'WALK', startPosition: [0, 1], endPosition: [0, 4],
    spawnOffset: [0.4, 0], spawnRandomRange: [0, 0],
    checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: 30 }],
    allowDiagonalMove: false, visitEveryTileCenter: false,
    visitEveryNodeCenter: false, visitEveryCheckPoint: true,
  });
  const source = createLegacyCombatBattle({
    rows: 1, columns: 5, maxTicks: 20,
    operators: [{ definition: guard({ stats: { maxHp: 100, atk: 0, def: 0, blockCnt: 1 } }), position: [0, 1] }],
    enemies: [{ definition: walker({ hp: 100, atk: 1, bat: 0.1 }), route }],
  });
  source.step();
  const [operator, enemy] = source.snapshot().units;
  const map = createBattlefieldMap(1, 5, Array.from({ length: 5 }, () => ({
    heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
  })));
  const runtime = new BattleRuntime({
    map, initialUnits: [{ definition: operator.definition, position: [1, 0] }],
    predefines: [{ id: 99, alias: null, initiallyPresent: false, creation: {
      type: 'UNIT', definition: operator.definition, position: [1.5, 0], navigationEffects: [],
    } }],
    schedule: { type: 'TIMELINE', spawns: [{
      definition: enemy.definition, route, tick: 0,
      timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
      alwaysCheckCurrentPoint: true, notCountInTotal: false,
    }] },
    initialMechanisms: [], initialEffects: [], maxTicks: 20, moveMultiplier: 1,
    rngState: 1, nextUnitId: 0, nextNavigationRequestId: 0,
  });
  runtime.step();
  const before = runtime.snapshot();
  assert.deepEqual(before.blockingRelations, [{ blockerUnitId: 0, blockedUnitId: 1 }]);
  const hidden = createRouteDefinition({ ...route, checkpoints: [{ type: 'DISAPPEAR' }] });
  const appeared = createRouteDefinition({ ...route, checkpoints: [
    { type: 'APPEAR_AT_POS', position: [0, 1], reachOffset: [0.4, 0] },
    { type: 'WAIT_FOR_TICKS', durationTicks: 30 },
  ] });
  const step = runtime.step([
    { type: 'APPEAR_PREDEFINED', definitionId: 99 },
    { type: 'SET_ALTERNATIVE_ROUTE', unitId: 1, route: hidden, alwaysCheckCurrentPoint: true },
    { type: 'SET_ALTERNATIVE_ROUTE', unitId: 1, route: appeared, alwaysCheckCurrentPoint: true },
  ]);
  assert.deepEqual(step.events.filter(event => event.type === 'ROUTE').map(event => [event.signal.type, event.position]), [
    ['DISAPPEAR', [1.4, 0]], ['APPEAR_AT_POS', [1.4, 0]],
  ]);
  const after = runtime.snapshot();
  assert.deepEqual(after.units.find(unit => unit.id === 1).position, before.units[1].position);
  assert.equal(after.units.find(unit => unit.id === 1).spatialPresence.present, true);
  assert.deepEqual(after.blockingRelations, [{ blockerUnitId: 2, blockedUnitId: 1 }]);
  assert.equal(step.result, null);
});
