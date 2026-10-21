import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create as createFieldState, transition as transitionBattlefield } from '../../dist/core/tactical/battlefield/state.js';
import { view as viewBattlefield } from '../../dist/core/tactical/battlefield/view.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';
import { initialize } from "../helpers/unit.js";
import { setCapacityContribution, setRule, removeRule } from '../../dist/core/tactical/unit/capability/blocking/blocker.js';
import { setVolumeContribution } from '../../dist/core/tactical/unit/capability/blocking/blockable.js';
import * as modifier from '../../dist/core/tactical/unit/contribution/attribute.js';

const create = units => {
  let battlefield = createFieldState({
    map: createBattlefieldMap(3, 5, Array.from({ length: 15 }, () => createTile({
      heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
      playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
    }))),
  });
  battlefield = transitionBattlefield(battlefield, units.map(unit => ({ type: 'REGISTER_UNIT', unit }))).state;
  return battlefield;
};
const blocker = (id, position = [1, 1], capacity = 1, radius = 1) => initialize({
  id, position, definition: {
    id: `blocker-${id}`, spatialPresence: {}, allegiance: { side: 'ALLY' }, vitality: { maxHp: 100, defense: 0, resistance: 0 },
    blocker: { capacity, geometry: { radius } },
  },
});
const enemy = (id, position = [1.25, 1], volume = 1) => initialize({
  id, position, definition: {
    id: `enemy-${id}`, allegiance: { side: 'ENEMY' }, vitality: { maxHp: 100, defense: 0, resistance: 0 },
    blockable: { volume }, layer: { type: 'GROUND' },
  },
});
const view = viewBattlefield;
const update = (battlefield, id, transition) => ({
  type: 'UPDATE_UNIT', unit: transition(view(battlefield).getUnit(id)),
});
const disableBlocking = unit => ({
  ...unit, blocker: setRule(unit.blocker, { id: 'test-disable-blocking', allows: () => false }),
});
const enableBlocking = unit => ({ ...unit, blocker: removeRule(unit.blocker, 'test-disable-blocking') });
const capacityChange = (unit, addition) => ({ ...unit, blocker: setCapacityContribution(unit.blocker, { id: 'test-capacity', value: [modifier.create({ addition })] }) });

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

test('blocking uses current opposing sides and excludes units without allegiance', () => {
  const withSide = (unit, side) => {
    const { allegiance, ...definition } = unit.definition;
    return initialize({
      id: unit.id, position: unit.position,
      definition: { ...definition, ...(side === undefined ? {} : { allegiance: { side } }) },
    });
  };
  for (const [blockerSide, blockedSide, expected] of [
    ['ALLY', 'NEUTRAL', false],
    ['ENEMY', 'NEUTRAL', true],
    ['NEUTRAL', 'ENEMY', true],
    [undefined, 'ENEMY', false],
    ['ALLY', undefined, false],
  ]) {
    const battlefield = create([
      withSide(blocker(10), blockerSide), withSide(enemy(20), blockedSide),
    ]);
    assert.equal(view(battlefield).blockerOf(20), expected ? 10 : undefined,
      `${blockerSide} → ${blockedSide}`);
  }

  let battlefield = create([blocker(10), enemy(20)]);
  battlefield = transitionBattlefield(battlefield, [update(battlefield, 20,
    unit => ({ ...unit, allegiance: { side: 'NEUTRAL' } }))]).state;
  assert.equal(view(battlefield).blockerOf(20), undefined);
});

test('a newly registered closer blocker does not replace an existing legal relation', () => {
  let battlefield = create([blocker(10), enemy(20)]);
  const previous = view(battlefield);
  battlefield = transitionBattlefield(battlefield, [{ type: 'REGISTER_UNIT', unit: blocker(5, [1.125, 1]) }]).state;
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
    let battlefield = create([blocker(10), blocker(11, [2, 1]), enemy(20)]);
    const published = view(battlefield);
    assert.equal(published.blockerOf(20), 10);

    battlefield = transitionBattlefield(battlefield, [change(battlefield)]).state;
    assert.equal(view(battlefield).blockerOf(20), 11);
    assert.deepEqual(view(battlefield).blockedBy(10), []);
    assert.equal(published.blockerOf(20), 10);
  });
}

test('a blocking rule releases the blocker and its removal acquires without a separate blocking phase', () => {
  let battlefield = create([blocker(10), enemy(20)]);
  assert.equal(view(battlefield).blockerOf(20), 10);
  battlefield = transitionBattlefield(battlefield, [update(battlefield, 10, disableBlocking)]).state;
  assert.equal(view(battlefield).blockerOf(20), undefined);

  battlefield = transitionBattlefield(battlefield, [update(battlefield, 10, enableBlocking)]).state;
  assert.equal(view(battlefield).blockerOf(20), 10);
});

