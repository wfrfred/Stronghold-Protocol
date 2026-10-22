import test from 'node:test';
import assert from 'node:assert/strict';
import { overlaps, sweep } from '../../dist/core/tactical/geometry/intersection.js';

const circle = (radius, offset = [0, 0]) => ({ type: 'CIRCLE', radius, offset });
const box = (x, y, offset = [0, 0]) => ({ type: 'BOX', halfExtents: [x, y], offset });
const cast = (shape, from, to, target, position = [0, 0]) =>
  sweep(shape, from, to, target, position);
const near = (actual, expected, tolerance = 1e-12) => {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≈ ${expected}`);
};

test('circle sweeps return the first contact fraction and include tangency', () => {
  near(cast(circle(0.25), [-4, 1], [4, 1], circle(0.75)), 0.5);
  assert.equal(cast(circle(0.25), [-4, 1.001], [4, 1.001], circle(0.75)), null);
  near(cast(circle(0.25), [-4, 0], [4, 0], circle(0.75)), 3 / 8);
});

test('box sweeps find the earliest contact for both directions and diagonal movement', () => {
  near(cast(box(0.25, 0.25), [-4, 1], [4, 1], box(0.75, 0.75)), 3 / 8);
  near(cast(box(0.25, 0.25), [4, 0], [-4, 0], box(0.75, 0.75)), 3 / 8);
  assert.equal(cast(box(0.25, 0.25), [-4, 1.001], [4, 1.001], box(0.75, 0.75)), null);
  near(cast(box(0.25, 0.25), [-4, -4], [4, 4], box(0.75, 0.75)), 3 / 8);
});

for (const [moving, target] of [
  [circle(0.5), box(0.5, 0.5)],
  [box(0.5, 0.5), circle(0.5)],
]) {
  test(`${moving.type} sweeps against ${target.type} preserve rounded corners`, () => {
    near(cast(moving, [-4, 1], [4, 1], target), 7 / 16);
    assert.equal(cast(moving, [-4, 1.001], [4, 1.001], target), null);
    assert.equal(cast(moving, [0.7, 1.1], [1.1, 0.7], target), null);
    assert.equal(cast(moving, [0.7, 0.9], [0.9, 0.7], target), 0);
  });
}

test('mixed shape sweeps include tangency to the circular corner', () => {
  const from = [-1.125, 2.5];
  const to = [2.875, -0.5];
  near(cast(circle(0.625), from, to, box(0.5, 0.5)), 0.5);
  near(cast(box(0.5, 0.5), from, to, circle(0.625)), 0.5);
});

test('sweeps report initial overlap as zero and include contact at the segment end', () => {
  assert.equal(cast(circle(0.5), [0, 0], [4, 0], circle(0.5)), 0);
  assert.equal(cast(circle(0.5), [-1, 0], [-4, 0], circle(0.5)), 0);
  assert.equal(cast(circle(0.5), [-4, 0], [-1, 0], circle(0.5)), 1);
  assert.equal(cast(circle(0.5), [-4, 0], [-1.001, 0], circle(0.5)), null);
  assert.equal(cast(circle(0.5), [1.001, 0], [4, 0], circle(0.5)), null);
});

test('local offsets and target origin translate each shape independently', () => {
  near(cast(circle(0.25, [0, 2]), [0, 0], [10, 0], circle(0.25, [-2, 2]), [7, 0]), 0.45);
  assert.equal(cast(circle(0.25, [0, 2]), [0, 0], [10, 0], circle(0.25, [-2, 3]), [7, 0]), null);
  near(cast(box(0.25, 0.25, [2, -1]), [0, 0], [10, 0], box(0.25, 0.25, [-1, 2]), [6, -3]), 0.25);
});

test('zero movement returns zero for overlap and null otherwise for every shape pair', () => {
  const shapes = [circle(0.625), box(0.5, 0.5), circle(0, [0.25, 0]), box(0, 0.25)];
  const positions = [[0, 0], [0.875, 1], [1, 1], [1.126, 0], [-1, -1]];

  for (const moving of shapes) {
    for (const target of shapes) {
      for (const position of positions) {
        const expected = overlaps([moving], position, target, [0, 0]) ? 0 : null;
        assert.equal(cast(moving, position, position, target), expected);
      }
    }
  }
});

test('fast sweeps detect narrow targets continuously at their first contact', () => {
  const expected = (10000 + 0.123 - 0.002) / 20000;
  near(cast(circle(0.001), [-10000, 0], [10000, 0], circle(0.001), [0.123, 0]), expected, 1e-9);
  near(cast(box(0.001, 0.001), [-10000, 0], [10000, 0], box(0.001, 0.001), [0.123, 0]), expected, 1e-9);
});
