import { calculateDamage } from "../../dist/core/tactical/battle/damage/calculate.js";
import { damage as dealDamage, parameters } from "../helpers/vitality.js";
import { definition as skillDefinition } from "../helpers/skill.js";
import { enter as enterSkill } from "../../dist/core/tactical/unit/capability/skill/operations.js";
import { Definitions } from '../../dist/core/tactical/unit/action/definitions.js';
import { create as createAttack } from '../../dist/content/tactical/actions/attack.js';
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { fixtureBattlefieldState } from "../helpers/battlefield.js";
import { replaceUnits } from "../../dist/core/tactical/battlefield/state.js";
// Combat rules: statuses & immunities, cold→freeze, element bursts, blocking, melee vs FLY, stealth, priorities, healers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, chessRec, enemyRec } from '../helpers/battleHarness.js';
import { ELEMENT } from '../../server/sim/constants.js';
import { createLegacyCombatBattle, createLegacyCombatSpec } from '../../dist/legacy/combat.js';
import { createInput as createRouteDefinition } from '../../dist/core/tactical/battle/creation/route.js';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { createBattlefieldMap, BattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';
import { World } from '../../dist/core/tactical/geometry/coordinate.js';
import { loadMovementScenario } from '../../dist/data/arknights/movement-scenario.js';
import { createTacticalCombatDemoSpec } from '../../dist/legacy/tactical-demo-combat.js';
import { createTacticalDemo } from '../../dist/legacy/tactical-demo.js';

import { initialize } from "../helpers/unit.js";
import { start as startAction } from "../../dist/core/tactical/unit/action/operations.js";

import { damage as damageFixture, healing as healingFixture } from "../helpers/targeting.js";
import { topK } from "../../dist/core/common/collection.js";
import { setMaxHpContribution } from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import { select as selectTargets } from '../../dist/core/tactical/battle/targeting/select.js';
import { setRestriction, allowsRestrictions } from '../../dist/core/tactical/unit/capability/targetable/capability.js';
import { invincible, healFree } from '../../dist/content/tactical/effects/protection.js';
import { invisible, camouflage, untargetable, allyUntargetable } from '../../dist/content/tactical/effects/visibility.js';
import { installFixtureEffect } from '../helpers/effects.js';
import * as effects from '../../dist/core/tactical/unit/effect/operations.js';
import { healing } from '../helpers/vitality.js';
import { setHook as setDamageHook } from '../../dist/core/tactical/battle/damage/hook.js';
import * as contribution from '../../dist/core/tactical/unit/contribution/contribution.js';
import * as modifier from '../../dist/core/tactical/unit/contribution/attribute.js';

import { createBattleState, battlefieldView, getUnit, updateUnit } from '../../dist/core/tactical/battle/state.js';

const startSingleAction = (source, definition, context) => {
  let battleState = createBattleState(fixtureBattlefieldState(context.battlefield));
  battleState = updateUnit({ ...battleState, tick: context.tick }, source);
  const actionState = startAction(battleState, unitRef(source), definition).state;
  battleState = actionState;
  return { units: [...battleState.battlefield.units.values()],
    removedUnitIds: battleState.removedUnits.map(value => value.unitId),
    events: battleState.events, execution: battleState.execution, state: getUnit(actionState, source.id).action.instances };
};

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

const guard = (o = {}) => chessRec({ id: 't_guard', profession: 'WARRIOR', stats: { atk: 300, blockCnt: 2 }, skill: null, ...o });
const sniper = (o = {}) => chessRec({ id: 't_sniper', profession: 'SNIPER', subProfessionId: 'closerange', stats: { atk: 300 }, rangeGrid: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 0], [1, 1], [1, 2], [1, 3], [-1, 0], [-1, 1], [-1, 2], [-1, 3]], skill: null, ...o });
const dummy = (o = {}) => enemyRec({ key: 'enemy_dummy', hp: 1e6, speed: 0, ...o });
const walker = (o = {}) => enemyRec({ key: 'enemy_walker', hp: 1e6, speed: 1, ...o });

function coreCombatRoute(startPosition = [1, 8], overrides = {}) {
  return createRouteDefinition({
    pathMotionMode: 'WALK', startPosition, endPosition: [1, 0],
    spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [],
    allowDiagonalMove: false, visitEveryTileCenter: false,
    visitEveryNodeCenter: false, visitEveryCheckPoint: true, ...overrides,
  });
}

function unitFacts(unit) {
  return unit.action === undefined ? unit : {
    ...unit,
    action: { ...unit.action, states: new Map(unit.action.states.values().map(state => {
      const id = state.definition.id;
      const { initialize, start, step, onEnd, ...definition } = state.definition;
      if (definition.attack !== undefined) {
        definition.attack = { ...definition.attack, targetGroups: definition.attack.targetGroups.map(group => {
          const { filter, selector, ...targeting } = group.targeting;
          return { ...group, targeting };
        }) };
      }
      return [id, { ...state, definition }];
    })) },
  };
}

function eventFacts(event) {
  return 'unit' in event ? { ...event, unit: unitFacts(event.unit) } : event;
}

function snapshotFacts(snapshot) {
  return { ...snapshot, units: snapshot.units.map(unitFacts) };
}

function coreCombatTrace(options) {
  const battle = createLegacyCombatBattle({ rows: 3, columns: 10, ...options });
  const trace = [];

  while (battle.result === null) {
    const stepped = battle.step();
    trace.push({ events: stepped.events.map(eventFacts), snapshot: snapshotFacts(battle.snapshot()) });
  }

  return { battle, trace, events: trace.flatMap(step => step.events) };
}

