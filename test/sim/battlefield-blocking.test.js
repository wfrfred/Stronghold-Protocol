import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattlefieldRuntime } from '../../dist/core/tactical/battlefield/runtime.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import {
  addStatusContribution, removeStatusContribution,
} from '../../dist/core/tactical/unit/capability/status/capability.js';
import { updateBlockingCapacityContributions } from '../../dist/core/tactical/unit/capability/blocking/capability.js';
import * as contribution from '../../dist/core/tactical/modifier/contribution.js';
import * as modifier from '../../dist/core/tactical/modifier/value.js';

const create = units => {
  const battlefield = createBattlefieldRuntime({
    map: createBattlefieldMap(3, 5, Array.from({ length: 15 }, () => createTile({
      heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
      playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
    }))),
  });
  battlefield.advance(units.map(unit => ({ type: 'REGISTER_UNIT', unit })));
  return battlefield;
};
const blocker = (id, position = [1, 1], capacity = 1, radius = 1) => initializeUnit({
  id, position, definition: {
    id: `blocker-${id}`, allegiance: { side: 'ALLY' }, vitality: { maxHp: 100 },
    blocker: { capacity, geometry: { radius } }, status: { initialFlags: [] },
  },
});
const enemy = (id, position = [1.25, 1], weight = 1) => initializeUnit({
  id, position, definition: {
    id: `enemy-${id}`, allegiance: { side: 'ENEMY' }, vitality: { maxHp: 100 },
    blockable: { weight }, spatial: { layer: 'GROUND' },
  },
});
const view = battlefield => battlefield.snapshot('draft');
const update = (battlefield, id, transition) => ({
  type: 'UPDATE_UNIT', unit: transition(view(battlefield).getUnit(id)),
});
const stun = unit => ({
  ...unit, status: addStatusContribution(unit.status, { id: 'test-stun', flags: ['STUNNED'] }),
});
const recover = unit => ({ ...unit, status: removeStatusContribution(unit.status, 'test-stun') });
const capacityChange = (unit, addition) => updateBlockingCapacityContributions(unit, () => contribution.register(contribution.empty(),
  { id: 'test-capacity', sequence: 0, kind: "SAMPLED", participating: true, values: [modifier.create({ addition })] },
));

test('advance acquires in target ID order, choosing the nearest available blocker and then blocker ID', () => {
  const tied = create([
    blocker(10, [0, 1]), enemy(21, [1, 1]), blocker(5, [2, 1]), enemy(20, [1, 1]),
  ]);
  assert.deepEqual(view(tied).blockingRelations, [
    { blockerUnitId: 5, blockedUnitId: 20 },
    { blockerUnitId: 10, blockedUnitId: 21 },
  ]);

  const nearest = create([
    enemy(21, [1, 1]), blocker(5, [2, 1]), enemy(20, [1, 1]),
    blocker(10, [0, 1]), enemy(19, [0.25, 1]),
  ]);
  assert.deepEqual(view(nearest).blockingRelations, [
    { blockerUnitId: 10, blockedUnitId: 19 },
    { blockerUnitId: 5, blockedUnitId: 20 },
  ]);
  assert.equal(view(nearest).blockerOf(21), undefined);
});

test('a newly registered closer blocker does not replace an existing legal relation', () => {
  const battlefield = create([blocker(10), enemy(20)]);
  const previous = view(battlefield);
  battlefield.advance([{ type: 'REGISTER_UNIT', unit: blocker(5, [1.125, 1]) }]);
  assert.equal(view(battlefield).blockerOf(20), 10);
  assert.deepEqual(view(battlefield).blockedBy(5), []);
  assert.equal(previous.blockerOf(20), 10);
});

for (const [name, change] of [
  ['dies', battlefield => update(battlefield, 10, unit => ({ ...unit, vitality: { ...unit.vitality, hp: 0 } }))],
  ['is removed', () => ({ type: 'REMOVE_UNIT', unitId: 10, reason: 'RETREAT' })],
  ['leaves spatial presence', battlefield => update(battlefield, 10, unit => ({ ...unit, spatialPresence: { present: false } }))],
]) {
  test(`advance transfers blocking immediately when the old blocker ${name}`, () => {
    const battlefield = create([blocker(10), blocker(11, [2, 1]), enemy(20)]);
    battlefield.apply();
    const published = battlefield.snapshot('state');
    assert.equal(published.blockerOf(20), 10);

    battlefield.advance([change(battlefield)]);
    assert.equal(view(battlefield).blockerOf(20), 11);
    assert.deepEqual(view(battlefield).blockedBy(10), []);
    assert.equal(published.blockerOf(20), 10);
    assert.equal(battlefield.snapshot('state').blockerOf(20), 10);
  });
}

