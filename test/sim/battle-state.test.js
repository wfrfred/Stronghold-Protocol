import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureBattlefieldState } from "../helpers/battlefield.js";
import {
    appendEvents,
    battlefieldView,
    createBattleState,
    getUnit,
    registerUnit,
    removeUnit,
    updateUnit,
    updateUnits,
} from "../../dist/core/tactical/battle/state.js";

const unit = (id, position = [0, 0]) =>
    initialize({ id, definition: { id: `unit-${id}` }, position });
const fixture = (...units) => createBattleState(fixtureBattlefieldState(units));

test("battle state: each returned version exposes completed updates and retains prior facts", () => {
    const first = unit(1),
        second = unit(2);
    const initial = fixture(first, second);
    const published = battlefieldView(initial);
    const moved = { ...second, position: [3, 0] };
    const updated = updateUnit(initial, moved);
    const removed = removeUnit(updated, 1, "SCRIPT");
    assert.equal(getUnit(removed, 2), moved);
    assert.equal(getUnit(removed, 1), undefined);
    assert.deepEqual(battlefieldView(removed).unitIds, [2]);
    assert.equal(getUnit(updated, 1), first);
    assert.equal(published.getUnit(1), first);
    assert.equal(published.getUnit(2), second);
    assert.deepEqual(initial.removedUnits, []);
    assert.deepEqual(removed.removedUnits, [{ unitId: 1, reason: "SCRIPT", unit: first }]);
});

test("battle state: independent branches keep their own registrations and removals", () => {
    const first = unit(1),
        spawned = unit(8);
    const initial = fixture(first);
    const moved = { ...first, position: [1, 0] };
    const left = updateUnit(initial, moved);
    const right = removeUnit(registerUnit(initial, spawned), 1, "DEATH");
    assert.equal(getUnit(left, 1), moved);
    assert.equal(getUnit(left, 8), undefined);
    assert.deepEqual(battlefieldView(right).unitIds, [8]);
    assert.equal(getUnit(initial, 1), first);
    assert.deepEqual(initial.registeredUnitIds, []);
});

test("battle state: no-op updates retain identity and zero HP alone does not remove a unit", () => {
    const first = initialize({
        id: 1,
        position: [0, 0],
        definition: { id: "vitality", vitality: { maxHp: 100 } },
    });
    const initial = fixture(first);
    assert.equal(updateUnit(initial, first), initial);
    assert.equal(removeUnit(initial, 99), initial);
    assert.equal(appendEvents(initial, []), initial);
    const zeroHp = { ...first, vitality: { ...first.vitality, hp: 0 } };
    const advanced = updateUnit(initial, zeroHp);
    assert.equal(getUnit(advanced, 1), zeroHp);
    assert.deepEqual(advanced.removedUnits, []);
    assert.equal(getUnit(initial, 1).vitality.hp, 100);
});

test("battle state: facts, event prefixes and execution progress travel through explicit values", () => {
    const initial = fixture(unit(1));
    const first = { type: "ACTION", sourceUnitId: 1, targetUnitId: 2, tick: 3 };
    const second = { ...first, targetUnitId: 3 };
    const recorded = appendEvents(initial, [first]);
    const execution = { ...recorded.execution, rngState: 123, nextUnitId: 4 };
    const advanced = appendEvents({ ...recorded, execution }, [second]);
    assert.deepEqual(advanced.events, [first, second]);
    assert.equal(advanced.execution, execution);
    assert.deepEqual(initial.events, []);
    assert.deepEqual(recorded.events, [first]);
    assert.equal(initial.execution.rngState, 0);
});

test("battle state: explicit batch updates do not register missing units", () => {
    const first = unit(1),
        second = unit(2);
    const initial = fixture(first, second);
    const snapshot = battlefieldView(initial);
    const moved = { ...first, position: [3, 0] },
        spawned = unit(8);
    const changed = registerUnit(updateUnits(initial, [moved, second, spawned]), spawned);
    assert.equal(getUnit(changed, 1), moved);
    assert.equal(getUnit(changed, 8), spawned);
    assert.equal(snapshot.getUnit(1), first);
    assert.equal(snapshot.getUnit(8), undefined);
    assert.deepEqual(changed.registeredUnitIds, [8]);
});
