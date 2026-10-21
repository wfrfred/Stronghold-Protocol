import { test } from "node:test";
import assert from "node:assert/strict";
import * as coordinates from "../../dist/core/tactical/geometry/coordinate.js";

const {
    Tile,
    World,
    createTilePosition,
    createWorldPosition,
    isTilePosition,
    isWorldPosition,
} = coordinates;

test("coordinate exports expose only the unified position and vector API", () => {
    assert.deepEqual(Object.keys(coordinates).sort(), [
        "Tile",
        "World",
        "createTilePosition",
        "createWorldPosition",
        "isTilePosition",
        "isWorldPosition",
    ]);
    assert.deepEqual(Object.keys(Tile).sort(), ["add", "center", "rotate", "sub"]);
    assert.deepEqual(Object.keys(World).sort(), [
        "add",
        "clampLength",
        "distanceSquared",
        "length",
        "negate",
        "scale",
        "sub",
        "toTile",
    ]);
});

test("coordinate guards distinguish integer tiles from continuous world positions", () => {
    assert.equal(isTilePosition([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]), true);
    assert.equal(isWorldPosition([0.25, -1.5]), true);
    assert.equal(isTilePosition([0.25, -1.5]), false);
    assert.equal(isWorldPosition([Number.MAX_VALUE, -Number.MAX_VALUE]), true);

    for (const value of [null, {}, "1,2", [], [1], [1, 2, 3], [, 2], [1, ,], [NaN, 0], [0, Infinity], ["1", 2]]) {
        assert.equal(isTilePosition(value), false);
        assert.equal(isWorldPosition(value), false);
    }
    assert.equal(isTilePosition([Number.MAX_SAFE_INTEGER + 1, 0]), false);
});

test("constructors preserve signed zero and allocate ordinary independent arrays", () => {
    const tile = createTilePosition(-0, 1);
    const world = createWorldPosition(2.5, -0);

    assert.deepEqual(tile, [-0, 1]);
    assert.deepEqual(world, [2.5, -0]);
    assert.equal(Object.isFrozen(tile), false);
    assert.equal(Object.isFrozen(world), false);
    assert.notEqual(createTilePosition(-0, 1), tile);
    assert.notEqual(createWorldPosition(2.5, -0), world);
});

