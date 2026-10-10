import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattlefieldRuntime } from '../../dist/core/tactical/battlefield/runtime.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';
import { createNavigationModifierDefinition } from '../../dist/core/tactical/battlefield/navigation/modifier.js';
import { createTileBindingDefinition } from '../../dist/core/tactical/unit/capability/deployment.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';

const create = () => createBattlefieldRuntime({
  map: createBattlefieldMap(1, 3, Array.from({ length: 3 }, () => createTile({
    heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
  }))),
});
const unit = (id, column = 0, definition = {}, states = {}) => initializeUnit({
  id, position: [column, 0], definition: { id: `draft-unit-${id}`, vitality: { maxHp: 100 }, ...definition },
  states,
});
const registration = unit => ({ type: 'REGISTER_UNIT', unit });
const updateHp = (battlefield, id, hp) => ({
  type: 'UPDATE_UNIT', unit: {
    ...battlefield.view.getUnit(id), vitality: { ...battlefield.view.getUnit(id).vitality, hp },
  },
});

test('draft advances are immediately readable while fixed snapshots retain their captured version', () => {
  const battlefield = create();
  const live = battlefield.view;
  const empty = battlefield.snapshot();
  const registered = battlefield.advance([registration(unit(1))]);
  const first = battlefield.snapshot('draft');

  assert.deepEqual(registered.registeredUnitIds, [1]);
  assert.deepEqual(empty.unitIds, []);
  assert.deepEqual(battlefield.snapshot().unitIds, []);
  assert.deepEqual(live.unitIds, [1]);
  assert.equal(live.getUnit(1).vitality.hp, 100);
  assert.equal(battlefield.getUnit(1).vitality.hp, 100);

  battlefield.advance([updateHp(battlefield, 1, 40)]);
  assert.equal(first.getUnit(1).vitality.hp, 100);
  assert.equal(live.getUnit(1).vitality.hp, 40);
  assert.equal(battlefield.snapshot('draft').getUnit(1).vitality.hp, 40);

  const current = live.getUnit(1);
  battlefield.apply();
  assert.equal(battlefield.snapshot().getUnit(1), current, 'publication retains the already computed version');
  assert.equal(first.getUnit(1).vitality.hp, 100);
  assert.deepEqual(empty.unitIds, []);

  battlefield.advance([updateHp(battlefield, 1, 20)]);
  battlefield.drop();
  assert.equal(live.getUnit(1), current);
  assert.equal(battlefield.snapshot().getUnit(1), current);
});

test('draft spatial and navigation projections follow updated unit facts and drop restores all projections', () => {
  const battlefield = create();
  const owner = unit(1, 0, {}, { occupancy: { claims: [
    { position: [0, 0], slot: 'DEPLOYMENT', type: 'PRESENT' },
  ] } });
  battlefield.advance([
    registration(owner),
    { type: 'ADD_NAVIGATION_MODIFIER', navigationModifier: {
      id: 7,
      definition: createNavigationModifierDefinition({
        id: 'draft-wall', FLY: null,
        WALK: { denyPassage: true, deniedDepartures: [], costFloor: 1 },
      }),
      source: { type: 'UNIT', unitId: 1 }, active: true, expiresAtTick: null,
      region: { type: 'FOLLOW_UNIT', unitId: 1, range: [[0, 0]], direction: 'RIGHT' },
    } },
  ]);
  battlefield.apply();
  const published = battlefield.snapshot();
  const changed = battlefield.advance([{ type: 'UPDATE_UNIT', unit: {
    ...owner, position: [1, 0], occupancy: { claims: [
      { position: [0, 1], slot: 'DEPLOYMENT', type: 'PRESENT' },
    ] },
  } }]);
  const moved = battlefield.snapshot('draft');

  assert.deepEqual(changed.changedNavigationModes, ['WALK']);
  assert.deepEqual(battlefield.unitsAt([0, 0]), []);
  assert.deepEqual(battlefield.view.unitsAt([0, 1]).map(unit => unit.id), [1]);
  assert.deepEqual(battlefield.occupancyAt([0, 1], 'DEPLOYMENT'), [1]);
  assert.deepEqual(moved.occupancyAt([0, 0], 'DEPLOYMENT'), []);
  assert.deepEqual(battlefield.navigationModifiersAt([0, 1]), [7]);
  assert.deepEqual(battlefield.navigationModifiersFollowing(1), [7]);
  assert.deepEqual(battlefield.navigationModifiersFrom({ type: 'UNIT', unitId: 1 }), [7]);
  assert.equal(battlefield.navigationMaps.WALK.cells[0].passable, true);
  assert.equal(battlefield.navigationMaps.WALK.cells[1].passable, false);
  assert.equal(published.navigationMaps.WALK.cells[0].passable, false);
  assert.deepEqual(published.unitsAt([0, 0]).map(unit => unit.id), [1]);

  battlefield.drop();
  assert.equal(battlefield.navigationMaps, published.navigationMaps);
  assert.deepEqual(battlefield.view.unitsAt([0, 0]).map(unit => unit.id), [1]);
  assert.deepEqual(battlefield.occupancyAt([0, 0], 'DEPLOYMENT'), [1]);
  assert.deepEqual(battlefield.navigationModifiersAt([0, 0]), [7]);
  assert.deepEqual(moved.unitsAt([0, 1]).map(unit => unit.id), [1]);
  assert.equal(moved.navigationMaps.WALK.cells[1].passable, false);
});

