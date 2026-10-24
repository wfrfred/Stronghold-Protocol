import assert from "node:assert/strict";
import { test } from "node:test";
import * as field from "../../dist/core/tactical/battlefield/state.js";
import { view } from "../../dist/core/tactical/battlefield/view.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import { initialize } from "../helpers/unit.js";

const map = createBattlefieldMap(2, 3, Array.from({ length: 6 }, () => createTile({
    heightType: "LOWLAND", meleeBlockable: true, buildableType: "ALL", passableMask: "ALL",
    playerSideMask: "ALL", terrain: "NORMAL", mechanism: null,
})));

function unit(id, position, definition = {}, states = {}) {
    return initialize({ id, position, definition: { id: `tile-query-${id}`, ...definition }, states });
}

function fixture(...units) {
    return units.reduce((current, unit) => field.addUnit(current, unit), field.create({ map }));
}

test("tile queries preserve registration order and return the current Unit objects", () => {
    const first = unit(9, [1.1, 0]);
    const second = unit(2, [1, 0]);
    const initial = fixture(first, second);
    const changed = { ...first, position: [1.2, 0] };
    const next = field.replaceUnit(initial, changed);
    assert.deepEqual(view(next).unitsAt([0, 1]), [changed, second]);
    assert.equal(view(next).unitsAt([0, 1])[0], changed);
    assert.equal(view(initial).unitsAt([0, 1])[0], first);
});

test("a retained view queries its own version after movement, disappearance and removal", () => {
    const original = unit(1, [0, 0], { spatialPresence: {} });
    const initial = fixture(original);
    const captured = view(initial);
    const moved = field.replaceUnit(initial, { ...original, position: [1, 0] });
    const movedView = view(moved);
    const hidden = field.replaceUnit(moved, {
        ...moved.units.get(1), spatialPresence: { present: false },
    });
    const removed = field.removeUnit(hidden, { id: 1 });
    assert.deepEqual(captured.unitsAt([0, 0]), [original]);
    assert.deepEqual(captured.unitsAt([0, 1]), []);
    assert.deepEqual(movedView.unitsAt([0, 1]).map(unit => unit.id), [1]);
    assert.deepEqual(view(hidden).unitsAt([0, 1]), []);
    assert.deepEqual(view(removed).unitsAt([0, 1]), []);
    assert.deepEqual(captured.unitsAt([0, 0]), [original]);
});

test("tile membership follows body position and spatial presence, independently of occupancy", () => {
    const implicitPresence = unit(1, [1, 0]);
    const explicitPresence = unit(2, [1, 0], { spatialPresence: {} });
    const hidden = unit(3, [1, 0], { spatialPresence: {} }, { spatialPresence: { present: false } });
    const registeredElsewhere = unit(4, [1, 0], { occupancy: {} }, {
        occupancy: { registration: { tile: [0, 0], slot: "OCCUPANT" } },
    });
    const initial = fixture(implicitPresence, explicitPresence, hidden, registeredElsewhere);
    assert.deepEqual(view(initial).unitsAt([0, 1]).map(unit => unit.id), [1, 2, 4]);
    assert.deepEqual(view(initial).unitsAt([0, 0]), []);
    assert.equal(initial.occupancy.get(0).occupant.id, 4);
});

test("tile queries retain ties-to-even coordinates and reject out-of-bounds aliases", () => {
    const initial = fixture(
        unit(1, [0.5, 0]), unit(2, [1.5, 0]), unit(3, [0, 1]), unit(4, [-1, 0]),
    );
    const current = view(initial);
    assert.deepEqual(current.unitsAt([0, 0]).map(unit => unit.id), [1]);
    assert.deepEqual(current.unitsAt([0, 2]).map(unit => unit.id), [2]);
    assert.deepEqual(current.unitsAt([1, 0]).map(unit => unit.id), [3]);
    assert.deepEqual(current.unitsAt([0, 3]), []);
    assert.deepEqual(current.unitsAt([1, -3]), []);
    assert.deepEqual(current.unitsAt([-1, 0]), []);
});
