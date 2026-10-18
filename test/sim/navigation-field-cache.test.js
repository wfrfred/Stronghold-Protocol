import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Map } from '../../dist/core/tactical/battlefield/navigation/map.js';
import { create as createOverlay } from '../../dist/core/tactical/battlefield/navigation/overlay.js';
import { create, setOverlay, removeOverlay, nextPoint } from '../../dist/core/tactical/battlefield/navigation/state.js';

const cell = (overrides = {}) => ({
  passable: true, cost: 1,
  departures: { UP: true, RIGHT: true, DOWN: true, LEFT: true },
  ...overrides,
});
const baseline = (rows = 3, columns = 4, overrides = {}) => {
  const cells = Array.from({ length: rows * columns }, (_, index) => cell(overrides[index]));
  const map = new Map(rows, columns, cells);
  return { WALK: map, FLY: map };
};
const overlay = (id, cells, overrides = {}) => createOverlay({
  id, cells, denyPassage: false, denyDepartures: [], ...overrides,
});

test('navigation queries preserve authority and return the same values with cold and warm caches', () => {
  const state = create(baseline());
  const before = JSON.stringify(state);
  const cases = [
    ['WALK', [0, 0], [3.2, 2.1]],
    ['WALK', [0.4, 0.4], [3.2, 2.1]],
    ['WALK', [3.1, 2.1], [3.2, 2.1]],
    ['FLY', [0, 0], [3.2, 2.1]],
    ['WALK', [-2, 0], [3, 2]],
  ];
  const cold = cases.map(args => nextPoint(state, ...args));
  for (let pass = 0; pass < 5; pass++) {
    for (let index = cases.length - 1; index >= 0; index--) {
      assert.deepEqual(nextPoint(state, ...cases[index]), cold[index]);
    }
  }
  assert.equal(JSON.stringify(state), before);
  const recreated = create(baseline());
  for (let index = 0; index < cases.length; index++) assert.deepEqual(nextPoint(recreated, ...cases[index]), cold[index]);
});

test('overlay replacement and removal update navigation without changing retained snapshots', () => {
  const original = create(baseline(1, 4));
  const before = JSON.stringify(original);
  const wall = overlay(7, [[0, 1]], { denyPassage: true });
  const blocked = setOverlay(original, 'WALK', wall);
  assert.deepEqual(nextPoint(original, 'WALK', [0, 0], [3.2, 0]), [3.2, 0]);
  assert.equal(nextPoint(blocked, 'WALK', [0, 0], [3.2, 0]), null);
  assert.deepEqual(nextPoint(blocked, 'FLY', [0, 0], [3.2, 0]), [3.2, 0]);
  assert.equal(original.overlays.WALK.length, 0);
  assert.equal(blocked.overlays.WALK.length, 1);

  const moved = setOverlay(blocked, 'WALK', overlay(7, [[0, 0]], { denyPassage: true }));
  assert.equal(moved.overlays.WALK.length, 1);
  assert.equal(nextPoint(moved, 'WALK', [0, 0], [3.2, 0]), null);
  assert.deepEqual(nextPoint(moved, 'WALK', [1, 0], [3.2, 0]), [3.2, 0]);
  const restored = removeOverlay(moved, 'WALK', { id: 7 });
  assert.equal(restored.overlays.WALK.length, 0);
  assert.deepEqual(nextPoint(restored, 'WALK', [0, 0], [3.2, 0]), [3.2, 0]);
  assert.equal(removeOverlay(restored, 'WALK', { id: 7 }), restored);
  assert.equal(nextPoint(blocked, 'WALK', [0, 0], [3.2, 0]), null);
  assert.equal(JSON.stringify(original), before);
});

test('navigation creation isolates input records and validates mode invariants', () => {
  const input = baseline(1, 2);
  const state = create(input);
  input.WALK = new Map(1, 2, [cell({ passable: false }), cell()]);
  assert.deepEqual(nextPoint(state, 'WALK', [0, 0], [1, 0]), [1, 0]);
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.baseline) && Object.isFrozen(state.overlays));
  assert.ok(Object.isFrozen(state.overlays.WALK) && Object.isFrozen(state.overlays.FLY));
  assert.throws(() => create({ WALK: baseline(1, 2).WALK, FLY: baseline(2, 1).FLY }), RangeError);
  assert.throws(() => create({ WALK: baseline(1, 2).WALK, FLY: new Map(1, 2, [cell({ cost: 2 }), cell()]) }), RangeError);
  assert.throws(() => setOverlay(state, 'FLY', overlay(1, [[0, 0]], { cost: 2 })), RangeError);
});

test('overlay registration owns its input containers and keeps mode identity independent', () => {
  const original = create(baseline(1, 3));
  const cells = [[0, 1]];
  const denyDepartures = [];
  const input = { id: 4, cells, denyPassage: true, denyDepartures };
  const walk = setOverlay(original, 'WALK', input);
  const both = setOverlay(walk, 'FLY', { ...input, cells: [[0, 2]] });
  cells[0][1] = 0;
  denyDepartures.push('RIGHT');
  assert.deepEqual(walk.overlays.WALK[0].cells, [[0, 1]]);
  assert.deepEqual(walk.overlays.WALK[0].denyDepartures, []);
  assert.equal(nextPoint(both, 'WALK', [0, 0], [2, 0]), null);
  assert.equal(nextPoint(both, 'FLY', [0, 0], [2, 0]), null);
  const removedWalk = removeOverlay(both, 'WALK', { id: 4 });
  assert.deepEqual(nextPoint(removedWalk, 'WALK', [0, 0], [2, 0]), [2, 0]);
  assert.equal(nextPoint(removedWalk, 'FLY', [0, 0], [2, 0]), null);
  assert.equal(both.overlays.WALK.length, 1);
});

test('navigation rejects unavailable fields while leaving arrival checks to its consumer', () => {
  const state = create(baseline(1, 3, { 1: { passable: false } }));
  assert.equal(nextPoint(state, 'WALK', [-1, 0], [2, 0]), null);
  assert.equal(nextPoint(state, 'WALK', [0, 0], [3, 0]), null);
  assert.equal(nextPoint(state, 'WALK', [0, 0], [1, 0]), null);
  assert.equal(nextPoint(state, 'WALK', [0, 0], [2, 0]), null);
  assert.deepEqual(nextPoint(state, 'WALK', [2.1, 0], [2.1, 0]), [2.1, 0]);
});

test('navigation follows a tile field from noncenter positions and preserves the exact last target', () => {
  const state = create(baseline(3, 4, { 5: { passable: false } }));
  const target = [3.2, 2.15];
  assert.deepEqual(nextPoint(state, 'WALK', [0.49, 0.49], target), nextPoint(state, 'WALK', [0, 0], target));
  assert.deepEqual(nextPoint(state, 'WALK', [2, 2], target), target, 'a next pointer to the target tile uses the precise world target');
  assert.deepEqual(nextPoint(state, 'WALK', [3.1, 2], target), target);
});


test('navigation does not replace a field successor with a world-segment fallback', () => {
  const state = create(baseline(5, 6, {
    14: { passable: false }, 15: { passable: false }, 19: { passable: false },
  }));
  assert.deepEqual(nextPoint(state, 'WALK', [3, 0], [5, 4]), [5, 4]);
  assert.deepEqual(nextPoint(state, 'WALK', [2.51, 0.49], [5, 4]), [5, 4]);
});
