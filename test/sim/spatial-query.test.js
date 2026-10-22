import { test } from "node:test";
import assert from "node:assert/strict";
import { within, overlap, sweep } from "../../dist/core/tactical/battlefield/spatial/query.js";
import { fromTiles } from "../../dist/core/tactical/geometry/range.js";
import { updateUnit } from "../../dist/core/tactical/battle/state.js";
import * as units from "../../dist/core/tactical/unit/query.js";
import { initialize } from "../helpers/unit.js";
import { battle } from "../helpers/action-fixture.js";

const circle = (radius, offset = [0, 0]) => ({ type: "CIRCLE", offset, radius });
const box = (width, height, offset = [0, 0]) => ({
    type: "BOX", offset, halfExtents: [width, height],
});
const ids = (refs) => refs.map((ref) => ref.id);
const contactIds = (contacts) => ids(contacts.map((contact) => contact.target));

function target(id, position, configuration = {}) {
    return initialize({
        id, position,
        definition: {
            id: `spatial-${id}`,
            hitbox: { shape: circle(0.1) },
            ...configuration,
        },
    });
}

test("within uses unit positions without requiring hitboxes while overlap uses offset hitboxes", () => {
    const offsetOutside = target(7, [0, 0], { hitbox: { shape: circle(0.1, [3, 0]) } });
    const offsetInside = target(2, [3, 0], { hitbox: { shape: circle(0.1, [-3, 0]) } });
    const withoutHitbox = initialize({
        id: 9, position: [0.5, 0], definition: { id: "without-hitbox" },
    });
    const state = battle(offsetOutside, offsetInside, withoutHitbox);
    const range = [box(1, 1)];

    assert.deepEqual(ids(within(state, range, [0, 0])), [7, 9]);
    assert.deepEqual(ids(overlap(state, range, [0, 0])), [2]);
});

test("overlap uses rotated tile boxes and intersects hitboxes rather than target centers", () => {
    const center = target(5, [0, 0]);
    const right = target(3, [1, 0]);
    const upperEdge = target(8, [0, 1.55]);
    const state = battle(center, right, upperEdge);

    assert.deepEqual(ids(overlap(state, fromTiles([[0, 1]], "RIGHT"), [0, 0])), [3]);
    assert.deepEqual(ids(overlap(state, fromTiles([[0, 1]], "UP"), [0, 0])), [8]);
    assert.deepEqual(within(state, fromTiles([[0, 1]], "UP"), [0, 0]), []);
});

test("range queries emit each unit once in unit enumeration order across multiple shapes", () => {
    const multiple = target(7, [0, 0], { hitbox: { shape: circle(1) } });
    const other = target(2, [1, 0]);
    const state = battle(multiple, other);
    const range = [circle(2), box(2, 2), circle(2)];

    assert.deepEqual(ids(within(state, range, [0, 0])), [7, 2]);
    assert.deepEqual(ids(overlap(state, range, [0, 0])), [7, 2]);
    assert.equal(units.get(state, overlap(state, range, [0, 0])[0]), multiple);
});

test("all spatial queries require PRESENT lifecycle and spatial presence", () => {
    const absent = {
        ...target(2, [0, 0], { spatialPresence: {} }),
        spatialPresence: { present: false },
    };
    const leaving = { ...target(3, [0, 0]), lifecycle: "LEAVING" };
    const withoutHitbox = initialize({ id: 4, position: [0, 0], definition: { id: "bare" } });
    const implicitPresence = target(1, [0, 0]);
    const explicitPresence = target(5, [0, 0], { spatialPresence: {} });
    const state = battle(withoutHitbox, absent, leaving, implicitPresence, explicitPresence);
    const range = [circle(1)];

    assert.equal("spatialPresence" in implicitPresence, false);
    assert.deepEqual(ids(within(state, range, [0, 0])), [4, 1, 5]);
    assert.deepEqual(ids(overlap(state, range, [0, 0])), [1, 5]);
    assert.deepEqual(contactIds(sweep(state, circle(0.1), [-1, 0], [1, 0])), [1, 5]);
});

test("spatial queries do not impose Targetable, HP, or faction eligibility", () => {
    const bare = target(1, [0, 0]);
    const initialized = target(2, [1, 0], {
        vitality: { maxHp: 100, defense: 0, resistance: 0 },
        targetable: { restrictions: [] },
        allegiance: { side: "ALLY" },
    });
    const zeroHp = { ...initialized, vitality: { ...initialized.vitality, hp: 0 } };
    const enemy = target(3, [2, 0], { allegiance: { side: "ENEMY" } });
    const state = battle(bare, zeroHp, enemy);

    assert.equal("targetable" in bare, false);
    assert.deepEqual(ids(within(state, [circle(4)], [0, 0])), [1, 2, 3]);
    assert.deepEqual(ids(overlap(state, [circle(4)], [0, 0])), [1, 2, 3]);
    assert.deepEqual(contactIds(sweep(state, circle(0.1), [-1, 0], [3, 0])), [1, 2, 3]);
});