test('draft removal maintains support, blocking and lifetime projections before publication', () => {
  const battlefield = create();
  const provider = unit(1, 0, {
    tileBinding: createTileBindingDefinition({ heightType: 'LOWLAND', buildableType: 'ALL' }),
    allegiance: { side: 'ALLY' }, blocker: { capacity: 1, geometry: { radius: 2 } },
  }, { occupancy: { claims: [{ position: [0, 0], slot: 'SUPPORT', type: 'PRESENT' }] } });
  const supported = unit(2, 0, {}, { occupancy: { claims: [
    { position: [0, 0], slot: 'DEPLOYMENT', type: 'PRESENT' },
  ] } });
  const effect = {
    id: 0, source: 1, programRef: { id: 'draft-effect' }, state: {}, acquiredSequence: 0,
    scopes: [{ type: 'UNIT', unitId: 1 }, { type: 'TICK', tick: 10 }],
    started: true, enabled: true, participating: true, finished: false,
  };
  const blocked = unit(3, 1, {
    allegiance: { side: 'ENEMY' }, blockable: { weight: 1 },
  }, { effects: { instances: [effect], nextInstanceId: 1, nextAcquiredSequence: 1 } });
  const support = { supportedUnitId: 2, supportUnitId: 1 };
  battlefield.advance([
    ...[provider, supported, blocked].map(registration),
    { type: 'SET_SUPPORT_RELATIONS', relations: [support] },
    { type: 'SET_BLOCKING_RELATIONS', relations: [{ blockerUnitId: 1, blockedUnitId: 3 }] },
  ]);
  battlefield.apply();
  const published = battlefield.snapshot();
  const finished = { ...effect, finished: true, participating: false };
  const facts = battlefield.advance([
    { type: 'UPDATE_UNIT', unit: { ...blocked, effects: { ...blocked.effects, instances: [finished] } } },
    { type: 'REMOVE_UNIT', unitId: 1, reason: 'RETREAT' },
  ]);

  assert.deepEqual(facts.removedUnits.map(({ unitId, reason }) => ({ unitId, reason })), [
    { unitId: 1, reason: 'RETREAT' },
  ]);
  assert.deepEqual(facts.lostSupports, [support]);
  assert.equal(battlefield.view.supportOf(2), undefined);
  assert.equal(battlefield.view.blockerOf(3), undefined);
  assert.deepEqual(battlefield.view.blockedBy(1), []);
  assert.equal(battlefield.effectLifetimes.timed.size, 0);
  assert.equal(battlefield.effectLifetimes.dependents.get('UNIT:1')?.size ?? 0, 0);
  assert.equal(published.supportOf(2), 1);
  assert.equal(published.blockerOf(3), 1);
  assert.equal(published.blockingUsedCapacity(1), 1);
  assert.equal(published.effectLifetimes.timed.size, 1);

  battlefield.drop();
  assert.equal(battlefield.view.supportOf(2), 1);
  assert.equal(battlefield.view.blockerOf(3), 1);
  assert.equal(battlefield.effectLifetimes, published.effectLifetimes);
});