test('stun releases the blocker and recovery acquires without a separate blocking phase', () => {
  const battlefield = create([blocker(10), enemy(20)]);
  assert.equal(view(battlefield).blockerOf(20), 10);
  battlefield.advance([update(battlefield, 10, stun)]);
  assert.equal(view(battlefield).blockerOf(20), undefined);

  battlefield.advance([update(battlefield, 10, recover)]);
  assert.equal(view(battlefield).blockerOf(20), 10);
});

test('one advance reconciles against final batch facts before publishing any new relation', () => {
  const battlefield = create([blocker(10), enemy(20)]);
  battlefield.apply();
  const original = view(battlefield).getUnit(10);
  battlefield.advance([
    { type: 'UPDATE_UNIT', unit: stun(original) },
    { type: 'REGISTER_UNIT', unit: blocker(5, [1.125, 1]) },
    { type: 'UPDATE_UNIT', unit: original },
  ]);
  assert.equal(view(battlefield).blockerOf(20), 10, 'temporary stun inside the batch must not transfer the relation');

  battlefield.advance([update(battlefield, 10, stun)]);
  assert.equal(view(battlefield).blockerOf(20), 5);
  assert.equal(battlefield.snapshot('state').blockerOf(20), 10);
  battlefield.apply();
  assert.equal(battlefield.snapshot('state').blockerOf(20), 5);
});

test('capacity changes retain fitting old relations and fill restored capacity using blockable weight', () => {
  const battlefield = create([blocker(10, [1, 1], 3), enemy(20, [1.25, 1], 2), enemy(21), enemy(22)]);
  assert.deepEqual(view(battlefield).blockedBy(10), [20, 21]);
  assert.equal(view(battlefield).blockingUsedCapacity(10), 3);

  battlefield.advance([update(battlefield, 10, unit => capacityChange(unit, -2))]);
  assert.deepEqual(view(battlefield).blockedBy(10), [21]);
  assert.equal(view(battlefield).blockingUsedCapacity(10), 1);

  battlefield.advance([update(battlefield, 10, unit => capacityChange(unit, 0))]);
  assert.deepEqual(view(battlefield).blockedBy(10), [21, 20]);
  assert.equal(view(battlefield).blockingUsedCapacity(10), 3);

  battlefield.advance([update(battlefield, 21, unit => ({ ...unit, vitality: { ...unit.vitality, hp: 0 } }))]);
  assert.deepEqual(view(battlefield).blockedBy(10), [20, 22]);
  assert.equal(view(battlefield).blockingUsedCapacity(10), 3);

  battlefield.advance([update(battlefield, 20, unit => ({ ...unit, blockable: { ...unit.blockable, weight: 4 } }))]);
  assert.deepEqual(view(battlefield).blockedBy(10), [22]);
  battlefield.advance([update(battlefield, 20, unit => ({ ...unit, blockable: { ...unit.blockable, weight: 2 } }))]);
  assert.deepEqual(view(battlefield).blockedBy(10), [22, 20]);
  assert.equal(view(battlefield).blockingUsedCapacity(10), 3);
});

test('position changes within one indexed tile trigger acquisition at the inclusive radius boundary', () => {
  for (const [id, position] of [[20, [1.25, 1]], [10, [1.125, 1]]]) {
    const battlefield = create([blocker(10, [1, 1], 1, 0.25), enemy(20, [1.375, 1])]);
    assert.equal(view(battlefield).blockerOf(20), undefined);
    assert.deepEqual(view(battlefield).unitsAt([1, 1]).map(unit => unit.id), [10, 20]);

    battlefield.advance([update(battlefield, id, unit => ({ ...unit, position }))]);
    assert.equal(view(battlefield).blockerOf(20), 10);
  }
});

test('radius changes query neighboring indexed tiles while exact geometry excludes targets outside the radius', () => {
  const battlefield = create([
    blocker(10, [1.375, 1], 2, 0.125), enemy(20, [1.625, 1]), enemy(21, [1.6251, 1]),
  ]);
  assert.deepEqual(view(battlefield).blockedBy(10), []);
  assert.deepEqual(view(battlefield).unitsAt([1, 2]).map(unit => unit.id), [20, 21]);

  battlefield.advance([update(battlefield, 10, unit => ({
    ...unit, blocker: { ...unit.blocker, geometry: { radius: 0.25 } },
  }))]);
  assert.deepEqual(view(battlefield).blockedBy(10), [20]);
});

test('a valid blocker can acquire a nearby target beyond the map index boundary', () => {
  const battlefield = create([
    blocker(10, [0, 1], 2, 0.75), enemy(20, [-0.75, 1]), enemy(21, [-0.7501, 1]),
  ]);
  assert.deepEqual(view(battlefield).blockedBy(10), [20]);
});
