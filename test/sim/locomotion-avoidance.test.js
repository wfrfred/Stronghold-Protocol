import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Map } from '../../dist/core/tactical/battlefield/navigation/map.js';
import { calculate } from '../../dist/core/tactical/unit/capability/locomotion/avoidance.js';
import { TICKS_PER_SECOND } from '../../dist/core/tactical/tick.js';

const tickForce = 1 / TICKS_PER_SECOND ** 2;
const cell = (input = {}) => ({
  passable: true,
  cost: 1,
  departures: { UP: true, RIGHT: true, DOWN: true, LEFT: true },
  ...input,
});
const map = (overrides = {}, rows = 3, columns = 3) => new Map(
  rows,
  columns,
  Array.from({ length: rows * columns }, (_, index) => cell(overrides[index])),
);
const close = (actual, expected) => {
  assert.ok(Math.abs(actual[0] - expected[0]) < 1e-12, `x: ${actual[0]} != ${expected[0]}`);
  assert.ok(Math.abs(actual[1] - expected[1]) < 1e-12, `y: ${actual[1]} != ${expected[1]}`);
};
const force = (terrain, position, input = {}) => calculate(
  terrain,
  input.mode ?? 'WALK',
  position,
  input.halfBodyWidth ?? 0,
  input.direction ?? [0, 0],
  input.velocity ?? [0.1, 0],
  input.speed ?? 0.1,
);

for (const [row, col] of [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]) {
  test(`terrain avoidance repels the (${row}, ${col}) neighbor in world axes`, () => {
    const terrain = map({ [(1 + row) * 3 + 1 + col]: { passable: false } });
    const position = [1 + col * 0.3, 1 + row * 0.3];
    const length = Math.hypot(col, row);
    close(force(terrain, position), [-col / length * tickForce, -row / length * tickForce]);
  });
}

test('terrain avoidance uses the 0.25 boundary and normalizes only a significant force', () => {
  const terrain = map({ 5: { passable: false } });
  close(force(terrain, [1.25, 1]), [0, 0]);
  close(force(terrain, [1.250001, 1]), [0, 0]);
  close(force(terrain, [1.25001, 1]), [-tickForce, 0]);
});

test('terrain avoidance applies body width horizontally rather than as a circular radius', () => {
  const right = map({ 5: { passable: false } });
  const above = map({ 7: { passable: false } });
  close(force(right, [1.1, 1]), [0, 0]);
  close(force(right, [1.1, 1], { halfBodyWidth: 0.2 }), [-tickForce, 0]);
  close(force(above, [1, 1.1], { halfBodyWidth: 0.2 }), [0, 0]);
});

test('a diagonal obstacle contributes only after both projected axes pass the threshold', () => {
  const terrain = map({ 8: { passable: false } });
  close(force(terrain, [1.4, 1.2]), [0, 0]);
  close(force(terrain, [1.2, 1.4]), [0, 0]);
  close(force(terrain, [1.4, 1.4]), [-tickForce / Math.SQRT2, -tickForce / Math.SQRT2]);
});

test('cardinal and diagonal forces accumulate with diagonal average penetration before normalization', () => {
  const terrain = map({ 5: { passable: false }, 8: { passable: false } });
  close(force(terrain, [1.35, 1.4], { halfBodyWidth: 0.2 }), [
    -7 / Math.sqrt(58) * tickForce,
    -3 / Math.sqrt(58) * tickForce,
  ]);
});

test('WALK avoids obstacle-like costs at 1000 while FLY only avoids impassability', () => {
  const ordinary = map({ 5: { cost: 999 } });
  const obstacleLike = map({ 5: { cost: 1000 } });
  const blocked = map({ 5: { passable: false, cost: 1 } });
  close(force(ordinary, [1.4, 1]), [0, 0]);
  close(force(obstacleLike, [1.4, 1]), [-tickForce, 0]);
  close(force(obstacleLike, [1.4, 1], { mode: 'FLY' }), [0, 0]);
  close(force(blocked, [1.4, 1], { mode: 'FLY' }), [-tickForce, 0]);
});

test('terrain avoidance removes the steering-direction projection without renormalizing', () => {
  const terrain = map({ 5: { passable: false } });
  close(force(terrain, [1.4, 1], { direction: [1, 0] }), [0, 0]);
  close(force(terrain, [1.4, 1], { direction: [0, 1] }), [-tickForce, 0]);
  close(force(terrain, [1.4, 1], { direction: [1 / Math.SQRT2, 1 / Math.SQRT2] }), [
    -tickForce / 2,
    tickForce / 2,
  ]);
});

test('terrain avoidance normalizes the requested direction and treats tiny directions as zero', () => {
  const terrain = map({ 5: { passable: false } });
  const expected = force(terrain, [1.4, 1], { direction: [1 / Math.SQRT2, 1 / Math.SQRT2] });
  close(force(terrain, [1.4, 1], { direction: [3, 3] }), expected);
  close(force(terrain, [1.4, 1], { direction: [0.000001, 0] }), [-tickForce, 0]);
});

test('terrain avoidance scales by controller speed ratio with a 0.5 floor and no upper limit', () => {
  const terrain = map({ 5: { passable: false } });
  close(force(terrain, [1.4, 1], { velocity: [0, 0] }), [-tickForce / 2, 0]);
  close(force(terrain, [1.4, 1], { velocity: [0.02, 0] }), [-tickForce / 2, 0]);
  close(force(terrain, [1.4, 1], { velocity: [0, 0.1] }), [-tickForce, 0]);
  close(force(terrain, [1.4, 1], { velocity: [0.2, 0] }), [-tickForce * 2, 0]);
  close(force(terrain, [1.4, 1], { speed: 0 }), [0, 0]);
});

test('an impassable current cell selects the closest passable neighbor and preserves clockwise tie order', () => {
  const blocked = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [index, { passable: false }]));
  const terrain = map({ ...blocked, 5: { passable: true }, 7: { passable: true } });
  close(force(terrain, [1, 1]), [0, tickForce]);
  close(force(terrain, [1.2, 1]), [tickForce, 0]);
});

test('impassable-cell recovery accepts high-cost passable neighbors and retains diagonal magnitude', () => {
  const blocked = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [index, { passable: false }]));
  const terrain = map({ ...blocked, 8: { passable: true, cost: 1000 } });
  close(force(terrain, [1, 1]), [tickForce, tickForce]);
  close(force(map(blocked), [1, 1]), [0, 0]);
});

test('map exterior contributes no local avoidance and is handled by the movement recovery path', () => {
  const terrain = map();
  close(force(terrain, [-1, 0]), [0, 0]);
  close(force(terrain, [0.1, -0.4], { halfBodyWidth: 0.3 }), [0, 0]);
});

test('directional departures do not create local terrain obstacles', () => {
  const terrain = map({
    5: { departures: { UP: false, RIGHT: false, DOWN: false, LEFT: false } },
  });
  close(force(terrain, [1.4, 1]), [0, 0]);
});