test('fork starts from the current draft and remains independent of publication and later advances', () => {
  const battlefield = create();
  battlefield.advance([registration(unit(1))]);
  const fork = battlefield.fork();
  const initial = fork.snapshot();
  assert.equal(initial.getUnit(1), battlefield.view.getUnit(1));
  assert.deepEqual(battlefield.snapshot().unitIds, []);

  battlefield.drop();
  assert.deepEqual(battlefield.unitIds, []);
  assert.deepEqual(fork.unitIds, [1]);
  fork.advance([updateHp(fork, 1, 30)]);
  assert.equal(fork.view.getUnit(1).vitality.hp, 30);
  assert.equal(initial.getUnit(1).vitality.hp, 100);
  fork.drop();
  assert.equal(fork.view.getUnit(1).vitality.hp, 100);

  battlefield.advance([registration(unit(2, 2))]);
  battlefield.apply();
  assert.deepEqual(fork.unitIds, [1]);
  assert.deepEqual(battlefield.unitIds, [2]);
});

test('failed advances preserve both versions when applying changes or building derived indexes fails', () => {
  const battlefield = create();
  battlefield.advance([registration(unit(1))]);
  battlefield.apply();
  battlefield.advance([updateHp(battlefield, 1, 80)]);
  const before = battlefield.snapshot('draft');
  assert.throws(() => battlefield.advance([
    registration(unit(2)), registration(unit(1)),
  ]), /duplicate unit/);
  assert.equal(battlefield.view.getUnit(1), before.getUnit(1));
  assert.deepEqual(battlefield.unitIds, [1]);

  const claim = { position: [0, 1], slot: 'DEPLOYMENT', type: 'PRESENT' };
  assert.throws(() => battlefield.advance([
    registration(unit(2, 1, {}, { occupancy: { claims: [claim] } })),
    registration(unit(3, 1, {}, { occupancy: { claims: [claim] } })),
  ]), /occupancy slot is already claimed/);
  assert.deepEqual(battlefield.unitIds, [1]);
  assert.deepEqual(battlefield.occupancyAt([0, 1], 'DEPLOYMENT'), []);
  assert.equal(battlefield.navigationMaps, before.navigationMaps);
  assert.equal(battlefield.snapshot().getUnit(1).vitality.hp, 100);
  assert.equal(battlefield.view.getUnit(1).vitality.hp, 80);
});

test('transact restores the exact published and draft versions even after apply and drop', () => {
  const battlefield = create();
  battlefield.advance([registration(unit(1))]);
  battlefield.apply();
  battlefield.advance([updateHp(battlefield, 1, 80)]);
  const published = battlefield.snapshot();
  const draft = battlefield.snapshot('draft');

  assert.throws(() => battlefield.transact(current => {
    current.advance([updateHp(current, 1, 50)]);
    current.apply();
    current.advance([updateHp(current, 1, 20)]);
    current.drop();
    throw new Error('abort both versions');
  }), /abort both versions/);
  assert.equal(battlefield.snapshot().getUnit(1), published.getUnit(1));
  assert.equal(battlefield.view.getUnit(1), draft.getUnit(1));

  const hp = battlefield.transact(current => {
    current.advance([updateHp(current, 1, 70)]);
    return current.view.getUnit(1).vitality.hp;
  });
  assert.equal(hp, 70);
  assert.equal(battlefield.snapshot().getUnit(1).vitality.hp, 100);
  assert.equal(battlefield.view.getUnit(1).vitality.hp, 70);
});

test('advance reports actual transient registration and removal while apply performs no replay', () => {
  const battlefield = create();
  const registered = unit(1);
  const facts = battlefield.advance([
    registration(registered), { type: 'REMOVE_UNIT', unitId: 1, reason: 'SCRIPT' },
  ]);
  assert.deepEqual(facts.registeredUnitIds, [1]);
  assert.equal(facts.removedUnits[0].unit, registered);
  assert.deepEqual(battlefield.unitIds, []);
  const maps = battlefield.navigationMaps;
  battlefield.apply();
  battlefield.apply();
  assert.deepEqual(battlefield.snapshot().unitIds, []);
  assert.equal(battlefield.navigationMaps, maps);
});
