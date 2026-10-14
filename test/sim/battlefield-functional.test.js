import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, transition } from '../../dist/core/tactical/battlefield/state.js';
import { view } from '../../dist/core/tactical/battlefield/view.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';
import { createNavigationModifierDefinition } from '../../dist/core/tactical/battlefield/navigation/modifier.js';
import { initialize } from '../../dist/core/tactical/unit/initialize.js';

const initial = () => create({
  map: createBattlefieldMap(1, 3, Array.from({ length: 3 }, () => createTile({
    heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
  }))),
});
const unit = (id, position = [1, 0], definition = {}) => initialize({
  id, position, definition: { id: `functional-${id}`, vitality: { maxHp: 100 }, ...definition },
});
const register = unit => ({ type: 'REGISTER_UNIT', unit });

test('pure transitions preserve input states and fixed views while allowing independent branches', () => {
  const empty = initial();
  const emptyView = view(empty);
  const original = unit(1);
  const registered = transition(empty, [register(original)]);
  const firstView = view(registered.state);
  const updateHp = hp => ({
    type: 'UPDATE_UNIT', unit: { ...original, vitality: { ...original.vitality, hp } },
  });
  const left = transition(registered.state, [updateHp(40)]);
  const right = transition(registered.state, [updateHp(70)]);

  assert.deepEqual(registered.facts.registeredUnitIds, [1]);
  assert.deepEqual(emptyView.unitIds, []);
  assert.equal(firstView.getUnit(1), original, 'stored values are shared by immutable convention');
  assert.equal(registered.state.units.get(1).vitality.hp, 100);
  assert.equal(view(left.state).getUnit(1).vitality.hp, 40);
  assert.equal(view(right.state).getUnit(1).vitality.hp, 70);
  assert.equal(transition(registered.state, []).state, registered.state);
});

test('pure transition maintains blocking before returning and preserves the previous relation', () => {
  const blocker = (id, column) => unit(id, [column, 0], {
    allegiance: { side: 'ALLY' }, blocker: { capacity: 1, geometry: { radius: 1 } },
  });
  const enemy = unit(20, [1.25, 0], {
    allegiance: { side: 'ENEMY' }, blockable: { weight: 1 }, spatial: { layer: 'GROUND' },
  });
  const before = transition(initial(), [register(blocker(10, 1)), register(blocker(11, 2)), register(enemy)]).state;
  const beforeView = view(before);
  const removed = transition(before, [{ type: 'REMOVE_UNIT', unitId: 10, reason: 'RETREAT' }]);

  assert.equal(beforeView.blockerOf(20), 10);
  assert.equal(view(removed.state).blockerOf(20), 11);
  assert.equal(beforeView.blockerOf(20), 10);
  assert.deepEqual(removed.facts.removedUnits.map(({ unitId }) => unitId), [10]);
});

test('navigation and spatial projections belong to each returned value', () => {
  const owner = unit(1, [0, 0]);
  const registered = transition(initial(), [
    register(owner),
    {
      type: 'ADD_NAVIGATION_MODIFIER', navigationModifier: {
        id: 7,
        definition: createNavigationModifierDefinition({
          id: 'functional-wall', FLY: null,
          WALK: { denyPassage: true, deniedDepartures: [], costFloor: 1 },
        }),
        source: { type: 'UNIT', unitId: 1 }, active: true, expiresAtTick: null,
        region: { type: 'FOLLOW_UNIT', unitId: 1, range: [[0, 0]], direction: 'RIGHT' },
      },
    },
  ]).state;
  const previous = view(registered);
  const moved = transition(registered, [{ type: 'UPDATE_UNIT', unit: { ...owner, position: [1, 0] } }]);
  const next = view(moved.state);

  assert.deepEqual(moved.facts.changedNavigationModes, ['WALK']);
  assert.deepEqual(previous.unitsAt([0, 0]).map(unit => unit.id), [1]);
  assert.deepEqual(next.unitsAt([0, 1]).map(unit => unit.id), [1]);
  assert.equal(previous.navigationMaps.WALK.cells[0].passable, false);
  assert.equal(next.navigationMaps.WALK.cells[0].passable, true);
  assert.equal(next.navigationMaps.WALK.cells[1].passable, false);
  assert.deepEqual(previous.navigationModifiersAt([0, 0]), [7]);
  assert.deepEqual(next.navigationModifiersAt([0, 1]), [7]);
  assert.equal(moved.state.map, registered.map);
  assert.equal(moved.state.baseline, registered.baseline);
});

test('pure transition reports transient registrations and removals even when the final field is empty', () => {
  const before = initial();
  const temporary = unit(1);
  const advanced = transition(before, [
    register(temporary),
    { type: 'REMOVE_UNIT', unitId: temporary.id, reason: 'SCRIPT' },
  ]);

  assert.deepEqual(advanced.facts.registeredUnitIds, [temporary.id]);
  assert.deepEqual(advanced.facts.removedUnits, [
    { unitId: temporary.id, reason: 'SCRIPT', unit: temporary },
  ]);
  assert.deepEqual(view(advanced.state).unitIds, []);
  assert.deepEqual(view(before).unitIds, []);
});