test('core combat: the real m01 demonstration targets at range, blocks three dogs and replays identically', () => {
  const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/arknights/${name}.json`, import.meta.url), 'utf8'));
  const rawLevel = fixture('level_act1autochess_m01');
  const generated = Object.fromEntries(['chess', 'enemies'].map(name => [name,
    JSON.parse(readFileSync(new URL(`../../data/${name}.json`, import.meta.url), 'utf8')),
  ]));
  const data = { lookup: (file, key) => generated[file]?.[key] };
  const operator = data.lookup('chess', 'chess_char_3_05_a');
  const rangedOperator = data.lookup('chess', 'chess_char_3_01_a');
  const enemy = data.lookup('enemies', 'enemy_1000_gopro_2');
  const originalRecords = structuredClone({ rawLevel, operator, rangedOperator, enemy });
  const catalog = {
    character: () => assert.fail('no selected predefined characters'),
    skill: () => assert.fail('no selected predefined skills'),
    enemy: () => assert.fail('no selected movement spawns'),
    prefab: () => assert.fail('no selected movement prefabs'),
  };
  const movement = loadMovementScenario(rawLevel, { actions: [], branches: [], predefines: [] }, catalog, 123);
  const spec = createTacticalCombatDemoSpec(movement.spec.map, movement.level.routes[0], data, 123);
  const placement = spec.initialUnits[0];
  const tile = BattlefieldMap.get(spec.map, World.toTile(placement.position));

  assert.equal(spec.map, movement.spec.map);
  assert.equal(spec.schedule.spawns[0].route, movement.level.routes[0]);
  assert.equal(tile.heightType, 'LOWLAND');
  assert.ok(tile.buildableType === 'MELEE' || tile.buildableType === 'ALL');
  assert.deepEqual(placement.position, [6, 5]);
  assert.equal(placement.definition.vitality.maxHp, operator.stats.maxHp);
  assert.equal(placement.definition.action.definitions.values().toArray()[0].attack.targetGroups[0].operations[0].power, operator.stats.atk);
  const rangedPlacement = spec.initialUnits[1];
  const rangedTile = BattlefieldMap.get(spec.map, World.toTile(rangedPlacement.position));
  assert.ok(rangedTile.buildableType === 'RANGED' || rangedTile.buildableType === 'ALL');
  assert.deepEqual(rangedPlacement.position, [4, 4]);
  assert.equal(rangedPlacement.definition.id, rangedOperator.chessId);
  assert.equal(rangedPlacement.definition.offense.attack, rangedOperator.stats.atk);
  assert.equal(spec.schedule.spawns[0].definition.vitality.maxHp, enemy.stats.maxHp);
  assert.deepEqual(spec.schedule.spawns.map(spawn => spawn.tick), [90, 330, 570]);

  const run = input => {
    const battle = new BattleRuntime(input);
    const events = [];
    const rangedAttacks = [];
    let blockingObserved = false;

    while (battle.result === null) {
      const before = battle.snapshot();
      const stepped = battle.step();
      for (const event of stepped.events) {
        if (event.type !== 'ACTION' || event.sourceUnitId !== 1) continue;
        const source = before.units.find(unit => unit.id === 1);
        const target = before.units.find(unit => unit.id === event.targetUnitId);
        rangedAttacks.push({
          distance: Math.sqrt(World.distanceSquared(source.position, target.position)),
          blocked: before.blockingRelations.some(relation => relation.blockedUnitId === target.id),
        });
      }
      events.push(...stepped.events.map(eventFacts));
      blockingObserved ||= battle.snapshot().blockingRelations.length > 0;
    }

    return { result: battle.result, snapshot: snapshotFacts(battle.snapshot()), events, rangedAttacks, blockingObserved };
  };
  const first = run(spec);
  const second = run(createTacticalCombatDemoSpec(movement.spec.map, movement.level.routes[0], data, 123));
  const survivor = first.snapshot.units.find(unit => unit.id === 0);

  assert.deepEqual(first, second);
  assert.equal(first.result.reason, 'SCHEDULE_COMPLETED');
  assert.equal(first.result.spawnedCount, 3);
  assert.equal(first.result.completedRouteCount, 0);
  assert.deepEqual(first.result.remainingUnitIds, [0, 1]);
  assert.equal(first.events.filter(event => event.type === 'UNIT_REMOVED' && event.reason === 'DEATH').length, 3);
  assert.equal(first.events.filter(event => event.type === 'ROUTE_COMPLETED').length, 0);
  assert.ok(first.blockingObserved);
  assert.ok(first.rangedAttacks.some(attack => !attack.blocked && attack.distance > 1));
  assert.ok(first.events.some(event => event.type === 'DAMAGE' && event.sourceUnitId === 1 && event.amount > 0));
  assert.ok(survivor.vitality.hp > 0 && survivor.vitality.hp < operator.stats.maxHp);
  assert.equal(first.snapshot.units.find(unit => unit.id === 1).vitality.hp, rangedOperator.stats.maxHp);
  assert.deepEqual({ rawLevel, operator, rangedOperator, enemy }, originalRecords);
});

test('core combat: demo scenarios preserve ranged targeting, blocking capacity and concise logs', async t => {
  t.mock.method(globalThis, 'fetch', async url => ({
    ok: true,
    json: async () => JSON.parse(readFileSync(new URL(`../fixtures/arknights/${url.slice('/fixtures/'.length)}`, import.meta.url), 'utf8')),
  }));
  const generated = Object.fromEntries(['chess', 'enemies', 'stages'].map(name => [name,
    JSON.parse(readFileSync(new URL(`../../data/${name}.json`, import.meta.url), 'utf8')),
  ]));
  const logs = [];
  const view = {
    setStage() {}, enterBattle() {}, setCamera() {}, setLocalFeed() {},
    pushSnapshot() {}, pushEvents() {},
    debug: { interp: { snapToNewest() {}, maxExtrapolate: 0 } },
  };
  const demo = await createTacticalDemo(view, {
    stageId: 'act1autochess_m01', mode: 'COMBAT', seed: 123,
    data: { lookup: (file, key) => generated[file]?.[key] },
    onEvent: event => logs.push(event),
  });

  demo.tick(45);

  const removals = logs.filter(event => event.type === 'UNIT_REMOVED');
  assert.equal(removals.length, 3);
  for (const event of removals) {
    assert.deepEqual(Object.keys(event).sort(), ['reason', 'tick', 'type', 'unitId']);
    assert.equal(event.reason, 'DEATH');
  }
  assert.ok(logs.some(event => event.type === 'DAMAGE'));
  assert.equal(JSON.stringify(logs).includes('UNREACHABLE'), false);
  assert.equal(demo.stats().killedCount, 3);
  demo.stop();

  for (const combatScenario of ['RANGED', 'BLOCKING']) {
    await t.test(combatScenario, async () => {
      const events = [];
      const scenario = await createTacticalDemo(view, {
        stageId: 'act1autochess_m01', mode: 'COMBAT', combatScenario, seed: 123,
        data: { lookup: (file, key) => generated[file]?.[key] },
        onEvent: event => events.push(event),
      });
      assert.deepEqual(scenario.snapshot().units.map(unit => unit.definition.id),
        [combatScenario === 'RANGED' ? 'chess_char_3_01_a' : 'chess_char_3_05_a']);
      let maximumBlocked = 0;
      let simultaneousEnemies = 0;
      for (let tick = 0; tick < 1350 && scenario.stats().result === null; tick++) {
        scenario.step();
        maximumBlocked = Math.max(maximumBlocked, scenario.stats().blockingCount);
        simultaneousEnemies = Math.max(simultaneousEnemies,
          scenario.snapshot().units.filter(unit => unit.definition.id === 'enemy_1000_gopro_2').length);
      }
      assert.equal(scenario.stats().result.reason, 'SCHEDULE_COMPLETED');
      assert.equal(maximumBlocked, combatScenario === 'RANGED' ? 0 : 1);
      assert.equal(simultaneousEnemies, combatScenario === 'RANGED' ? 1 : 3);
      assert.deepEqual(events.filter(event => event.type === 'ENEMY_SPAWNED').map(event => event.tick),
        combatScenario === 'RANGED' ? [90, 330, 570] : [90, 90, 90]);
      assert.equal(scenario.stats().killedCount, combatScenario === 'RANGED' ? 3 : 1);
      assert.equal(events.filter(event => event.type === 'ROUTE_COMPLETED').length,
        combatScenario === 'RANGED' ? 0 : 2);
      assert.equal(JSON.stringify(events).includes('UNREACHABLE'), false);
      scenario.stop();
    });
  }
});

test('core combat: a blocked enemy exchanges attacks and death resolves the spawn schedule deterministically', () => {
  const options = {
    operators: [{
      definition: guard({ stats: { maxHp: 1000, atk: 100, def: 0, blockCnt: 1, bat: 0.1 }, rangeGrid: [[0, 0]] }),
      position: [1, 5],
    }],
    enemies: [{ definition: walker({ hp: 250, atk: 30, bat: 0.1 }), route: coreCombatRoute() }],
    seed: 123,
  };
  const first = coreCombatTrace(options);
  const second = coreCombatTrace(options);
  const damage = first.events.filter(event => event.type === 'DAMAGE');

  assert.deepEqual(first.trace, second.trace);
  assert.ok(damage.some(event => event.sourceUnitId === 0 && event.targetUnitId === 1));
  assert.ok(damage.some(event => event.sourceUnitId === 1 && event.targetUnitId === 0));
  assert.ok(first.events.some(event => event.type === 'UNIT_REMOVED' && event.unitId === 1 && event.reason === 'DEATH'));
  assert.equal(first.battle.result.reason, 'SCHEDULE_COMPLETED');
  assert.equal(first.battle.result.spawnedCount, 1);
  assert.equal(first.battle.result.completedRouteCount, 0);
  assert.deepEqual(first.battle.result.remainingUnitIds, [0]);
  assert.equal(first.battle.snapshot().blockingRelations.length, 0);
});

test('core combat: fence units cannot block ground enemies or attack them outside their range', () => {
  const spec = createLegacyCombatSpec({
    rows: 1, columns: 3, maxTicks: 2,
    operators: [{ definition: guard({
      stats: { maxHp: 1000, atk: 10, def: 0, blockCnt: 1, bat: 0.1 }, rangeGrid: [[0, 0]],
    }), position: [0, 1] }],
    enemies: [{ definition: walker({ hp: 1000, atk: 1, speed: 0, bat: 0.1 }),
      route: coreCombatRoute([0, 0], { endPosition: [0, 2], spawnOffset: [0.35, 0] }) }],
  });
  for (const passableMask of ['FLY_ONLY', 'NONE', 'ALL', 'WALK_ONLY']) {
    const map = createBattlefieldMap(1, 3, spec.map.tiles.map((tile, index) =>
      index === 1 ? createTile({ ...tile, passableMask }) : tile));
    const battle = new BattleRuntime({ ...spec, map });
    const blocksGround = passableMask === 'ALL' || passableMask === 'WALK_ONLY';
    for (let tick = 0; tick < 2; tick++) {
      const { events } = battle.step();
      assert.deepEqual(battle.snapshot().blockingRelations, blocksGround
        ? [{ blockerUnitId: 0, blockedUnitId: 1 }] : [], passableMask);
      assert.deepEqual(events.filter(event => event.type === 'ACTION').map(event => event.sourceUnitId),
        blocksGround && tick === 0 ? [0, 1] : [], passableMask);
    }
  }
});

test('core combat: lethal damage caps HP loss and dead units cannot act or be selected later in the phase', () => {
  const options = {
    rows: 3, columns: 10,
    operators: [0, 1].map(index => ({
      definition: guard({ id: `core_guard_${index}`, stats: { maxHp: 1000, atk: 100, def: 0, blockCnt: 1 }, rangeGrid: [[0, 0], [0, 1]] }),
      position: [1 + index, 5],
    })),
    enemies: [{ definition: walker({ hp: 7, atk: 100000, speed: 0 }), route: coreCombatRoute([1, 6], { spawnOffset: [-0.6, 0] }) }],
  };
  const battle = createLegacyCombatBattle(options);
  const { events } = battle.step();
  const damage = events.filter(event => event.type === 'DAMAGE');

  assert.deepEqual(damage.map(event => [event.sourceUnitId, event.targetUnitId, event.amount, event.hp]), [[0, 2, 7, 0]]);
  assert.equal(events.filter(event => event.type === 'ACTION').length, 1);
  assert.equal(battle.snapshot().units.find(unit => unit.id === 0).vitality.hp, 1000);
  assert.equal(battle.snapshot().units.some(unit => unit.id === 2), false);
  assert.equal(battle.snapshot().blockingRelations.length, 0);
});

test('core visibility: consecutive attacks consume the current target HP within one combat phase', () => {
  const battle = createLegacyCombatBattle({
    rows: 3, columns: 10,
    operators: [0, 1].map(index => ({
      definition: guard({ id: `current_hp_guard_${index}`, stats: { maxHp: 1000, atk: 10, def: 0, blockCnt: 1 },
        rangeGrid: [[0, 0], [0, 1], [-1, 0], [-1, 1]] }),
      position: [1 + index, 5],
    })),
    enemies: [{ definition: walker({ hp: 25, atk: 0, def: 0, speed: 0 }),
      route: coreCombatRoute([1, 6], { spawnOffset: [-0.6, 0] }) }],
  });
  const { events } = battle.step();
  const damage = events.filter(event => event.type === 'DAMAGE' && event.sourceUnitId < 2);

  assert.deepEqual(damage.map(event => [event.sourceUnitId, event.targetUnitId, event.amount, event.hp]),
    [[0, 2, 10, 15], [1, 2, 10, 5]]);
  assert.equal(battle.snapshot().units.find(unit => unit.id === 2).vitality.hp, 5);
});

test('core visibility: later enemies immediately see a new blocker after the previous blocker dies', () => {
  const battle = createLegacyCombatBattle({
    rows: 3, columns: 10,
    operators: [
      { definition: guard({ id: 'available_front', stats: { maxHp: 1000, atk: 100, def: 0, blockCnt: 3 } }), position: [1, 6] },
      { definition: guard({ id: 'doomed_back', stats: { maxHp: 10, atk: 0, def: 0, blockCnt: 2 } }), position: [1, 5] },
    ],
    enemies: [
      { definition: walker({ key: 'front_target', hp: 1, atk: 0, def: 0, speed: 0 }),
        route: coreCombatRoute([1, 7], { spawnOffset: [-0.4, 0] }) },
      { definition: walker({ key: 'back_killer', hp: 1000, atk: 1000, def: 0, speed: 0 }),
        route: coreCombatRoute([1, 6], { spawnOffset: [-0.6, 0] }) },
      { definition: walker({ key: 'later_enemy', hp: 1000, atk: 10, def: 0, speed: 0 }),
        route: coreCombatRoute([1, 6], { spawnOffset: [-0.6, 0] }) },
    ],
  });
  const { events } = battle.step();

  assert.deepEqual(events.filter(event => event.type === 'UNIT_REMOVED').map(event => event.unitId), [2, 1]);
  assert.deepEqual(events.filter(event => event.type === 'ACTION').map(event => [event.sourceUnitId, event.targetUnitId]),
    [[0, 2], [1, 3], [3, 1], [4, 0]]);
  assert.equal(battle.snapshot().units.find(unit => unit.id === 0).vitality.hp, 990);
  assert.deepEqual(battle.snapshot().blockingRelations,
    [{ blockerUnitId: 0, blockedUnitId: 3 }, { blockerUnitId: 0, blockedUnitId: 4 }]);
});

test('core combat: air targeting follows unit data independently of the route motion mode', () => {
  const battle = createLegacyCombatBattle({
    rows: 3, columns: 10,
    operators: [
      { definition: guard({ canHitFly: false, rangeGrid: [[0, 0], [0, 1]] }), position: [1, 5] },
      { definition: sniper({ canHitFly: true, projectile: 'none', rangeGrid: [[-1, 0], [-1, 1]] }), position: [2, 5] },
    ],
    enemies: [{ definition: enemyRec({ key: 'core_air', hp: 1e6, speed: 0, motion: 'FLY' }), route: coreCombatRoute([1, 6]) }],
  });
  const { events } = battle.step();

  assert.deepEqual(events.filter(event => event.type === 'ACTION').map(event => event.sourceUnitId), [1]);
  assert.equal(battle.snapshot().blockingRelations.length, 0);
  assert.equal(battle.snapshot().units.find(unit => unit.id === 2).layer.type, 'AIR');
});

test('core combat: damage formulas retain the 5% floor and immutable vitality transitions', () => {
  for (const [type, defense, resistance, expected] of [
    ['PHYSICAL', 300, 0, 700], ['PHYSICAL', 2000, 0, 50],
    ['ARTS', 0, 30, 700], ['ARTS', 0, 100, 50], ['TRUE', 9999, 100, 1000],
  ]) {
    const receiver = initialize({ id: 0, position: [0, 0], definition: {
      id: 'formula-target', vitality: { maxHp: 5000, defense, resistance },
    } });
    const battle = createBattleState(fixtureBattlefieldState([receiver]));
    assert.equal(calculateDamage(battle, { source: null, target: unitRef(receiver), parameters: parameters(1000, type) }).value.amount, expected);
  }

  const unit = initialize({
    id: 0, position: [0, 0],
    definition: { id: 'core_target', vitality: { maxHp: 7, defense: 0, resistance: 0 } },
  });
  const state = createBattleState(fixtureBattlefieldState([unit]));

  const request = power => ({ source: null, target: unitRef(unit), parameters: parameters(power, 'TRUE') });
  const harmless = dealDamage(state, request(0));
  const lethal = dealDamage(state, request(1000));

  assert.equal(getUnit(harmless.state, 0), unit);
  assert.equal(harmless.value.kind, 'REJECTED');
  assert.equal(lethal.value.kind, 'APPLIED');
  assert.equal(lethal.value.application.hpLoss, 7);
  assert.equal(getUnit(lethal.state, 0), undefined);
  assert.equal(lethal.state.removedUnits[0].unit.vitality.hp, 0);
  assert.equal(unit.vitality.hp, 7);
});

test('core combat: snapshots share capabilities while immutable battlefield updates preserve earlier facts', () => {
  const input = createLegacyCombatSpec({
    rows: 3, columns: 10,
    operators: [{ definition: guard({ stats: { atk: 0, maxHp: 1e6, blockCnt: 1 } }), position: [1, 5] }],
    enemies: [{ definition: walker({ speed: 0 }), route: coreCombatRoute([1, 6], { spawnOffset: [-0.6, 0] }) }],
  });
  const battle = new BattleRuntime(input);
  const replay = new BattleRuntime(input);
  assert.deepEqual(battle.step(), replay.step());
  const snapshot = battle.snapshot();
  const repeated = battle.snapshot();
  const operator = snapshot.units.find(unit => unit.id === 0);
  const sharedOperator = repeated.units.find(unit => unit.id === 0);
  const actionId = operator.definition.action.definitions.values().toArray()[0].id;
  const readyAtTick = operator.action.states.get(actionId).cooldown.readyAtTick;
  const hp = operator.vitality.hp;
  for (const key of ['action', 'allegiance', 'layer', 'hitbox', 'effects', 'blocker', 'vitality']) {
    assert.equal(sharedOperator[key], operator[key], key);
  }
  assert.equal(repeated.blockingRelations, snapshot.blockingRelations);
  assert.deepEqual(snapshot.blockingRelations, [{ blockerUnitId: 0, blockedUnitId: 1 }]);

  const units = new Map(snapshot.units.map(unit => [unit.id, unit]));
  let battlefield = fixtureBattlefieldState({ map: input.map,
    unitIds: [...units.keys()], getUnit: id => units.get(id),
    blockingRelations: snapshot.blockingRelations,
  });
  const previous = battlefieldView({ battlefield });
  const changed = {
    ...operator,
    action: { ...operator.action, states: operator.action.states.read(actionId, current => operator.action.states.replace(current.definition, { ...current, cooldown: { ...current.cooldown, readyAtTick: 999999 } })) },
    allegiance: { ...operator.allegiance, side: 'ENEMY' },
    layer: { ...operator.layer, type: 'AIR' },
    targetable: setRestriction(operator.targetable,
      { id: 'changed-targeting', value: { kind: Symbol('changed-targeting'), allows: () => false } }),
    blocker: { ...operator.blocker, capacity: contribution.set([], { id: 'disabled-capacity', value: [modifier.create({ finalScaler: 0 })],
    }) },
    vitality: { ...operator.vitality, hp: 0 },
  };
  battlefield = replaceUnits(battlefield, [changed]);
  const draft = battlefieldView({ battlefield });
  assert.equal(draft.getUnit(0), changed);
  assert.deepEqual(draft.blockingRelations, []);
  assert.equal(draft.getUnit(0).action.states.get(actionId).cooldown.readyAtTick, 999999);
  const targetingRequest = { source: unitRef(snapshot.units.find(unit => unit.id === 1)),
    ...operator.definition.action.definitions.values().toArray()[0].attack.targetGroups[0].targeting };
  assert.equal(allowsRestrictions({ battlefield }, targetingRequest, draft.getUnit(0)), false);
  assert.equal(draft.getUnit(0), changed);

  assert.equal(previous.getUnit(0), operator);
  assert.deepEqual(previous.blockingRelations, [{ blockerUnitId: 0, blockedUnitId: 1 }]);
  assert.equal(operator.action.states.get(actionId).cooldown.readyAtTick, readyAtTick);
  assert.equal(operator.allegiance.side, 'ALLY');
  assert.equal(operator.layer.type, 'GROUND');
  assert.equal(operator.definition.hitbox.shape.radius, 0.25);
  assert.equal(allowsRestrictions({ battlefield: previous }, targetingRequest, operator), true);
  assert.deepEqual(operator.blocker.capacity, []);
  assert.equal(operator.vitality.hp, hp);
  assert.deepEqual(battle.snapshot(), snapshot);
  assert.deepEqual(battle.step(), replay.step());
  assert.deepEqual(battle.snapshot(), replay.snapshot());
  assert.deepEqual(snapshot.blockingRelations, [{ blockerUnitId: 0, blockedUnitId: 1 }]);
  assert.equal(operator.vitality.hp, hp);
});

test('core combat: a rejected tick preserves spawn identities, action state, HP and blocking', () => {
  const options = {
    rows: 3, columns: 10,
    operators: [{ definition: guard({ stats: { atk: 100, maxHp: 1e6, blockCnt: 1 } }), position: [1, 5] }],
    enemies: [{ definition: walker({ hp: 1000, speed: 0 }), route: coreCombatRoute([1, 6], { spawnOffset: [-0.6, 0] }) }],
  };
  const battle = createLegacyCombatBattle(options);
  const before = battle.snapshot();

  assert.throws(() => battle.step([{ type: 'CLEAR_ALTERNATIVE_ROUTE', unitId: 999999 }]), /unknown alternative route unit/);
  assert.deepEqual(battle.snapshot(), before);
});

test('core combat: the limited legacy adapter rejects unsupported content and preserves interval conversion', () => {
  const options = {
    rows: 3, columns: 10,
    operators: [{ definition: guard({ stats: { bat: 0.5, aspd: 200 } }), position: [1, 5] }],
    enemies: [{ definition: walker({ bat: 2, aspd: 100, speed: 1 }), route: coreCombatRoute() }],
  };
  const battle = createLegacyCombatBattle(options);
  assert.equal(battle.snapshot().units[0].definition.action.definitions.values().toArray()[0].intervalTicks, 15);
  battle.step();
  const enemy = battle.snapshot().units.find(unit => unit.id === 1);

  assert.equal(enemy.definition.action.definitions.values().toArray()[0].intervalTicks, 60);
  assert.equal(battle.snapshot().units[0].definition.action.definitions.values().toArray()[0].speed, 200);
  assert.equal(enemy.definition.locomotion.speed, 1 / 60);
  assert.throws(() => createLegacyCombatBattle({ ...options, operators: [{ definition: guard({ skill: { spCost: 1 } }), position: [1, 5] }] }), /does not execute operator skills/);
  assert.throws(() => createLegacyCombatBattle({ ...options, operators: [{ definition: guard({ dmgType: 'heal' }), position: [1, 5] }] }), /only supports physical, arts and true damage/);
  assert.throws(() => createLegacyCombatBattle({ ...options, operators: [{ definition: guard({ attackKind: 'none' }), position: [1, 5] }] }), /ordinary attacks/);
});

test('stun stops enemy movement and attacks; immunity honoured; statusApplied fires', () => {
  const h = makeBattle({
    defs: { enemies: { enemy_walker: walker({ atk: 100 }), enemy_boss: enemyRec({ key: 'enemy_boss', hp: 1e6, speed: 1, immunities: { stun: true } }) } },
    enemies: [{ key: 'enemy_walker' }, { key: 'enemy_boss', route: 1 }],
    content: 'none', autoFinish: false,
  });
  h.step();
  const e = h.enemy('enemy_walker');
  const boss = h.enemy('enemy_boss');
  assert.equal(h.b.applyStatus(e, 'stun', { duration: 1 }), true);
  assert.equal(h.b.applyStatus(boss, 'stun', { duration: 1 }), false, 'immune');
  const x0 = e.x, bx0 = boss.x;
  h.run(0.9);
  approx(e.x, x0);
  assert.ok(boss.x < bx0, 'boss keeps walking');
  h.run(0.3);
  assert.ok(e.x < x0, 'moves again after stun');
  assert.equal(h.hooksOf('statusApplied').length, 1);
  assert.ok(h.eventsOf('status').some((ev) => ev[1] === e.id && ev[2] === 'stun' && ev[3] === 1));
  assert.ok(h.eventsOf('status').some((ev) => ev[1] === e.id && ev[2] === 'stun' && ev[3] === 0));
});

test('stunned operator neither attacks nor gains SP; silence blocks skill activation', () => {
  const h = makeBattle({
    defs: { chess: { t_guard: guard({ skill: { spCost: 5, initSp: 0, duration: 3, bb: { atk: 0.5 } } }) }, enemies: { enemy_dummy: dummy() } },
    units: [{ chessId: 't_guard', row: 9, col: 5 }], enemies: [{ key: 'enemy_dummy', pos: [9, 6] }], content: 'generic',
  });
  h.step();
  const u = h.unit('t_guard');
  h.b.applyStatus(u, 'stun', { duration: 2 });
  const atk0 = u.stats.attacks;
  h.run(1.9);
  assert.equal(u.stats.attacks, atk0);
  assert.ok(u.skill.sp < 0.2);
  h.b.applyStatus(u, 'silence', { duration: 20 });
  h.run(8);
  assert.ok(u.stats.attacks > atk0, 'attacks after stun');
  assert.equal(u.skill.ready, true);
  assert.equal(u.skill.activations, 0, 'silenced: no cast');
});

test('cold on cold ⇒ freeze 3 s (res −15), frozen-immune enemies only get cold', () => {
  const h = makeBattle({
    defs: { enemies: { enemy_dummy: dummy({ res: 30 }), enemy_icy: enemyRec({ key: 'enemy_icy', speed: 0, hp: 1e6, immunities: { frozen: true } }) } },
    enemies: [{ key: 'enemy_dummy', pos: [11, 8] }, { key: 'enemy_icy', pos: [10, 8] }], content: 'none',
  });
  h.step();
  const e = h.enemy('enemy_dummy');
  const icy = h.enemy('enemy_icy');
  h.b.applyStatus(e, 'cold', { duration: 5 });
  assert.equal(e.s.aspd, 70);
  assert.equal(e.s.flags.freeze, undefined);
  h.b.applyStatus(e, 'cold', { duration: 5 });
  assert.equal(e.s.flags.freeze, true);
  assert.equal(e.s.flags.stun, true);
  assert.equal(e.s.res, 15);
  h.run(3.1);
  assert.ok(!e.s.flags.freeze, 'freeze lasts 3 s');
  h.b.applyStatus(icy, 'cold', { duration: 5 });
  h.b.applyStatus(icy, 'cold', { duration: 5 });
  assert.ok(!icy.s.flags.freeze);
  assert.ok(icy.s.flags.cold);
});

test('sleep: target is untargetable and inactive; fear stops enemy attacks', () => {
  const h = makeBattle({
    defs: { chess: { t_sniper: sniper() }, enemies: { enemy_dummy: dummy() } },
    units: [{ chessId: 't_sniper', row: 11, col: 5 }], enemies: [{ key: 'enemy_dummy', pos: [11, 7] }], content: 'none',
  });
  h.step();
  const e = h.enemy('enemy_dummy');
  h.b.applyStatus(e, 'sleep', { duration: 2 });
  const u = h.unit('t_sniper');
  const a0 = u.stats.attacks;
  h.run(1.5);
  assert.equal(u.stats.attacks, a0, 'sleeping enemy not targeted');
  h.run(1.5);
  assert.ok(u.stats.attacks > a0);
});

test('element bursts on enemies ("·我方" terms): burn 7000 元素伤害 + RES −20 (10 s lock), neural 6000 + 3 麻痹, leaders hold 2000', () => {
  const h = makeBattle({
    defs: { enemies: { enemy_dummy: dummy({ res: 50 }), enemy_lead: enemyRec({ key: 'enemy_lead', hp: 1e6, speed: 0, rank: 'BOSS' }) } },
    enemies: [{ key: 'enemy_dummy', pos: [11, 8] }, { key: 'enemy_lead', pos: [10, 8] }], content: 'none', autoFinish: false,
  });
  h.step();
  const e = h.enemy('enemy_dummy');
  const hp0 = e.hp;
  h.b.dealDamage(null, e, { type: 'element', element: 'burn', amount: 600 });
  approx(e.elem.burn, 600);
  assert.equal(e.hp, hp0, 'element damage fills the gauge only');
  h.b.dealDamage(null, e, { type: 'element', element: 'burn', amount: 600 });
  assert.ok(e.findBuff('burnBurst'));
  approx(hp0 - e.hp, ELEMENT.burn.enemy.elemDamage, 1e-6, '元素伤害 ignores RES');
  assert.equal(e.s.res, 50 - ELEMENT.burn.enemy.resDown);
  h.b.dealDamage(null, e, { type: 'element', element: 'burn', amount: 500 });
  assert.equal(e.elem.burn, 1000, 'locked during burst');
  h.run(10.1);
  assert.equal(e.elem.burn, 0);
  assert.equal(e.s.res, 50);
  // neural: 6000 元素伤害 + 3 麻痹 stacks
  const hp1 = e.hp;
  h.b.dealDamage(null, e, { type: 'element', element: 'neural', amount: 1000 });
  approx(hp1 - e.hp, ELEMENT.neural.enemy.elemDamage);
  assert.equal(e.findBuff('palsy').stacks, ELEMENT.neural.enemy.palsy);
  assert.ok(!e.s.flags.stun, 'enemies are not stunned by a neural burst');
  assert.equal(h.hooksOf('elementBurst').length, 2);
  // 元素脆弱 (elementalTakenMul) multiplies 元素伤害; the gauge's 元素损伤倍率 (elemTakenMul) does not
  h.b.addBuff(e, { key: 'test:ef', mods: { elementalTakenMul: 1.5, elemTakenMul: 3 } });
  const hp2 = e.hp;
  h.b.dealDamage(null, e, { amount: 100, type: 'elemental', element: 'burn' });
  approx(hp2 - e.hp, 150);
  // leaders need 2000
  const L = h.enemy('enemy_lead');
  assert.equal(L.gaugeMax, 2000);
  h.b.dealDamage(null, L, { type: 'element', element: 'burn', amount: 1500 });
  assert.ok(!L.findBuff('burnBurst'));
  h.b.dealDamage(null, L, { type: 'element', element: 'burn', amount: 600 });
  assert.ok(L.findBuff('burnBurst'));
});

test('element bursts on enemies: apoptosis = 800 元素伤害/s + 50 % weaken recovering; erosion = 5000 + permanent DEF −120 (8 s lock)', () => {
  const h = makeBattle({ defs: { enemies: { enemy_dummy: dummy({ atk: 1000, def: 500 }) } }, enemies: [{ key: 'enemy_dummy', pos: [11, 8] }], content: 'none', autoFinish: false });
  h.step();
  const e = h.enemy('enemy_dummy');
  h.b.dealDamage(null, e, { type: 'element', element: 'apoptosis', amount: 1000 });
  approx(e.s.atk, 500, 1e-6, '50 % weaken at the start');
  const hp0 = e.hp;
  h.run(5.02);
  approx(hp0 - e.hp, 5 * ELEMENT.apoptosis.enemy.elemDps, 1e-6);
  assert.ok(e.s.atk > 500 && e.s.atk < 1000, `weaken recovers (${e.s.atk})`);
  h.run(10.1);
  assert.ok(!e.findBuff('apoptosisBurst'));
  approx(e.s.atk, 1000);
  const hp1 = e.hp;
  h.b.dealDamage(null, e, { type: 'element', element: 'erosion', amount: 1000 });
  approx(hp1 - e.hp, ELEMENT.erosion.enemy.elemDamage);
  assert.equal(e.s.def, 500 - ELEMENT.erosion.enemy.defDown);
  assert.equal(e.elem.erosion, 1000, 'locked for 8 s');
  h.run(8.1);
  assert.equal(e.elem.erosion, 0);
  h.b.dealDamage(null, e, { type: 'element', element: 'erosion', amount: 1000 });
  assert.equal(e.s.def, 500 - 2 * ELEMENT.erosion.enemy.defDown, 'stacks, permanent');
});

test('element bursts on operators (enemy damage): burn 1200 arts, neural stun 10 s then 1000 true, apoptosis 阻回 + no skill / −1 SP/s / 100 arts/s, erosion DEF −100 then 800 phys (10 s cooldown)', () => {
  const op = chessRec({ id: 't_op', profession: 'WARRIOR', stats: { atk: 0, maxHp: 1e6, def: 300, res: 0, blockCnt: 0 }, skill: { spCost: 30, initSp: 20, duration: 5, bb: { atk: 0.5 } } });
  const h = makeBattle({ defs: { chess: { t_op: op } }, units: [{ chessId: 't_op', row: 9, col: 5 }], content: 'generic', autoFinish: false, timeLimit: 120 });
  h.step();
  const u = h.unit('t_op');
  let hp = u.hp;
  h.b.dealDamage(null, u, { type: 'element', element: 'burn', amount: 1000 });
  approx(hp - u.hp, ELEMENT.burn.ally.damage);
  h.run(ELEMENT.burn.ally.duration + 0.1); // the burn cooldown holds every gauge
  hp = u.hp;
  let stunned = null;
  h.b.on('damaged', (c) => { if (c.target === u && c.type === 'true' && stunned == null) stunned = !!u.s.flags.stun; });
  h.b.dealDamage(null, u, { type: 'element', element: 'neural', amount: 1000 });
  approx(hp - u.hp, ELEMENT.neural.ally.damage);
  assert.equal(stunned, true, 'PRTS: "立刻获得等时长的眩晕；随后受到1000点…真实伤害" — stunned before the hit');
  approx(u.findBuff('stun').timeLeft, ELEMENT.neural.ally.stun);
  h.run(10.1);
  const sp0 = u.skill.sp;
  hp = u.hp;
  h.b.dealDamage(null, u, { type: 'element', element: 'apoptosis', amount: 1000 });
  assert.ok(u.s.flags.silence, 'no skill activation');
  assert.ok(u.s.flags.noSp, '阻回: no SP recovery');
  h.run(3.02);
  approx(hp - u.hp, 3 * ELEMENT.apoptosis.ally.dps);
  approx(u.skill.sp, sp0 - 3 * ELEMENT.apoptosis.ally.spLossPerSec, 0.05);
  const spHeld = u.skill.sp;
  assert.ok(spHeld < u.skill.spCost && !u.skill.active, 'room for SP (a 0 below is 阻回, not a full bar)');
  assert.equal(u.skill.gainSp(5, 'talent'), 0, '阻回 ("停止并阻止任意形式的技力回复"): no granted SP');
  assert.equal(u.skill.gainSp(1, 'hurt'), 0, '… nor SP from hits taken');
  assert.equal(u.skill.gainSp(1, 'attack'), 0, '… nor from attacks');
  assert.equal(u.skill.sp, spHeld);
  h.run(12.1);
  assert.ok(!u.s.flags.silence && !u.s.flags.noSp);
  hp = u.hp;
  h.b.dealDamage(null, u, { type: 'element', element: 'erosion', amount: 1000 });
  approx(hp - u.hp, ELEMENT.erosion.ally.damage - (300 - ELEMENT.erosion.ally.defDown), 1e-6, 'DEF cut first, then 800 phys');
  assert.equal(u.s.def, 300 - ELEMENT.erosion.ally.defDown);
  assert.equal(ELEMENT.erosion.ally.duration, 10, 'PRTS 元素: 侵蚀 爆发 10 s on operators');
  assert.equal(u.elem.erosion, 1000, 'held full during its cooldown');
  h.run(10.1);
  assert.equal(u.elem.erosion, 0, 'reset when the cooldown ends');
  h.b.dealDamage(null, u, { type: 'element', element: 'erosion', amount: 1000 });
  assert.equal(u.findBuff('erosionDown').stacks, 2, 'the DEF cut stacks (permanent)');
});

test('爆发冷却 (PRTS 元素): during a burst no element fills or recovers; its end resets every gauge; 损伤抵抗 = epResistance %', () => {
  const resRec = enemyRec({ key: 'enemy_res', hp: 1e6, speed: 0 });
  resRec.stats.elementRes = 10;
  const h = makeBattle({
    defs: { enemies: { enemy_dummy: dummy(), enemy_res: resRec } },
    enemies: [{ key: 'enemy_dummy', pos: [11, 8] }, { key: 'enemy_res', pos: [10, 8] }], content: 'none', autoFinish: false,
  });
  h.step();
  const e = h.enemy('enemy_dummy');
  h.b.dealDamage(null, e, { type: 'element', element: 'neural', amount: 400 });
  h.b.dealDamage(null, e, { type: 'element', element: 'burn', amount: 1000 });
  assert.ok(e.findBuff('burnBurst') && e.s.flags.burstLock);
  assert.equal(h.b.dealDamage(null, e, { type: 'element', element: 'neural', amount: 1000 }), 0, 'another element cannot fill during the cooldown');
  approx(e.elem.neural, 400);
  assert.equal(h.b.reduceElement(e, 300), 0, 'nor be recovered');
  h.run(ELEMENT.burn.enemy.duration - 0.2);
  assert.equal(e.elem.burn, 1000);
  h.run(0.3);
  assert.deepEqual([e.elem.burn, e.elem.neural, e.elem.apoptosis, e.elem.erosion], [0, 0, 0, 0], 'every gauge restored');
  h.b.dealDamage(null, e, { type: 'element', element: 'neural', amount: 300 });
  approx(e.elem.neural, 300, 1e-6, 'fills again after the cooldown');
  // 损伤抵抗 (data elementRes → epResistance, a percentage): 受到的元素损伤 = 损伤值 × (1 − 损伤抵抗 × 0.01)
  const r = h.enemy('enemy_res');
  assert.equal(r.def.epResistance, 10);
  h.b.dealDamage(null, r, { type: 'element', element: 'burn', amount: 500 });
  approx(r.elem.burn, 450);
});

test('a resolving burst already locks its gauge: an elementBurst handler spreading the element back cannot re-burst (no ping-pong recursion)', () => {
  // two operators that spread every burst to each other (the 淤困 parasite pattern) — every burst has its cooldown
  // (erosion on operators too: 10 s), apoptosis locks with a ticker: each must burst exactly once per fill
  const op = (id) => chessRec({ id, profession: 'WARRIOR', stats: { atk: 0, maxHp: 1e6, def: 300, res: 0, blockCnt: 0 }, skill: null });
  for (const el of ['burn', 'erosion', 'apoptosis', 'neural']) {
    const h = makeBattle({
      defs: { chess: { t_a: op('t_a'), t_b: op('t_b') } },
      units: [{ chessId: 't_a', row: 9, col: 5 }, { chessId: 't_b', row: 9, col: 6 }], content: 'none', autoFinish: false,
      extraContent: [{ install(battle) {
        battle.on('elementBurst', (c) => {
          for (const o of battle.units) if (o.side === 'ally' && o.alive && o.deployed) battle.dealDamage(null, o, { type: 'element', element: c.element, amount: 5000 });
        });
      } }],
    });
    h.step();
    const A = h.unit('t_a'), B = h.unit('t_b');
    const hpA = A.hp, hpB = B.hp;
    h.b.dealDamage(null, A, { type: 'element', element: el, amount: 1000 });
    assert.deepEqual(h.b.errors.map((e) => e.label), [], `${el}: no hook-depth errors`);
    assert.deepEqual(h.hooksOf('elementBurst').map((c) => c.target.defId).sort(), ['t_a', 't_b'], `${el}: one burst per unit`);
    assert.ok(A.alive && B.alive);
    if (el === 'burn') { approx(hpA - A.hp, ELEMENT.burn.ally.damage); approx(hpB - B.hp, ELEMENT.burn.ally.damage); }
    if (el === 'erosion') {
      for (const u of [A, B]) assert.equal(u.findBuff('erosionDown').stacks, 1, 'one permanent DEF cut');
      h.b.dealDamage(null, A, { type: 'element', element: 'erosion', amount: 1000 });
      assert.equal(A.findBuff('erosionDown').stacks, 1, 'locked during its 10 s cooldown');
      h.run(ELEMENT.erosion.ally.duration + 0.1);
      assert.equal(A.elem.erosion, 0, 'reset once the cooldown ended');
      h.b.dealDamage(null, A, { type: 'element', element: 'erosion', amount: 1000 });
      assert.equal(A.findBuff('erosionDown').stacks, 2, 'a later fill bursts again');
    }
    assert.ok(!A.burstPending?.[el] && !B.burstPending?.[el], 'pending marker cleared');
  }
});

test('淤困 (enemy_9007_acelem) parasite hosts side by side: one burst spreads once, no ping-pong', () => {
  const h = makeBattle({
    seed: 3,
    units: [{ chessId: 'chess_char_4_17_a', row: 9, col: 5 }, { chessId: 'chess_char_2_08_a', row: 10, col: 5 }],
    enemies: [{ key: 'enemy_9007_acelem', pos: [9, 7], route: { motion: 'WALK', start: [9, 7], end: [9, 2], checkpoints: [] } },
      { key: 'enemy_9007_acelem', pos: [10, 7], route: { motion: 'WALK', start: [10, 7], end: [9, 2], checkpoints: [[10, 3]] } }],
    hooks: ['elementBurst'],
  });
  const A = h.unit('chess_char_4_17_a'), B = h.unit('chess_char_2_08_a');
  assert.ok(h.runUntil(() => A.findBuff('ab:parasite') && B.findBuff('ab:parasite'), 20), 'both defenders parasitised');
  const hpA = A.hp, hpB = B.hp;
  h.eventsOf('dmg'); // drain into h.events
  const ev0 = h.events.length;
  h.b.dealDamage(null, A, { type: 'element', element: 'burn', amount: 1000 });
  assert.deepEqual(h.b.errors.map((e) => e.label), []);
  assert.equal(h.hooksOf('elementBurst').length, 2, 'A bursts, the spread bursts B, B\'s spread back to A is locked out');
  assert.ok(A.alive && B.alive, `defenders survive (${Math.round(A.hp)}/${Math.round(B.hp)})`);
  assert.ok(A.findBuff('burnBurst') && B.findBuff('burnBurst'));
  h.eventsOf('dmg');
  const burstHit = (u) => h.events.slice(ev0).filter((e) => e[0] === 'dmg' && e[1] === u.id && e[3] === 'arts').length;
  assert.equal(burstHit(A), 1, 'one 灼燃 burst hit on A');
  assert.equal(burstHit(B), 1, 'one 灼燃 burst hit on B');
  assert.ok(hpA - A.hp < 2 * ELEMENT.burn.ally.damage && hpB - B.hp < 2 * ELEMENT.burn.ally.damage);
});

test('statuses (official terms): tremble only stops attacks while blocked; fear = unblockable + no attack + no advance (no source: it stays on its tile, fear.js); stunned blocker lets go', () => {
  const g = chessRec({ id: 't_guard', profession: 'WARRIOR', stats: { atk: 0, blockCnt: 2, maxHp: 1e6 }, skill: null });
  const h = makeBattle({
    defs: { chess: { t_guard: g }, enemies: { enemy_walker: walker({ atk: 100, bat: 1 }) } },
    units: [{ chessId: 't_guard', row: 9, col: 6 }], enemies: [{ key: 'enemy_walker' }], content: 'none', autoFinish: false, timeLimit: 120,
  });
  const u = h.unit('t_guard');
  assert.ok(h.runUntil(() => h.enemies()[0]?.blockedBy === u, 20));
  const e = h.enemies()[0];
  h.b.applyStatus(e, 'tremble', { duration: 3 });
  const a0 = e.stats.attacks;
  h.run(2.5);
  assert.equal(e.stats.attacks, a0, 'trembling + blocked: no normal attack');
  h.run(1);
  assert.ok(e.stats.attacks > a0, 'attacks again');
  // stun on the blocker: releases the enemy; it is re-blocked once the stun ends
  h.b.applyStatus(u, 'stun', { duration: 1 });
  assert.equal(e.blockedBy, null, 'a stunned operator blocks nothing');
  assert.equal(u.blocking.length, 0);
  h.run(1.2);
  // fear: released, no attacks, does not advance — without a source there is no 恐惧可达地块: it flutters on its own tile
  if (!e.blockedBy) assert.ok(h.runUntil(() => e.blockedBy === u, 20));
  h.b.applyStatus(e, 'fear', { duration: 2 });
  assert.equal(e.blockedBy, null);
  const x0 = e.x, a1 = e.stats.attacks, tc = Math.round(e.x);
  h.run(1.9);
  assert.ok(Math.abs(e.x - tc) <= 0.5 && Math.round(e.x) === Math.round(x0), `stays on its tile (${x0} → ${e.x})`);
  assert.equal(e.blockedBy, null);
  assert.equal(e.stats.attacks, a1);
  h.run(0.5);
  assert.ok(e.blockedBy === u || e.x < x0, 'walks / is blocked again after the fear');
});

test('statuses: sleep = invulnerable except `hitSleep` attackers; levitate halves on heavy units; frozen RES cut only on enemies', () => {
  const h = makeBattle({
    defs: { enemies: { enemy_dummy: dummy(), enemy_heavy: enemyRec({ key: 'enemy_heavy', hp: 1e6, speed: 0, mass: 4 }) } },
    units: [{ chessId: 'chess_char_1_18_a', row: 9, col: 3 }], enemies: [{ key: 'enemy_dummy', pos: [11, 8] }, { key: 'enemy_heavy', pos: [10, 8] }], content: 'none', autoFinish: false,
  });
  h.step();
  const e = h.enemy('enemy_dummy');
  h.b.applyStatus(e, 'sleep', { duration: 5 });
  assert.equal(h.b.dealDamage(null, e, { amount: 100, type: 'true' }), 0, 'sleepers take no damage');
  assert.equal(h.b.dealDamage(null, e, { amount: 100, type: 'true', ignoreSleep: true }), 100);
  const fake = { side: 'ally', s: { dmgDealtMul: 1, physDealtMul: 1, artsDealtMul: 1, defIgnorePct: 0, defIgnoreFlat: 0, resIgnorePct: 0, resIgnoreFlat: 0 }, profile: { hitSleep: true }, stats: { dmg: 0 }, ownerId: 'p1' };
  assert.equal(h.b.dealDamage(fake, e, { amount: 100, type: 'true' }), 100, 'hitSleep attacker');
  const heavy = h.enemy('enemy_heavy');
  h.b.applyStatus(heavy, 'levitate', { duration: 4 });
  approx(heavy.findBuff('levitate').timeLeft, 2);
  h.b.applyStatus(e, 'levitate', { duration: 4 });
  approx(e.findBuff('levitate').timeLeft, 4);
  const op = h.unit('chess_char_1_18_a');
  const r0 = op.s.res;
  h.b.applyStatus(op, 'freeze', { duration: 2 });
  assert.equal(op.s.res, r0, 'operators keep their RES when frozen');
  assert.ok(op.s.flags.freeze);
});

test('statuses: "同名效果取最高" — a weaker fragile never overrides a stronger one and resumes after it; palsy cancels attacks', () => {
  const g = chessRec({ id: 't_guard', profession: 'WARRIOR', stats: { atk: 0, blockCnt: 2, maxHp: 1e6 }, skill: null });
  const h = makeBattle({
    defs: { chess: { t_guard: g }, enemies: { enemy_dummy: dummy({ atk: 100, bat: 1 }) } },
    units: [{ chessId: 't_guard', row: 11, col: 8 }], enemies: [{ key: 'enemy_dummy', pos: [11, 8] }], content: 'none', autoFinish: false,
  });
  h.step();
  const e = h.enemy('enemy_dummy');
  h.b.applyStatus(e, 'fragile', { duration: 2, value: 0.3 });
  h.b.applyStatus(e, 'fragile', { duration: 5, value: 0.1 });
  approx(e.s.dmgTakenMul, 1.3, 1e-9, 'the weaker one does not override');
  h.run(2.1);
  approx(e.s.dmgTakenMul, 1.1, 1e-9, 'the weaker one resumes after the stronger ends');
  h.run(3.1);
  approx(e.s.dmgTakenMul, 1);
  h.b.applyStatus(e, 'fragile', { duration: 5, value: 0.1 });
  h.b.applyStatus(e, 'fragile', { duration: 1, value: 0.4 });
  approx(e.s.dmgTakenMul, 1.4, 1e-9, 'a stronger one takes over');
  h.run(1.1);
  approx(e.s.dmgTakenMul, 1.1, 1e-9, 'the longer weaker one comes back');
  // palsy: 2 stacks cancel 2 attacks
  const u = h.unit('t_guard');
  assert.ok(h.runUntil(() => e.blockedBy === u, 10));
  h.b.applyStatus(e, 'palsy', { value: 2 });
  const a0 = e.stats.attacks;
  h.run(2.05);
  assert.equal(e.stats.attacks, a0, 'two attacks interrupted');
  assert.ok(!e.findBuff('palsy'));
  h.run(1.1);
  assert.ok(e.stats.attacks > a0);
});

test('beforeStatus may change the duration / value; NEVER trigger never auto-casts; dodge sources roll independently; no SP while a timed skill runs', () => {
  const op = chessRec({ id: 't_op', profession: 'WARRIOR', stats: { atk: 100, blockCnt: 1 }, skill: { spCost: 2, initSp: 2, duration: 5, bb: { atk: 0.5 } } });
  const h = makeBattle({
    defs: { chess: { t_op: op }, enemies: { enemy_dummy: dummy() } },
    units: [{ chessId: 't_op', row: 11, col: 7 }], enemies: [{ key: 'enemy_dummy', pos: [11, 8] }], content: 'generic', autoFinish: false,
    kits: { t_op: () => ({ skill: { kind: 'duration', trigger: 'NEVER', mods: { atkPct: 0.5 } } }) },
    setup: (b) => b.on('beforeStatus', (c) => { if (c.status === 'slow') { c.duration *= 2; c.value = 0.9; } }),
  });
  h.step();
  const e = h.enemy('enemy_dummy');
  h.b.applyStatus(e, 'slow', { duration: 1.5, value: 0.2 });
  approx(e.findBuff('slow').timeLeft, 3);
  approx(e.s.moveSpeed, e.base.moveSpeed * 0.1);
  const u = h.unit('t_op');
  h.run(4);
  assert.ok(u.skill.ready && u.stats.attacks > 0);
  assert.equal(u.skill.activations, 0, 'NEVER: no auto-cast');
  assert.equal(u.skill.activate('manual'), true);
  assert.equal(u.skill.gainSp(5, 'talent'), 0, 'no SP while the timed skill runs');
  h.b.addBuff(u, { key: 'd1', mods: { dodgePhys: 0.5 } });
  h.b.addBuff(u, { key: 'd2', mods: { dodgePhys: 0.5 } });
  approx(u.s.dodgePhys, 0.75, 1e-9, '1 − 0.5 × 0.5');
});

test('blocking: capacity, heavy enemies, release on blocker death', () => {
  const h = makeBattle({
    defs: {
      chess: { t_guard: guard({ stats: { atk: 0, blockCnt: 2, maxHp: 1e6 } }) },
      enemies: { enemy_walker: walker(), enemy_heavy: enemyRec({ key: 'enemy_heavy', hp: 1e6, speed: 1, blockCnt: 3 }) },
    },
    units: [{ chessId: 't_guard', row: 9, col: 6 }],
    enemies: [{ key: 'enemy_walker', count: 3, interval: 0.5 }, { key: 'enemy_heavy', time: 0.2 }],
    content: 'none', autoFinish: false,
  });
  const g = h.unit('t_guard');
  h.run(12);
  assert.equal(g.blocking.length, 2, 'blocks exactly 2');
  const blocked = h.enemies().filter((e) => e.blockedBy === g);
  assert.equal(blocked.length, 2);
  const passed = h.enemies().filter((e) => !e.blockedBy);
  assert.ok(passed.length === 0 || passed.every((e) => e.x < 6), 'others walked through');
  assert.ok(h.hooksOf('blocked').length >= 2);
  const heavy = h.b.units.find((u) => u.defId === 'enemy_heavy');
  assert.notEqual(heavy.blockedBy, g, 'blockCnt 3 enemy cannot be blocked by capacity 2');
  h.b.dealDamage(null, g, { amount: 1e9, type: 'true' });
  assert.equal(g.alive, false);
  assert.equal(g.blocking.length, 0);
  for (const e of blocked) assert.equal(e.blockedBy, null);
  const bx = blocked[0].x;
  h.run(1);
  assert.ok(blocked[0].x < bx || !blocked[0].alive, 'released enemy moves on');
});

test('blocked melee enemy attacks its blocker', () => {
  const h = makeBattle({
    defs: { chess: { t_guard: guard({ stats: { atk: 0, maxHp: 1e6 } }) }, enemies: { enemy_walker: walker({ atk: 500 }) } },
    units: [{ chessId: 't_guard', row: 9, col: 7 }], enemies: [{ key: 'enemy_walker' }], content: 'none', autoFinish: false,
  });
  h.run(10);
  const g = h.unit('t_guard');
  assert.ok(g.stats.taken > 0);
  assert.ok(g.hp < g.s.maxHp);
});

test('melee operators cannot hit FLY enemies; ranged ones can', () => {
  const h = makeBattle({
    defs: { chess: { t_guard: guard({ rangeGrid: [[0, 0], [0, 1], [0, 2]] }), t_sniper: sniper() }, enemies: { enemy_fly: enemyRec({ key: 'enemy_fly', hp: 1e6, speed: 0, motion: 'FLY' }) } },
    units: [{ chessId: 't_guard', row: 9, col: 5 }, { chessId: 't_sniper', row: 10, col: 4 }],
    enemies: [{ key: 'enemy_fly', pos: [9, 6], route: 2 }], content: 'none',
  });
  h.run(3);
  assert.equal(h.unit('t_guard').stats.attacks, 0);
  assert.ok(h.unit('t_sniper').stats.attacks > 0);
  assert.equal(h.enemy('enemy_fly').blockedBy, null, 'FLY never blocked');
});

test('stealth enemies are untargetable unless blocked or revealed', () => {
  const h = makeBattle({
    defs: { chess: { t_sniper: sniper() }, enemies: { enemy_dummy: dummy() } },
    units: [{ chessId: 't_sniper', row: 11, col: 5 }], enemies: [{ key: 'enemy_dummy', pos: [11, 7] }], content: 'none',
  });
  h.step();
  const e = h.enemy('enemy_dummy');
  h.b.applyStatus(e, 'stealth', { duration: 100 });
  const u = h.unit('t_sniper');
  const a0 = u.stats.attacks;
  h.run(3);
  assert.equal(u.stats.attacks, a0);
  h.b.applyStatus(e, 'reveal', { duration: 100 });
  h.run(2);
  assert.ok(u.stats.attacks > a0);
});

test('target priority: least remaining distance to goal, then earliest spawned; fly-first profiles', () => {
  const h = makeBattle({
    defs: {
      chess: { t_sniper: sniper({ rangeGrid: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 1], [1, 2], [1, 3], [1, 4], [2, 1], [2, 2], [2, 3], [2, 4], [3, 2], [3, 3]] }) },
      enemies: { enemy_dummy: dummy(), enemy_fly: enemyRec({ key: 'enemy_fly', hp: 1e6, speed: 0, motion: 'FLY' }) },
    },
    units: [{ chessId: 't_sniper', row: 9, col: 3 }],
    enemies: [{ key: 'enemy_dummy', pos: [9, 7] }, { key: 'enemy_dummy', pos: [9, 5] }, { key: 'enemy_dummy', pos: [12, 6] }],
    content: 'none',
  });
  h.run(1.2);
  const [far, near, high] = h.b.units.filter((u) => u.defId === 'enemy_dummy');
  assert.ok(near.stats.taken > 0, 'closest to goal attacked');
  assert.equal(far.stats.taken, 0);
  assert.equal(high.stats.taken, 0);
  // fly-first
  const h2 = makeBattle({
    defs: {
      chess: { t_fast: sniper({ id: 't_fast', subProfessionId: 'fastshot', targetPriority: 'fly' }) },
      enemies: { enemy_dummy: dummy(), enemy_fly: enemyRec({ key: 'enemy_fly', hp: 1e6, speed: 0, motion: 'FLY' }) },
    },
    units: [{ chessId: 't_fast', row: 9, col: 3 }],
    enemies: [{ key: 'enemy_dummy', pos: [9, 4] }, { key: 'enemy_fly', pos: [9, 6], route: 2 }], content: 'none',
  });
  h2.run(1.2);
  assert.ok(h2.enemy('enemy_fly').stats.taken > 0);
  assert.equal(h2.enemy('enemy_dummy').stats.taken, 0);
});

test('operators prioritise enemies they block', () => {
  const h = makeBattle({
    defs: { chess: { t_guard: guard({ rangeGrid: [[0, 0], [0, 1], [0, 2]], stats: { atk: 100, blockCnt: 1, maxHp: 1e6 } }) }, enemies: { enemy_walker: walker(), enemy_dummy: dummy() } },
    units: [{ chessId: 't_guard', row: 9, col: 5 }],
    enemies: [{ key: 'enemy_dummy', pos: [9, 6] }, { key: 'enemy_walker', pos: [9, 5.4] }],
    content: 'none', autoFinish: false,
  });
  h.run(0.2);
  const w = h.enemy('enemy_walker');
  assert.equal(w.blockedBy, h.unit('t_guard'));
  h.run(3);
  assert.ok(w.stats.taken > 0);
  assert.equal(h.enemy('enemy_dummy').stats.taken, 0);
});

test('healers target the lowest HP% ally in range; idle when everyone is full; noHeal allies skipped', () => {
  const medic = chessRec({ id: 't_medic', profession: 'MEDIC', subProfessionId: 'physician', dmgType: 'heal', attackKind: 'heal', stats: { atk: 200 }, rangeGrid: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 0], [1, 1], [1, 2], [-1, 0], [-1, 1], [-1, 2]], skill: null });
  const reaper = chessRec({ id: 't_reaper', profession: 'WARRIOR', subProfessionId: 'reaper', skill: null, stats: { maxHp: 5000 } });
  const h = makeBattle({
    defs: { chess: { t_medic: medic, t_a: guard({ id: 't_a', stats: { maxHp: 5000 } }), t_b: guard({ id: 't_b', stats: { maxHp: 5000 } }), t_reaper: reaper } },
    units: [{ chessId: 't_medic', row: 10, col: 3 }, { chessId: 't_a', row: 10, col: 4 }, { chessId: 't_b', row: 11, col: 4 }, { chessId: 't_reaper', row: 9, col: 4 }],
    content: 'none',
  });
  h.step();
  const m = h.unit('t_medic'), a = h.unit('t_a'), b = h.unit('t_b'), r = h.unit('t_reaper');
  h.run(2);
  assert.equal(m.stats.attacks, 0, 'no injured ally: no heal');
  a.hp = 4000; b.hp = 2000; r.hp = 100;
  h.run(1.05);
  assert.ok(b.hp > 2000, 'lowest ratio (non-reaper) healed first');
  assert.equal(a.hp, 4000);
  assert.equal(r.hp, 100, 'reaper cannot be healed by others');
});

test('ranged enemies attack allies in radius: blocker → taunt → latest deployed, then pause', () => {
  const mk = (taunt) => makeBattle({
    defs: {
      chess: { t_a: guard({ id: 't_a', stats: { maxHp: 1e6, atk: 0 } }), t_b: guard({ id: 't_b', stats: { maxHp: 1e6, atk: 0, tauntLevel: taunt } }) },
      enemies: { enemy_caster: enemyRec({ key: 'enemy_caster', hp: 1e6, speed: 1, atk: 100, range: 2.5, dmgType: 'arts' }) },
    },
    // deploy order: top→bottom, so t_b (row 11) deploys before t_a (row 10) ⇒ t_a is the latest deployed
    units: [{ chessId: 't_a', row: 10, col: 8 }, { chessId: 't_b', row: 11, col: 8 }],
    enemies: [{ key: 'enemy_caster', pos: [10, 10] }], content: 'none', autoFinish: false,
  });
  const h = mk(1);
  h.step(1);
  const e = h.enemy('enemy_caster');
  assert.ok(e.lastAttackAt >= 0, 'attacked on the first tick');
  // attack pause: no movement for ATTACK_PAUSE (0.35 s) after the attack
  const x = e.x;
  h.step(9);
  assert.equal(e.x, x);
  h.run(0.5);
  assert.ok(e.x < x, 'moves after the pause');
  assert.ok(h.unit('t_b').stats.taken > 0, 'highest taunt chosen');
  assert.equal(h.unit('t_a').stats.taken, 0);
  const h2 = mk(0);
  h2.run(0.8);
  assert.ok(h2.unit('t_a').stats.taken > 0, 'latest deployed chosen');
  assert.equal(h2.unit('t_b').stats.taken, 0);
});

test('core targeting: explicit ID comparison resolves ties independently of insertion order', () => {
  const units = [7, 1, 4, 2].map(id => actionUnit(id, 'ENEMY', [1, 0]));
  const source = actionUnit(0, 'ALLY', [0, 0]);
  const before = [...units];
  for (const candidates of [units, units.toReversed()]) {
    const state = createBattleState(fixtureBattlefieldState([source, ...candidates]));
    const result = selectTargets(state, { source: unitRef(source), purposes: [],
      filter: (_battle, _request, target) => target.id !== 0 && target.id !== 1,
      selector: (battle, _request, eligible) => ({ state: battle,
        value: topK(eligible, 2, (left, right) => left.id - right.id).map(unitRef) }) });
    assert.deepEqual(result.value.map(ref => ref.id), [2, 4]);
    assert.equal(result.state, state);
  }
  assert.deepEqual(units, before);
});

test('core targeting: each finite target limit returns the same explicitly ranked prefix', () => {
  const source = actionUnit(100, 'ALLY', [0, 0]);
  const units = Array.from({ length: 37 }, (_, id) => actionUnit(id, 'ENEMY', [id % 6, 0]));
  const compare = (left, right) => left.position[0] - right.position[0] || left.id - right.id;
  const ordered = units.filter(unit => unit.id % 4 !== 0).sort(compare);
  for (const candidates of [units, units.toReversed(), units.map((_, id) => units[(id * 13) % 37])]) {
    const state = createBattleState(fixtureBattlefieldState([source, ...candidates]));
    for (const limit of [0, 1, 2, 3, 8, 37, 100]) {
      const result = selectTargets(state, { source: unitRef(source), purposes: [],
        filter: (_battle, _request, target) => target.id !== source.id && target.id % 4 !== 0,
        selector: (battle, _request, eligible) => ({ state: battle,
          value: topK(eligible, limit, compare).map(unitRef) }) });
      assert.deepEqual(result.value.map(ref => ref.id), ordered.slice(0, limit).map(unit => unit.id));
    }
  }
});

test('core targeting: a small multi-target query selects across a large unordered candidate set', () => {
  const source = actionUnit(1000, 'ALLY', [0, 0]);
  const units = Array.from({ length: 509 }, (_, id) => actionUnit(id, 'ENEMY', [(id * 73) % 509, 0]));
  const state = createBattleState(fixtureBattlefieldState([source, ...units]));
  const result = selectTargets(state, { source: unitRef(source), purposes: [],
    filter: (_battle, _request, target) => target.id !== source.id,
    selector: (battle, _request, eligible) => ({ state: battle,
      value: topK(eligible, 3, (left, right) => left.position[0] - right.position[0]).map(unitRef) }) });
  assert.deepEqual(result.value.map(ref => getUnit(result.state, ref.id).position[0]), [0, 1, 2]);
});

const actionRange = radius => [{ type: 'CIRCLE', offset: [0, 0], radius }];

const damageTargeting = (overrides = {}) => damageFixture({
  geometry: actionRange(10), ...overrides,
});

const healingTargeting = (overrides = {}) => healingFixture({
  geometry: actionRange(10), ...overrides,
});

const damageEffect = power => ({ type: 'DAMAGE', power, damageType: 'TRUE' });
const healEffect = power => ({ type: 'HEAL', power });

const attackDefinition = (targetGroups, followUps = []) => createAttack({
  id: 'normal', intervalTicks: 3, speed: 100, triggerBindingId: targetGroups[0].id, targetGroups, followUps, recoveryTicks: 0,
});

function actionUnit(id, side, position, { hp = 100, effects: initialEffects = [], action, skill } = {}) {
  const definition = {
    id: `action_unit_${id}`, targetable: { restrictions: [] }, vitality: { maxHp: 100, defense: 0, resistance: 0 }, allegiance: { side },
    layer: { type: 'GROUND' }, hitbox: { shape: { type: 'CIRCLE', offset: [0, 0], radius: 0.1 } }, blocker: { capacity: 0, geometry: { radius: 0 } },
    ...(skill === undefined ? {} : { skill }),
    action: { definitions: Definitions.empty().add(action ?? attackDefinition([
      { id: 'primary', targeting: damageTargeting(), operations: [damageEffect(0)] },
    ])) },
  };
  let unit = initialize({ id, definition, position });
  unit = { ...unit, vitality: { ...unit.vitality, hp } };
  for (const effect of initialEffects) unit = installFixtureEffect(unit, effect);
  return unit;
}

function actionView(units, relations = []) {
  const byId = new Map(units.map(unit => [unit.id, unit]));

  return {
    get unitIds() { return [...byId.keys()]; },
    getUnit: id => byId.get(id),
    blockerOf: id => relations.find(relation => relation.blockedUnitId === id)?.blockerUnitId,
    blockedBy: id => relations.filter(relation => relation.blockerUnitId === id)
      .map(relation => relation.blockedUnitId),
  };
}

test('core protection effects: withdrawing one source retains the other source and earlier snapshots', () => {
  const source = actionUnit(0, 'ALLY', [0, 0]);
  const target = actionUnit(1, 'ENEMY', [1, 0], { hp: 50 });
  const request = { source: unitRef(source), target: unitRef(target), parameters: parameters(1000, 'TRUE') };
  const restricted = (effect, state) => {
    const current = getUnit(state, 1);
    if (effect === healFree) return !allowsRestrictions(state, { source: unitRef(source), ...healingTargeting() }, current);
    if (effect === untargetable) return selectTargets(state, { source: unitRef(source), ...damageTargeting() }).value.length === 0;
    const resolved = dealDamage(state, request);
    return resolved.value.kind === 'REJECTED';
  };

  for (const effect of [healFree, untargetable, invincible]) {
    let state = createBattleState(fixtureBattlefieldState([source, target]));
    const first = effects.install(state, unitRef(getUnit(state, 1)), effect);
    const second = effects.install(first.state, unitRef(getUnit(first.state, 1)), effect);
    state = second.state;
    const both = getUnit(state, 1);

    assert.equal(restricted(effect, state), true, effect.id);
    state = effects.setEnabled(state, first.value, false);
    assert.equal(restricted(effect, state), true, effect.id);
    state = effects.end(state, second.value);
    assert.equal(restricted(effect, state), false, effect.id);
    state = effects.setEnabled(state, first.value, true);
    assert.equal(restricted(effect, state), true, effect.id);
    state = effects.end(state, first.value);
    assert.equal(restricted(effect, state), false, effect.id);
    assert.equal(both.effects.values().toArray().length, 2);
    assert.equal(restricted(effect, second.state), true, effect.id);
    assert.equal(target.effects.values().toArray().length, 0);
  }
});

test('core vitality: invincibility rejects receiving before HIT SP and removing it restores reception', () => {
  const observed = [];
  const protectedTarget = actionUnit(1, 'ALLY', [1, 0], { effects: [invincible], skill: skillDefinition({
    id: 'hit-sp', sp: { initial: 0, capacity: 10, requirement: 10, recovery: { type: 'HIT', amount: 1 } },
    activation: { trigger: 'MANUAL', sustain: { type: 'INFINITE' }, initialize: () => ({}) },
  }) });
  const target = { ...protectedTarget, vitality: setDamageHook(protectedTarget.vitality, {
    id: 'observe-reception', stage: 'receiving', priority: 0,
    invoke(state, context, pending) {
      observed.push(getUnit(state, context.request.target.id).skill.sp.value);
      return { state, value: pending };
    },
  }) };
  const state = enterSkill(createBattleState(fixtureBattlefieldState([target])), unitRef(target));
  const request = { source: null, target: unitRef(target), parameters: parameters(10, 'TRUE') };
  const blocked = dealDamage(state, request);
  const protection = getUnit(state, 1).effects.values().toArray().find(effect => effect.definition === invincible);
  const unprotected = effects.end(state, { host: unitRef(target), id: protection.id });
  const allowed = dealDamage(unprotected, request);

  assert.equal(blocked.value.kind, 'REJECTED');
  assert.equal(getUnit(blocked.state, 1).skill.sp.value, 0);
  assert.equal(allowed.value.kind, 'APPLIED');
  assert.equal(allowed.value.application.hpLoss, 10);
  assert.equal(getUnit(allowed.state, 1).skill.sp.value, 1);
  assert.deepEqual(observed, [1]);
  assert.equal(target.skill.sp.value, 0);
  assert.equal(target.vitality.hp, 100);
});

test('core vitality: nested direct healing ignores target selection restrictions and supplies the latest HP', () => {
  for (const installedInitially of [false, true]) {
    const original = actionUnit(1, 'ENEMY', [1, 0], {
      hp: 40, effects: installedInitially ? [healFree] : [],
    });
    const target = { ...original, vitality: setDamageHook(original.vitality, {
      id: 'change-healing-restriction', stage: 'receiving', priority: 0,
      invoke(state, context, pending) {
        if (installedInitially) {
          state = effects.end(state, { host: context.request.target,
            id: getUnit(state, context.request.target.id).effects.values().toArray()[0].id });
        } else {
          state = effects.install(state, context.request.target, healFree).state;
        }
        state = healing(state, { source: null, target: context.request.target,
          parameters: { power: 30, multiplier: 1 } }).state;
        return { state, value: pending };
      },
    }) };
    const state = createBattleState(fixtureBattlefieldState([target]));
    const resolved = dealDamage(state, { source: null, target: unitRef(target), parameters: parameters(60, 'TRUE') });

    assert.equal(resolved.value.kind, 'APPLIED');
    assert.deepEqual(resolved.value.application, { hpBefore: 70, hpAfter: 10, hpLoss: 60 });
    assert.equal(getUnit(resolved.state, 1).vitality.hp, 10);
    assert.equal(target.vitality.hp, 40);
  }
});

test('core vitality: a selected target remains directly healable after gaining a selection restriction', () => {
  const source = actionUnit(0, 'ALLY', [0, 0]);
  const target = actionUnit(1, 'ALLY', [1, 0], { hp: 40 });
  let state = createBattleState(fixtureBattlefieldState([source, target]));
  const query = { source: unitRef(source), ...healingTargeting() };
  const selected = selectTargets(state, query).value;
  assert.deepEqual(selected.map(unit => unit.id), [1]);
  const selectedRef = selected[0];
  state = effects.install(state, selectedRef, healFree).state;
  const result = healing(state, { source: unitRef(source), target: selectedRef,
    parameters: { power: 30, multiplier: 1 } });

  assert.deepEqual(selectTargets(state, query).value, []);
  assert.equal(result.value.kind, 'APPLIED');
  assert.equal(result.value.application.hpGain, 30);
  assert.equal(getUnit(result.state, 1).vitality.hp, 70);
  assert.equal(getUnit(state, 1).vitality.hp, 40);
  assert.equal(target.vitality.hp, 40);
});

test('core targeting uses static definition hitboxes and current layer', () => {
  const source = actionUnit(0, 'ALLY', [0, 0]);
  const target = actionUnit(1, 'ENEMY', [1.6, 0]);
  const request = { source: unitRef(source), ...damageTargeting({ geometry: actionRange(1) }) };
  const select = current => selectTargets(createBattleState(fixtureBattlefieldState([source, current])), request).value;

  assert.deepEqual(select(target), []);
  const expanded = initialize({ id: target.id, position: target.position, definition: {
    ...target.definition, hitbox: { shape: { type: 'CIRCLE', offset: [0, 0], radius: 0.7 } },
  } });
  assert.deepEqual(select(expanded).map(unit => unit.id), [1]);
  assert.equal(target.definition.hitbox.shape.radius, 0.1);
  assert.deepEqual(select({ ...expanded, layer: { type: 'AIR' } }), []);
  assert.equal(target.definition.layer.type, 'GROUND');
});

test('core targeting: default healing eligibility and ordering use effective MaxHP', () => {
  const source = actionUnit(0, 'ALLY', [0, 0]);
  const base = actionUnit(1, 'ALLY', [1, 0]);
  const enlarged = { ...base, vitality: {
    ...setMaxHpContribution(base.vitality, base.definition.vitality, {
      id: 'equipment', value: [modifier.create({ finalAddition: 300 })],
    }), hp: 100,
  } };
  const ordinary = actionUnit(2, 'ALLY', [2, 0], { hp: 40 });
  const flooredBase = actionUnit(3, 'ALLY', [3, 0]);
  const floored = initialize({ id: 3, position: flooredBase.position, definition: {
    ...flooredBase.definition, vitality: { maxHp: 0, defense: 0, resistance: 0 },
  } });
  const fractional = { ...floored, vitality: { ...floored.vitality, hp: 0.5 } };
  const query = { source: unitRef(source), ...healingTargeting({ maxTargets: 3 }) };

  assert.deepEqual(selectTargets(createBattleState(fixtureBattlefieldState([source, enlarged, ordinary, fractional])),
    query).value.map(ref => ref.id), [1, 2, 3]);
});

test('core targeting: enemies and neutral units select each other while allies and neutral units do not', () => {
  const ally = actionUnit(0, 'ALLY', [0, 0]);
  const enemy = actionUnit(1, 'ENEMY', [1, 0]);
  const neutral = actionUnit(2, 'NEUTRAL', [2, 0]);
  const battlefield = actionView([ally, enemy, neutral]);
  const targeting = damageTargeting({ maxTargets: 3 });
  const state = createBattleState(fixtureBattlefieldState(battlefield));
  const select = source => selectTargets(state, { source: unitRef(source), ...targeting }).value.map(ref => ref.id);

  assert.deepEqual(select(ally), [1]);
  assert.deepEqual(select(enemy), [0, 2]);
  assert.deepEqual(select(neutral), [1]);
  const unaffiliated = initialize({ id: 3, definition: { id: 'unaffiliated' }, position: [0, 0] });
  assert.deepEqual(select(unaffiliated), []);
});

test('core targeting: hostile restrictions, friend restrictions and explicit blocking exceptions stay separate', () => {
  const source = actionUnit(0, 'ALLY', [0, 0]);
  const query = (target, overrides = {}, relations = []) => selectTargets(
    createBattleState(fixtureBattlefieldState(actionView([source, target], relations))),
    { source: unitRef(source), ...damageTargeting(overrides) }).value.map(ref => ref.id);

  for (const effect of [untargetable, invincible, invisible, camouflage]) {
    const target = actionUnit(1, 'ENEMY', [1, 0], { effects: [effect] });
    assert.deepEqual(query(target), [], effect.id);
    assert.deepEqual(query(target, { ignoreInvisible: true }), effect === invisible ? [1] : [], effect.id);
    assert.deepEqual(query(target, { ignoreTargetFree: true }), effect === camouflage ? [] : [1], effect.id);
    assert.deepEqual(query(target, { includeBlockingRelations: true },
      [{ blockerUnitId: 0, blockedUnitId: 1 }]), [], effect.id);
    assert.deepEqual(query(target, { includeBlockingRelations: true },
      [{ blockerUnitId: 9, blockedUnitId: 1 }]), [], effect.id);
  }

  const friend = actionUnit(2, 'ALLY', [1, 0], { hp: 50, effects: [invincible, untargetable, invisible] });
  const selectFriend = (target, overrides = {}) => selectTargets(
    createBattleState(fixtureBattlefieldState([source, target])),
    { source: unitRef(source), ...healingTargeting(overrides) }).value.map(ref => ref.id);
  assert.deepEqual(selectFriend(friend), [2]);
  const isolated = actionUnit(2, 'ALLY', [1, 0], { hp: 50, effects: [allyUntargetable] });
  assert.deepEqual(selectFriend(isolated), []);
  assert.deepEqual(selectFriend(isolated, { ignoreAllyTargetFree: true }), [2]);
});

test('core action: healing target selection owns the heal-free exception', () => {
  for (const queryIgnore of [false, true]) {
    const action = attackDefinition([{ id: 'heal', targeting: healingTargeting({ ignoreHealFree: queryIgnore }),
      operations: [healEffect(30)] }]);
    const source = actionUnit(0, 'ALLY', [0, 0], { action });
    const target = actionUnit(1, 'ALLY', [1, 0], { hp: 40, effects: [healFree] });
    const before = JSON.stringify([source, target]);
    const result = startSingleAction(source, source.definition.action.definitions.values().toArray()[0], {
      battlefield: actionView([source, target]), tick: 0,
    });
    const heals = result.events.filter(event => event.type === 'HEAL');

    assert.equal(result.events.some(event => event.type === 'ACTION'), queryIgnore);
    assert.deepEqual(heals.map(event => [event.amount, event.hp]), queryIgnore ? [[30, 70]] : []);
    assert.equal(JSON.stringify([source, target]), before);
  }
});

test('core action: explicitly declared query purposes gate mixed outputs while source follow-ups settle independently', () => {
  const target = actionUnit(1, 'ENEMY', [1, 0], { hp: 80, effects: [healFree] });
  const mixed = actionUnit(0, 'ALLY', [0, 0], { action: attackDefinition([
    { id: 'attack', targeting: damageTargeting({ purposes: ['DAMAGE', 'HEAL'] }), operations: [damageEffect(10), healEffect(5)] },
  ]) });
  const result = startSingleAction(mixed, mixed.definition.action.definitions.values().toArray()[0], {
    battlefield: actionView([mixed, target]), tick: 0,
  });
  assert.deepEqual(result.events, []);

  const damageOnly = actionUnit(0, 'ALLY', [0, 0], { action: attackDefinition([
    { id: 'attack', targeting: damageTargeting(), operations: [damageEffect(10), healEffect(5)] },
  ]) });
  const permitted = startSingleAction(damageOnly, damageOnly.definition.action.definitions.values().toArray()[0], {
    battlefield: actionView([damageOnly, target]), tick: 0,
  });
  assert.equal(permitted.events.find(event => event.type === 'DAMAGE').hp, 70);
  assert.equal(permitted.events.find(event => event.type === 'HEAL').hp, 75);

  const source = actionUnit(0, 'ALLY', [0, 0], { hp: 60, effects: [healFree], action: attackDefinition([
    { id: 'attack', targeting: damageTargeting(), operations: [damageEffect(10)] },
  ], [{ receiver: { type: 'SOURCE' }, operation: healEffect(15) }]) });
  const stepped = startSingleAction(source, source.definition.action.definitions.values().toArray()[0], {
    battlefield: actionView([source, target]), tick: 0,
  });
  assert.deepEqual(stepped.events.map(event => event.type), ['ACTION', 'ACTION_RELEASED', 'DAMAGE', 'HEAL', 'ACTION_FINISHED']);
  assert.equal(stepped.events.find(event => event.type === 'DAMAGE').hp, 70);
  assert.equal(stepped.events.find(event => event.type === 'HEAL').amount, 15);
  assert.equal(stepped.units.find(unit => unit.id === 0).vitality.hp, 75);
  assert.equal(stepped.units.find(unit => unit.id === 0).action.states.get('normal').cooldown.readyAtTick, 3);
});

test('core action: secondary target groups cannot trigger the action and use independent query purposes', () => {
  const definition = attackDefinition([
    { id: 'attack', targeting: damageTargeting(), operations: [damageEffect(10)] },
    { id: 'heal', targeting: healingTargeting(), operations: [healEffect(20)] },
  ]);
  const source = actionUnit(0, 'ALLY', [0, 0], { action: definition });
  const friend = actionUnit(2, 'ALLY', [2, 0], { hp: 40 });
  const compiled = source.definition.action.definitions.values().toArray()[0];
  const noEnemy = startSingleAction(source, compiled, { battlefield: actionView([source, friend]), tick: 0 });
  assert.deepEqual(noEnemy.units.map(unit => unit.id), [source.id, friend.id]);
  assert.deepEqual(noEnemy.removedUnitIds, []);
  assert.deepEqual(noEnemy.events, []);
  assert.equal(noEnemy.state.nextId, 0);
  assert.equal(noEnemy.state.size, 0);

  const enemy = actionUnit(1, 'ENEMY', [1, 0], { hp: 80, effects: [healFree] });
  const stepped = startSingleAction(source, compiled, { battlefield: actionView([source, friend, enemy]), tick: 0 });
  assert.deepEqual(stepped.events.map(event => [event.type, event.targetUnitId]),
    [['ACTION', 1], ['ACTION_RELEASED', undefined], ['DAMAGE', 1], ['HEAL', 2], ['ACTION_FINISHED', undefined]]);
  assert.equal(stepped.units.find(unit => unit.id === 1).vitality.hp, 70);
  assert.equal(stepped.units.find(unit => unit.id === 2).vitality.hp, 60);
  assert.equal(source.vitality.hp, 100);
  assert.equal(friend.vitality.hp, 40);
  assert.equal(enemy.vitality.hp, 80);
});

test('core combat: healing sees earlier phase damage and replays without executable rules in snapshots', () => {
  const base = createLegacyCombatSpec({ rows: 1, columns: 4, operators: [], enemies: [], maxTicks: 2 });
  const attacker = actionUnit(0, 'ENEMY', [0, 0], { action: attackDefinition([
    { id: 'attack', targeting: damageTargeting(), operations: [damageEffect(20)] },
  ]) });
  const friend = actionUnit(1, 'ALLY', [1, 0]);
  const medic = actionUnit(2, 'ALLY', [3, 0], { action: attackDefinition([
    { id: 'heal', targeting: healingTargeting(), operations: [healEffect(10)] },
  ]) });
  const input = { ...base, initialUnits: [attacker, friend, medic].map(unit => ({
    definition: unit.definition, position: unit.position,
  })) };
  const run = () => {
    const battle = new BattleRuntime(input);
    const step = battle.step();
    const snapshot = battle.snapshot();
    assert.equal(snapshot.units.find(unit => unit.id === 1).vitality.hp, 90);
    assert.deepEqual(step.events.filter(event => event.type === 'HEAL')
      .map(event => [event.sourceUnitId, event.targetUnitId, event.amount]), [[2, 1, 10]]);
    const serialized = JSON.parse(JSON.stringify(snapshot));
    assert.deepEqual(serialized.units.map(unit => unit.effects), snapshot.units.map(unit => ({
      instances: unit.effects.values().toArray(), nextId: unit.effects.nextId,
    })));
    return { step, snapshot: serialized };
  };
  assert.deepEqual(run(), run());
});

test('core action: binding follow-ups retain the selected target and read preceding effect updates', () => {
  const source = actionUnit(0, 'ALLY', [0, 0], { action: attackDefinition([
    { id: 'restore', targeting: healingTargeting(), operations: [healEffect(20)] },
  ], [{ receiver: { type: 'BINDING', bindingId: 'restore' }, operation: healEffect(5) }]) });
  const first = actionUnit(1, 'ALLY', [1, 0], { hp: 30 });
  const second = actionUnit(2, 'ALLY', [2, 0], { hp: 40 });
  const result = startSingleAction(source, source.definition.action.definitions.values().toArray()[0], {
    battlefield: actionView([source, first, second]), tick: 0,
  });

  assert.deepEqual(result.events.filter(event => event.type === 'HEAL')
    .map(event => [event.targetUnitId, event.amount, event.hp]), [[1, 20, 50], [1, 5, 55]]);
  assert.equal(result.units.find(unit => unit.id === 1).vitality.hp, 55);
  assert.equal(result.units.find(unit => unit.id === 2).vitality.hp, 40);
  assert.equal(first.vitality.hp, 30);
  assert.equal(second.vitality.hp, 40);
});
