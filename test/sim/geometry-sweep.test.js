import test from 'node:test';
import assert from 'node:assert/strict';
import {
  geometrySweepsHit,
  rangeOverlapsHit,
} from '../../dist/core/tactical/geometry/intersection.js';

const circle = (radius, offset = [0, 0]) => ({ type: 'CIRCLE', radius, offset });
const box = (x, y, offset = [0, 0]) => ({ type: 'BOX', halfExtents: [x, y], offset });
const geometry = (...shapes) => ({ shapes });
const sweep = (shape, from, to, hit, position = [0, 0]) =>
  geometrySweepsHit(geometry(shape), from, to, position, geometry(hit));

test('circle sweeps use the sum of both radii and include tangent contact', () => {
  assert.equal(sweep(circle(0.25), [-4, 1], [4, 1], circle(0.75)), true);
  assert.equal(sweep(circle(0.25), [-4, 1.001], [4, 1.001], circle(0.75)), false);
  assert.equal(sweep(circle(0.25), [-4, 0], [4, 0], circle(0.75)), true);
});

test('box sweeps combine both half extents without requiring endpoint overlap', () => {
  assert.equal(sweep(box(0.25, 0.25), [-4, 1], [4, 1], box(0.75, 0.75)), true);
  assert.equal(sweep(box(0.25, 0.25), [-4, 1.001], [4, 1.001], box(0.75, 0.75)), false);
  assert.equal(sweep(box(0.25, 0.25), [-4, -4], [4, 4], box(0.75, 0.75)), true);
});

for (const [moving, target] of [
  [circle(0.5), box(0.5, 0.5)],
  [box(0.5, 0.5), circle(0.5)],
]) {
  test(`${moving.type} sweeps against ${target.type} preserve rounded corners`, () => {
    assert.equal(sweep(moving, [-4, 1], [4, 1], target), true);
    assert.equal(sweep(moving, [-4, 1.001], [4, 1.001], target), false);
    assert.equal(sweep(moving, [0.7, 1.1], [1.1, 0.7], target), false);
    assert.equal(sweep(moving, [0.7, 0.9], [0.9, 0.7], target), true);
  });
}

test('sweeps include initial and final contact but do not extend beyond the segment', () => {
  assert.equal(sweep(circle(0.5), [-1, 0], [-4, 0], circle(0.5)), true);
  assert.equal(sweep(circle(0.5), [-4, 0], [-1, 0], circle(0.5)), true);
  assert.equal(sweep(circle(0.5), [-4, 0], [-1.001, 0], circle(0.5)), false);
  assert.equal(sweep(circle(0.5), [1.001, 0], [4, 0], circle(0.5)), false);
});

test('local offsets and target position translate each shape independently', () => {
  assert.equal(sweep(circle(0.25, [0, 2]), [0, 0], [10, 0], circle(0.25, [-2, 2]), [7, 0]), true);
  assert.equal(sweep(circle(0.25, [0, 2]), [0, 0], [10, 0], circle(0.25, [-2, 3]), [7, 0]), false);
  assert.equal(sweep(box(0.25, 0.25, [2, -1]), [0, 0], [10, 0], box(0.25, 0.25, [-1, 2]), [6, -3]), true);
});

test('composite sweeps test every moving and target shape', () => {
  const moving = geometry(circle(0.1, [0, 10]), box(0.2, 0.2));
  const target = geometry(circle(0.1, [0, 10]), circle(0.1, [0, -10]), box(0.2, 0.2, [0, -20]));

  assert.equal(geometrySweepsHit(moving, [0, 0], [10, 0], [5, 20], target), true);
  assert.equal(geometrySweepsHit(moving, [0, 1], [10, 1], [5, 20], target), false);
});

test('zero movement matches existing overlap queries for every shape pair', () => {
  const shapes = [circle(0.625), box(0.5, 0.5), circle(0, [0.25, 0]), box(0, 0.25)];
  const positions = [[0, 0], [0.875, 1], [1, 1], [1.126, 0], [-1, -1]];

  for (const moving of shapes) {
    for (const hit of shapes) {
      for (const position of positions) {
        const expected = rangeOverlapsHit(
          { type: 'SHAPES', geometry: geometry(moving) },
          position,
          [0, 0],
          geometry(hit),
        );

        assert.equal(sweep(moving, position, position, hit), expected);
      }
    }
  }
});

test('fast sweeps detect narrow targets continuously', () => {
  assert.equal(sweep(circle(0.001), [-10000, 0], [10000, 0], circle(0.001), [0.123, 0]), true);
  assert.equal(sweep(box(0.001, 0.001), [-10000, 0], [10000, 0], box(0.001, 0.001), [0.123, 0]), true);
});