test('one transition reconciles against final batch facts before returning any new relation', () => {
  let battlefield = create([blocker(10), enemy(20)]);
  const published = view(battlefield);
  const original = view(battlefield).getUnit(10);
  battlefield = transitionBattlefield(battlefield, [
    { type: 'UPDATE_UNIT', unit: disableBlocking(original) },
    { type: 'REGISTER_UNIT', unit: blocker(5, [1.125, 1]) },
    { type: 'UPDATE_UNIT', unit: original },
  ]).state;
  assert.equal(view(battlefield).blockerOf(20), 10, 'temporary blocking denial inside the batch must not transfer the relation');

  battlefield = transitionBattlefield(battlefield, [update(battlefield, 10, disableBlocking)]).state;
  assert.equal(view(battlefield).blockerOf(20), 5);
  assert.equal(published.blockerOf(20), 10);
});

test('capacity changes retain fitting old relations and fill restored capacity using blockable volume', () => {
  let battlefield = create([blocker(10, [1, 1], 3), enemy(20, [1.25, 1], 2), enemy(21), enemy(22)]);
  assert.deepEqual(view(battlefield).blockedBy(10), [20, 21]);
  assert.equal(view(battlefield).blockingUsedCapacity(10), 3);

  battlefield = transitionBattlefield(battlefield, [update(battlefield, 10, unit => capacityChange(unit, -2))]).state;
  assert.deepEqual(view(battlefield).blockedBy(10), [21]);
  assert.equal(view(battlefield).blockingUsedCapacity(10), 1);

  battlefield = transitionBattlefield(battlefield, [update(battlefield, 10, unit => capacityChange(unit, 0))]).state;
  assert.deepEqual(view(battlefield).blockedBy(10), [21, 20]);
  assert.equal(view(battlefield).blockingUsedCapacity(10), 3);

  battlefield = transitionBattlefield(battlefield, [update(battlefield, 21, unit => ({ ...unit, vitality: { ...unit.vitality, hp: 0 } }))]).state;
  assert.deepEqual(view(battlefield).blockedBy(10), [20, 22]);
  assert.equal(view(battlefield).blockingUsedCapacity(10), 3);

  battlefield = transitionBattlefield(battlefield, [update(battlefield, 20, unit => ({
    ...unit, blockable: setVolumeContribution(unit.blockable, { id: 'volume', value: 2 }),
  }))]).state;
  assert.deepEqual(view(battlefield).blockedBy(10), [22]);
  battlefield = transitionBattlefield(battlefield, [update(battlefield, 20, unit => ({
    ...unit, blockable: setVolumeContribution(unit.blockable, { id: 'volume', value: 0 }),
  }))]).state;
  assert.deepEqual(view(battlefield).blockedBy(10), [22, 20]);
  assert.equal(view(battlefield).blockingUsedCapacity(10), 3);
});

test('position changes within one indexed tile trigger acquisition at the inclusive radius boundary', () => {
  for (const [id, position] of [[20, [1.25, 1]], [10, [1.125, 1]]]) {
    let battlefield = create([blocker(10, [1, 1], 1, 0.25), enemy(20, [1.375, 1])]);
    assert.equal(view(battlefield).blockerOf(20), undefined);
    assert.deepEqual(view(battlefield).unitsAt([1, 1]).map(unit => unit.id), [10, 20]);

    battlefield = transitionBattlefield(battlefield, [update(battlefield, id, unit => ({ ...unit, position }))]).state;
    assert.equal(view(battlefield).blockerOf(20), 10);
  }
});

test('radius changes query neighboring indexed tiles while exact geometry excludes targets outside the radius', () => {
  let battlefield = create([
    blocker(10, [1.375, 1], 2, 0.125), enemy(20, [1.625, 1]), enemy(21, [1.6251, 1]),
  ]);
  assert.deepEqual(view(battlefield).blockedBy(10), []);
  assert.deepEqual(view(battlefield).unitsAt([1, 2]).map(unit => unit.id), [20, 21]);

  battlefield = transitionBattlefield(battlefield, [update(battlefield, 10, unit => ({
    ...unit, blocker: { ...unit.blocker, geometry: { radius: 0.25 } },
  }))]).state;
  assert.deepEqual(view(battlefield).blockedBy(10), [20]);
});

test('a valid blocker can acquire a nearby target beyond the map index boundary', () => {
  const battlefield = create([
    blocker(10, [0, 1], 2, 0.75), enemy(20, [-0.75, 1]), enemy(21, [-0.7501, 1]),
  ]);
  assert.deepEqual(view(battlefield).blockedBy(10), [20]);
});