test("constructors reject coordinates outside their numeric domains", () => {
    for (const value of [NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", undefined]) {
        assert.throws(() => createTilePosition(value, 0), RangeError);
        assert.throws(() => createTilePosition(0, value), RangeError);
    }
    for (const value of [NaN, Infinity, -Infinity, "1", undefined]) {
        assert.throws(() => createWorldPosition(value, 0), RangeError);
        assert.throws(() => createWorldPosition(0, value), RangeError);
    }
});

test("tile arithmetic preserves inputs, row-column order, and four-direction rotation", () => {
    const a = Object.freeze([2, 3]);
    const b = Object.freeze([-1, 4]);

    assert.deepEqual(Tile.add(a, b), [1, 7]);
    assert.deepEqual(Tile.sub(a, b), [3, -1]);
    assert.deepEqual(Tile.center(a), [3, 2]);
    for (const [direction, expected] of [
        ["RIGHT", [2, 3]],
        ["UP", [3, -2]],
        ["LEFT", [-2, -3]],
        ["DOWN", [-3, 2]],
    ]) {
        const rotated = Tile.rotate(a, direction);
        assert.deepEqual(rotated, expected);
        assert.notEqual(rotated, a);
    }
    assert.notEqual(Tile.add(a, [0, 0]), a);
    assert.notEqual(Tile.sub(a, [0, 0]), a);
    assert.deepEqual(a, [2, 3]);
    assert.deepEqual(b, [-1, 4]);
});

test("world vector arithmetic returns fresh coordinates without modifying operands", () => {
    const a = Object.freeze([1.5, -2]);
    const b = Object.freeze([2.5, 4]);

    assert.deepEqual(World.add(a, b), [4, 2]);
    assert.deepEqual(World.sub(a, b), [-1, -6]);
    assert.deepEqual(World.negate(a), [-1.5, 2]);
    assert.deepEqual(World.scale(a, -2), [-3, 4]);
    assert.deepEqual(World.negate([0, -0]), [-0, 0]);
    assert.notEqual(World.add(a, [0, 0]), a);
    assert.notEqual(World.sub(a, [0, 0]), a);
    assert.notEqual(World.negate(a), a);
    assert.notEqual(World.scale(a, 1), a);
    assert.deepEqual(a, [1.5, -2]);
    assert.deepEqual(b, [2.5, 4]);
});

test("length and squared distance retain Euclidean semantics", () => {
    assert.equal(World.length([3, 4]), 5);
    assert.equal(World.length([0, 0]), 0);
    assert.equal(World.length([1e200, 1e200]), Math.hypot(1e200, 1e200));
    assert.equal(World.distanceSquared([1, 2], [4, 6]), 25);
    assert.equal(World.distanceSquared([-2, 3], [-2, 3]), 0);
});

test("clampLength limits magnitude while retaining direction and unchanged short vectors", () => {
    const vector = Object.freeze([6, 8]);
    const limited = World.clampLength(vector, 5);

    assert.deepEqual(limited, [3, 4]);
    assert.equal(World.length(limited), 5);
    assert.deepEqual(vector, [6, 8]);
    assert.deepEqual(World.clampLength(vector, 10), vector);
    assert.deepEqual(World.clampLength(vector, 20), vector);
    assert.deepEqual(World.clampLength(vector, 0), [0, 0]);
    assert.deepEqual(World.clampLength([0, 0], 0), [0, 0]);
    assert.deepEqual(World.clampLength([0, 0], 5), [0, 0]);
});

test("clampLength rejects invalid limits even for a zero vector", () => {
    for (const maximum of [-1, NaN, Infinity, -Infinity]) {
        assert.throws(() => World.clampLength([3, 4], maximum), RangeError);
        assert.throws(() => World.clampLength([0, 0], maximum), RangeError);
    }
});

test("operations reject unsafe integer and nonfinite results", () => {
    assert.throws(() => Tile.add([Number.MAX_SAFE_INTEGER, 0], [1, 0]), RangeError);
    assert.throws(() => Tile.sub([Number.MIN_SAFE_INTEGER, 0], [1, 0]), RangeError);
    assert.throws(() => World.add([Number.MAX_VALUE, 0], [Number.MAX_VALUE, 0]), RangeError);
    assert.throws(() => World.sub([-Number.MAX_VALUE, 0], [Number.MAX_VALUE, 0]), RangeError);
    assert.throws(() => World.scale([Number.MAX_VALUE, 0], 2), RangeError);
    assert.throws(() => World.scale([1, 0], NaN), RangeError);
    assert.throws(() => World.length([Number.MAX_VALUE, Number.MAX_VALUE]), RangeError);
    assert.throws(() => World.distanceSquared([1e200, 0], [0, 0]), RangeError);
    assert.throws(() => World.toTile([Number.MAX_SAFE_INTEGER + 1, 0]), RangeError);
});

test("world-to-tile conversion keeps ties-to-even rounding and swapped axes", () => {
    assert.deepEqual(World.toTile([0.5, 1.5]), [2, 0]);
    assert.deepEqual(World.toTile([2.5, 3.5]), [4, 2]);
    assert.deepEqual(World.toTile([-0.5, -1.5]), [-2, 0]);
    assert.deepEqual(World.toTile([-2.5, -3.5]), [-4, -2]);
    assert.deepEqual(World.toTile([0.49, 0.51]), [1, 0]);
    assert.deepEqual(World.toTile([-0.49, -0.51]), [-1, 0]);
    assert.deepEqual(World.toTile([-0, -0]), [-0, -0]);
    assert.deepEqual(Tile.center([-0, 2]), [2, -0]);
});
