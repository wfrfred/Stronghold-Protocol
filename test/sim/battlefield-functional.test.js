import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, transition, setNavigation } from '../../dist/core/tactical/battlefield/state.js';
import { view } from '../../dist/core/tactical/battlefield/view.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';

import { setOverlay, nextPoint } from '../../dist/core/tactical/battlefield/navigation/state.js';
import { initialize } from "../helpers/unit.js";

const initial = () => create({
  map: createBattlefieldMap(1, 3, Array.from({ length: 3 }, () => createTile({
    heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
  }))),
});
const unit = (id, position = [1, 0], definition = {}) => initialize({
  id, position, definition: { id: `functional-${id}`, vitality: { maxHp: 100, defense: 0, resistance: 0 }, ...definition },
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
    allegiance: { side: 'ENEMY' }, blockable: { volume: 1 }, layer: { type: 'GROUND' },
  });
  const before = transition(initial(), [register(blocker(10, 1)), register(blocker(11, 2)), register(enemy)]).state;
  const beforeView = view(before);
  const removed = transition(before, [{ type: 'REMOVE_UNIT', unitId: 10, reason: 'RETREAT' }]);

  assert.equal(beforeView.blockerOf(20), 10);
  assert.equal(view(removed.state).blockerOf(20), 11);
  assert.equal(beforeView.blockerOf(20), 10);
  assert.deepEqual(removed.facts.removedUnits.map(({ unitId }) => unitId), [10]);
});

test('navigation overlays and spatial projections belong to each returned value', () => {
  const owner = unit(1, [0, 0]);
  let registered = transition(initial(), [register(owner)]).state;
  registered = setNavigation(registered, setOverlay(registered.navigation, 'WALK', {
    id: 7, cells: [[0, 0]], denyPassage: true, denyDepartures: [],
  }));
  const previous = view(registered);
  const moved = transition(registered, [{ type: 'UPDATE_UNIT', unit: { ...owner, position: [1, 0] } }]);
  assert.equal(moved.state.navigation, registered.navigation);
  const replaced = setNavigation(moved.state, setOverlay(moved.state.navigation, 'WALK', {
    id: 7, cells: [[0, 1]], denyPassage: true, denyDepartures: [],
  }));
  const next = view(replaced);

  assert.deepEqual(previous.unitsAt([0, 0]).map(unit => unit.id), [1]);
  assert.deepEqual(next.unitsAt([0, 1]).map(unit => unit.id), [1]);
  assert.equal(nextPoint(previous.navigation, 'WALK', [0, 0], [0, 0]), null);
  assert.deepEqual(nextPoint(next.navigation, 'WALK', [0, 0], [0, 0]), [0, 0]);
  assert.deepEqual(nextPoint(previous.navigation, 'WALK', [2, 0], [1, 0]), [1, 0]);
  assert.equal(nextPoint(next.navigation, 'WALK', [2, 0], [1, 0]), null);
  assert.equal(replaced.map, registered.map);
  assert.equal(replaced.navigation.baseline, registered.navigation.baseline);
  assert.equal(setNavigation(replaced, replaced.navigation), replaced);
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
