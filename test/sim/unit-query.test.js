import assert from "node:assert/strict";
import { test } from "node:test";
import * as units from "../../dist/core/tactical/unit/query.js";
import { initialize } from "../helpers/unit.js";
import { hasLocomotion } from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import { hasVitality } from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import { createBattleState, registerUnit, removeUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { fixtureBattlefieldState } from "../helpers/battlefield.js";

const locomotion = {
    halfBodyWidth: 0, minSpeed: 0, speed: 1,
    steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
};
const unit = (id, capabilities = {}) => initialize({
    id, position: [id, 0], definition: { id: `query-${id}`, ...capabilities },
});
const battle = (...values) => createBattleState(fixtureBattlefieldState(values));

test("all yields Unit objects in registration order without capability or lifecycle filtering", () => {
    const initial = battle(
        unit(8, { locomotion }),
        unit(2, { vitality: { maxHp: 100, defense: 0, resistance: 0 }, onTick: state => state }),
        { ...unit(5), lifecycle: "LEAVING" },
    );
    const query = units.all(initial);
    const values = query.toArray();

    assert.deepEqual(values.map(value => value.id), [8, 2, 5]);
    assert.strictEqual(values[0], initial.battlefield.units.get(8));
    assert.strictEqual(values[1], initial.battlefield.units.get(2));
    assert.equal(values[2].lifecycle, "LEAVING");
    assert.deepEqual(query.map(units.ref).toArray(), [{ id: 8 }, { id: 2 }, { id: 5 }]);
    assert.deepEqual(units.all(battle()).toArray(), []);
});

test("Unit filters retain matching objects until identity extraction is explicitly requested", () => {
    const initial = battle(
        unit(8, { locomotion }),
        unit(2, { vitality: { maxHp: 100, defense: 0, resistance: 0 } }),
        unit(5, { locomotion, vitality: { maxHp: 100, defense: 0, resistance: 0 } }),
    );
    const moving = units.all(initial).filter(hasLocomotion);
    assert.deepEqual(moving.map(value => value.id).toArray(), [8, 5]);
    assert.strictEqual(moving.toArray()[0], initial.battlefield.units.get(8));
    const combined = moving.filter(hasVitality);
    assert.equal(combined.toArray()[0].vitality.hp, 100);
    assert.deepEqual(combined.map(units.ref).toArray(), [{ id: 5 }]);
    assert.deepEqual(units.all(initial).filter(value => value.id > 4).map(value => value.id).toArray(), [8, 5]);
    assert.deepEqual(units.all(initial).filter(() => false).toArray(), []);
});

test("Unit queries remain bound to their battle snapshot across repeated and interleaved enumeration", () => {
    const original = unit(3, { vitality: { maxHp: 100, defense: 0, resistance: 0 } });
    const second = unit(1);
    const initial = battle(original, second);
    const query = units.all(initial);
    const changed = { ...original, position: [7, 0], vitality: { ...original.vitality, hp: 40 } };
    let current = updateUnit(initial, changed);
    current = removeUnit(current, second.id, "SCRIPT");
    current = registerUnit(current, unit(5));

    const firstCursor = query[Symbol.iterator]();
    const secondCursor = query[Symbol.iterator]();
    assert.strictEqual(firstCursor.next().value, original);
    assert.strictEqual(secondCursor.next().value, original);
    assert.strictEqual(firstCursor.next().value, second);
    assert.strictEqual(secondCursor.next().value, second);
    assert.equal(firstCursor.next().done, true);
    assert.equal(secondCursor.next().done, true);
    assert.deepEqual(query.toArray(), [original, second]);
    assert.deepEqual(query.map(value => value.id).toArray(), [3, 1]);
    assert.strictEqual(units.all(current).toArray()[0], changed);
    assert.deepEqual(units.all(current).map(value => value.id).toArray(), [3, 5]);
});

test("Unit query preserves registration order through replacement and moves a re-registered identity to the end", () => {
    const first = unit(8);
    const second = unit(2);
    const third = unit(5);
    const initial = battle(first, second, third);
    const replaced = updateUnit(initial, { ...second, position: [9, 0] });
    const restored = registerUnit(removeUnit(replaced, first.id, "SCRIPT"), first);

    assert.deepEqual(units.all(replaced).map(value => value.id).toArray(), [8, 2, 5]);
    assert.deepEqual(units.all(restored).map(value => value.id).toArray(), [2, 5, 8]);
    assert.deepEqual(units.all(initial).map(value => value.id).toArray(), [8, 2, 5]);
});

test("a Unit Ref reads the supplied battle version without retaining the old snapshot", () => {
    const original = unit(3, { locomotion, vitality: { maxHp: 100, defense: 0, resistance: 0 } });
    const initial = battle(original);
    const reference = units.ref(original);
    const updated = { ...original, position: [4, 0], vitality: { ...original.vitality, hp: 60 } };
    const current = updateUnit(initial, updated);

    assert.deepEqual(Reflect.ownKeys(reference), ["id"]);
    assert.strictEqual(units.get(initial, reference), original);
    assert.strictEqual(units.get(current, reference), updated);
    assert.equal(units.get(current, reference).vitality.hp, 60);
    assert.equal(units.get(initial, reference).vitality.hp, 100);
    assert.equal(units.get(removeUnit(current, reference.id), reference), undefined);
});

test("fixed Unit candidates read preceding updates, skip removal and defer new identities", () => {
    const initial = battle(
        unit(0, { locomotion, vitality: { maxHp: 100, defense: 0, resistance: 0 } }),
        unit(1, { locomotion, vitality: { maxHp: 100, defense: 0, resistance: 0 } }),
        unit(2, { locomotion, vitality: { maxHp: 100, defense: 0, resistance: 0 } }),
    );
    const candidates = units.all(initial).filter(hasLocomotion).map(units.ref).toArray();
    const observed = [];
    let current = initial;

    for (const reference of candidates) {
        const value = units.get(current, reference);
        if (value === undefined) continue;
        observed.push([value.id, value.vitality.hp]);
        if (value.id === 0) {
            const second = units.get(current, candidates[1]);
            current = updateUnit(current, { ...second, vitality: { ...second.vitality, hp: 40 } });
            current = removeUnit(current, 2, "SCRIPT");
            current = registerUnit(current, unit(3, { locomotion, vitality: { maxHp: 100, defense: 0, resistance: 0 } }));
        }
    }

    assert.deepEqual(observed, [[0, 100], [1, 40]]);
    assert.deepEqual(candidates.map(reference => reference.id), [0, 1, 2]);
    assert.deepEqual(units.all(current).filter(hasLocomotion).map(value => value.id).toArray(), [0, 1, 3]);
    assert.equal(units.get(initial, candidates[1]).vitality.hp, 100);
    assert.equal(units.get(initial, candidates[2]).id, 2);
});
