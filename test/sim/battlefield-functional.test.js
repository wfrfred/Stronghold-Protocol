import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, addUnit, addUnits, replaceUnit, removeUnit, setNavigation } from '../../dist/core/tactical/battlefield/state.js';
import { view } from '../../dist/core/tactical/battlefield/view.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';

import { setOverlay, nextPoint } from '../../dist/core/tactical/battlefield/navigation/state.js';
import { initialize } from "../helpers/unit.js";
import { ref } from '../../dist/core/tactical/unit/query.js';
import { createBattleState, registerUnit, updateUnit, removeUnit as removeBattleUnit } from '../../dist/core/tactical/battle/state.js';
import { finishBattleEvents } from '../../dist/core/tactical/battle/events.js';

const initial = () => create({
  map: createBattlefieldMap(1, 3, Array.from({ length: 3 }, () => createTile({
    heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
  }))),
});
const unit = (id, position = [1, 0], definition = {}) => initialize({
  id, position, definition: { id: `functional-${id}`, vitality: { maxHp: 100, defense: 0, resistance: 0 }, ...definition },
});

test('pure transitions preserve input states and fixed views while allowing independent branches', () => {
  const empty = initial();
  const emptyView = view(empty);
  const original = unit(1);
  const registered = addUnit(empty, original);
  const firstView = view(registered);
  const updateHp = hp => ({ ...original, vitality: { ...original.vitality, hp } });
  const left = replaceUnit(registered, updateHp(40));
  const right = replaceUnit(registered, updateHp(70));

  assert.deepEqual([...registered.units.keys()], [1]);
  assert.deepEqual(emptyView.unitIds, []);
  assert.equal(firstView.getUnit(1), original, 'stored values are shared by immutable convention');
  assert.equal(registered.units.get(1).vitality.hp, 100);
  assert.equal(view(left).getUnit(1).vitality.hp, 40);
  assert.equal(view(right).getUnit(1).vitality.hp, 70);
  assert.equal(addUnits(registered, []), registered);
  assert.equal(replaceUnit(registered, original), registered);
});

test('pure field updates maintain spatial indexes without acquiring blocking relations', () => {
  const blocker = (id, column) => unit(id, [column, 0], {
    allegiance: { side: 'ALLY' }, blocker: { capacity: 1, geometry: { radius: 1 } },
  });
  const enemy = unit(20, [1.25, 0], {
    allegiance: { side: 'ENEMY' }, blockable: { volume: 1 }, layer: { type: 'GROUND' },
  });
  const before = addUnits(initial(), [blocker(10, 1), blocker(11, 2), enemy]);
  const beforeView = view(before);
  const removed = removeUnit(before, ref(before.units.get(10)));

  assert.equal(beforeView.blockerOf(20), undefined);
  assert.equal(view(removed).blockerOf(20), undefined);
  assert.equal(beforeView.blockerOf(20), undefined);
  assert.deepEqual(beforeView.unitsAt([0, 1]).map(unit => unit.id), [10, 20]);
  assert.deepEqual(view(removed).unitsAt([0, 1]).map(unit => unit.id), [20]);
  assert.equal('blockingRelations' in before, false);
  assert.equal(removed.units.has(10), false);
});

test('navigation overlays and spatial projections belong to each returned value', () => {
  const owner = unit(1, [0, 0]);
  let registered = addUnit(initial(), owner);
  registered = setNavigation(registered, setOverlay(registered.navigation, 'WALK', {
    id: 7, cells: [[0, 0]], denyPassage: true, denyDepartures: [],
  }));
  const previous = view(registered);
  const moved = replaceUnit(registered, { ...owner, position: [1, 0] });
  assert.equal(moved.navigation, registered.navigation);
  const replaced = setNavigation(moved, setOverlay(moved.navigation, 'WALK', {
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

test('battle removal records the current instance independently from final field content', () => {
  const before = createBattleState(initial());
  const temporary = unit(1);
  const registered = registerUnit(before, temporary);
  const latest = { ...temporary, vitality: { ...temporary.vitality, hp: 40 } };
  const updated = updateUnit(registered, latest);
  const removed = removeBattleUnit(updated, temporary.id, 'SCRIPT');

  assert.deepEqual(view(removed.battlefield).unitIds, []);
  assert.deepEqual(view(before.battlefield).unitIds, []);
  assert.equal(registered.battlefield.units.get(temporary.id), temporary);
  assert.deepEqual(removed.removedUnits, [
    { unitId: temporary.id, reason: 'SCRIPT', unit: { ...latest, lifecycle: 'LEAVING' } },
  ]);
  assert.equal(removeBattleUnit(removed, temporary.id, 'SCRIPT'), removed);
  const { events } = finishBattleEvents(removed.events, removed.removedUnits, 0);
  assert.equal(events[0].type, 'UNIT_REMOVED');
  assert.equal(events[0].unit.vitality.hp, 40);
});
