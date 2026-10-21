import { test } from "node:test";
import assert from "node:assert/strict";
import { overlap, overlaps, sweep } from "../../dist/core/tactical/battlefield/spatial/query.js";
import { updateUnit } from "../../dist/core/tactical/battle/state.js";
import * as units from "../../dist/core/tactical/unit/query.js";
import { initialize } from "../helpers/unit.js";
import { battle } from "../helpers/action-fixture.js";

const circle = (radius, offset = [0, 0]) => ({ type: "CIRCLE", offset, radius });
const box = (width, height, offset = [0, 0]) => ({
    type: "BOX", offset, halfExtents: [width, height],
});
const geometry = (...shapes) => ({ shapes });
const range = (...shapes) => ({ type: "SHAPES", geometry: geometry(...shapes) });
const ids = (refs) => refs.map((ref) => ref.id);

function target(id, position, configuration = {}) {
    return initialize({
        id, position,
        definition: {
            id: `spatial-${id}`,
            hitbox: { geometry: geometry(circle(0.1)) },
            ...configuration,
        },
    });
}

test("overlap rotates GRID offsets and intersects hitboxes rather than target centers", () => {
    const center = target(5, [0, 0]);
    const right = target(3, [1, 0]);
    const upperEdge = target(8, [0, 1.55]);
    const state = battle(center, right, upperEdge);

    assert.deepEqual(ids(overlap(state, {
        type: "GRID", offsets: [[0, 1]], direction: "RIGHT",
    }, [0, 0])), [3]);
    assert.deepEqual(ids(overlap(state, {
        type: "GRID", offsets: [[0, 1]], direction: "UP",
    }, [0, 0])), [8]);
});

test("overlap emits each unit once in storage order across multiple range and hitbox shapes", () => {
    const multiple = target(7, [0, 0], {
        hitbox: { geometry: geometry(circle(1), box(1, 1)) },
    });
    const other = target(2, [1, 0]);
    const state = battle(multiple, other);
    const query = range(circle(2), box(2, 2));

    assert.deepEqual(ids(overlap(state, query, [0, 0])), [7, 2]);
    assert.equal(units.get(state, overlap(state, query, [0, 0])[0]), multiple);
});

test("geometry queries exclude missing hitboxes and absent spatial presence", () => {
    const absent = {
        ...target(2, [0, 0], { spatialPresence: {} }),
        spatialPresence: { present: false },
    };
    const withoutHitbox = initialize({ id: 3, position: [0, 0], definition: { id: "bare" } });
    const present = target(1, [0, 0]);
    const state = battle(withoutHitbox, absent, present);

    assert.equal(overlaps(range(circle(1)), [0, 0], absent), true);
    assert.deepEqual(ids(overlap(state, range(circle(1)), [0, 0])), [1]);
    assert.deepEqual(ids(sweep(state, geometry(circle(0.1)), [-1, 0], [1, 0])), [1]);
});

test("spatial queries do not impose Targetable, HP, faction, or lifecycle eligibility", () => {
    const bare = target(1, [0, 0]);
    const initialized = target(2, [1, 0], {
        vitality: { maxHp: 100, defense: 0, resistance: 0 },
        targetable: { restrictions: [] },
        allegiance: { side: "ALLY" },
    });
    const zeroHp = { ...initialized, vitality: { ...initialized.vitality, hp: 0 } };
    const leaving = { ...target(3, [2, 0]), lifecycle: "LEAVING" };
    const state = battle(bare, zeroHp, leaving);

    assert.equal("targetable" in bare, false);
    assert.deepEqual(ids(overlap(state, range(circle(4)), [0, 0])), [1, 2, 3]);
    assert.deepEqual(ids(sweep(state, geometry(circle(0.1)), [-1, 0], [3, 0])), [1, 2, 3]);
});

test("projectile geometry and origins outside the map need no source unit", () => {
    const outside = target(1, [-4, 0]);
    const state = battle(outside);

    assert.deepEqual(ids(overlap(state, range(circle(0.5)), [-4, 0])), [1]);
    assert.deepEqual(ids(sweep(state, geometry(box(0.2, 0.2)), [-6, 0], [-2, 0])), [1]);
});

test("sweep intersects the continuous path, includes tangency, and preserves storage order", () => {
    const middle = target(9, [5, 0]);
    const tangent = target(1, [7, 0.6]);
    const missed = target(2, [3, 0.7]);
    const state = battle(middle, tangent, missed);

    assert.deepEqual(ids(sweep(state, geometry(circle(0.5)), [0, 0], [10, 0])), [9, 1]);
});

test("sweep deduplicates compound geometries and handles zero movement as overlap", () => {
    const self = target(1, [1, 0], {
        hitbox: { geometry: geometry(circle(0.5), box(0.5, 0.5)) },
    });
    const state = battle(self);
    const projectile = geometry(circle(0.5), box(0.5, 0.5));

    assert.deepEqual(ids(sweep(state, projectile, [-1, 0], [3, 0])), [1]);
    assert.deepEqual(ids(sweep(state, projectile, [0, 0], [0, 0])), [1]);
    assert.deepEqual(ids(sweep(state, projectile, [-1, 0], [-1, 0])), []);
});

test("spatial queries read current positions while preserving previous battle snapshots", () => {
    const self = target(1, [0, 0]);
    const before = battle(self);
    const reference = overlap(before, range(circle(1)), [0, 0])[0];
    const after = updateUnit(before, { ...self, position: [10, 0] });

    assert.deepEqual(ids(overlap(before, range(circle(1)), [0, 0])), [1]);
    assert.deepEqual(overlap(after, range(circle(1)), [0, 0]), []);
    assert.deepEqual(ids(sweep(before, geometry(circle(0.1)), [-1, 0], [1, 0])), [1]);
    assert.deepEqual(sweep(after, geometry(circle(0.1)), [-1, 0], [1, 0]), []);
    assert.deepEqual(units.get(before, reference).position, [0, 0]);
    assert.deepEqual(units.get(after, reference).position, [10, 0]);
});