test("query origins and swept shapes need no source unit and may lie outside the map", () => {
    const outside = target(1, [-4, 0]);
    const state = battle(outside);

    assert.deepEqual(ids(within(state, [circle(0.5)], [-4, 0])), [1]);
    assert.deepEqual(ids(overlap(state, [circle(0.5)], [-4, 0])), [1]);
    assert.deepEqual(contactIds(sweep(state, box(0.2, 0.2), [-6, 0], [-2, 0])), [1]);
});

test("sweep returns first contact fractions ordered by distance then unit ID", () => {
    const far = target(9, [8, 0], { hitbox: { shape: circle(0.5) } });
    const nearHighId = target(7, [3, 0], { hitbox: { shape: circle(0.5) } });
    const nearLowId = target(2, [3, 0], { hitbox: { shape: circle(0.5) } });
    const state = battle(far, nearHighId, nearLowId);
    const contacts = sweep(state, circle(0.5), [0, 0], [10, 0]);

    assert.deepEqual(contactIds(contacts), [2, 7, 9]);
    assert.deepEqual(contacts.map((contact) => contact.fraction), [0.2, 0.2, 0.7]);
    assert.equal(units.get(state, contacts[0].target), nearLowId);
});

test("sweep intersects the continuous path and includes tangency", () => {
    const middle = target(9, [5, 0]);
    const tangent = target(1, [7, 0.6]);
    const missed = target(2, [3, 0.7]);
    const state = battle(middle, tangent, missed);
    const contacts = sweep(state, circle(0.5), [0, 0], [10, 0]);

    assert.deepEqual(contactIds(contacts), [9, 1]);
    assert.ok(Math.abs(contacts[0].fraction - 0.44) < 1e-12);
    assert.equal(contacts[1].fraction, 0.7);
});

test("sweep retains fraction zero and includes contact at the destination", () => {
    const initial = target(8, [0, 0], { hitbox: { shape: circle(0.5) } });
    const endpoint = target(1, [11, 0], { hitbox: { shape: circle(0.5) } });
    const state = battle(endpoint, initial);
    const contacts = sweep(state, circle(0.5), [0, 0], [10, 0]);

    assert.deepEqual(contactIds(contacts), [8, 1]);
    assert.deepEqual(contacts.map((contact) => contact.fraction), [0, 1]);
});

test("sweep handles equal coordinate values as zero movement and returns static contacts", () => {
    const self = target(1, [1, 0], { hitbox: { shape: circle(0.5) } });
    const state = battle(self);
    const projectile = box(0.5, 0.5);

    assert.deepEqual(contactIds(sweep(state, projectile, [-1, 0], [3, 0])), [1]);
    const contacts = sweep(state, projectile, [0, 0], [0, 0]);
    assert.deepEqual(contactIds(contacts), [1]);
    assert.equal(contacts[0].fraction, 0);
    assert.deepEqual(sweep(state, projectile, [-1, 0], [-1, 0]), []);
});

test("spatial results belong to the input snapshot while refs locate the latest unit", () => {
    const self = target(1, [0, 0]);
    const before = battle(self);
    const range = [circle(1)];
    const positions = within(before, range, [0, 0]);
    const overlapping = overlap(before, range, [0, 0]);
    const contacts = sweep(before, circle(0.1), [-1, 0], [1, 0]);
    const after = updateUnit(before, { ...self, position: [10, 0] });

    assert.deepEqual(ids(positions), [1]);
    assert.deepEqual(ids(overlapping), [1]);
    assert.deepEqual(contactIds(contacts), [1]);
    assert.deepEqual(ids(within(before, range, [0, 0])), [1]);
    assert.deepEqual(ids(overlap(before, range, [0, 0])), [1]);
    assert.deepEqual(contactIds(sweep(before, circle(0.1), [-1, 0], [1, 0])), [1]);
    assert.deepEqual(within(after, range, [0, 0]), []);
    assert.deepEqual(overlap(after, range, [0, 0]), []);
    assert.deepEqual(sweep(after, circle(0.1), [-1, 0], [1, 0]), []);
    assert.deepEqual(units.get(before, contacts[0].target).position, [0, 0]);
    assert.deepEqual(units.get(after, contacts[0].target).position, [10, 0]);
});

test("disconnected continuous range boxes preserve their gap", () => {
    const upper = target(1, [0, 1.05]);
    const lower = target(2, [0, -1.05]);
    const between = target(3, [0, 0]);
    const state = battle(upper, lower, between);
    const tips = [box(0.15, 0.15, [0, 1.05]), box(0.15, 0.15, [0, -1.05])];

    assert.deepEqual(ids(within(state, tips, [0, 0])), [1, 2]);
    assert.deepEqual(ids(overlap(state, tips, [0, 0])), [1, 2]);
});

test("empty ranges match no units", () => {
    const state = battle(target(1, [0, 0]));

    assert.deepEqual(within(state, [], [0, 0]), []);
    assert.deepEqual(overlap(state, [], [0, 0]), []);
});
