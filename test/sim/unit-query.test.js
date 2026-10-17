import assert from "node:assert/strict";
import { test } from "node:test";
import * as units from "../../dist/core/tactical/unit/query.js";
import { initialize } from "../helpers/unit.js";
import { hasLocomotion } from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import { hasVitality } from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import { createBattleState, registerUnit, removeUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { fixtureBattlefieldState } from "../helpers/battlefield.js";

const locomotion = {
    moveSpeedPerTick: 1,
    steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
};
const unit = (id, capabilities = {}) => initialize({
    id, position: [id, 0], definition: { id: `query-${id}`, ...capabilities },
});
const battle = (...values) => createBattleState(fixtureBattlefieldState(values));

test("all Unit identities preserve collection order regardless of capabilities or tick callbacks", () => {
    const initial = battle(
        unit(8, { locomotion }),
        unit(2, { vitality: { maxHp: 100, defense: 0, resistance: 0 }, onTick: state => state }),
        { ...unit(5), lifecycle: "LEAVING" },
    );
    const candidates = units.all(initial);

    assert.deepEqual(candidates, [{ id: 8 }, { id: 2 }, { id: 5 }]);
    assert.deepEqual(candidates.map(reference => Reflect.ownKeys(reference)), [["id"], ["id"], ["id"]]);
    assert.strictEqual(units.get(initial, candidates[0]), initial.battlefield.units.get(8));
    assert.equal(units.get(initial, candidates[2]).lifecycle, "LEAVING");
    assert.deepEqual(units.all(battle()), []);
});

test("Unit filtering returns identities for matching capabilities in collection order", () => {
    const initial = battle(
        unit(8, { locomotion }),
        unit(2, { vitality: { maxHp: 100, defense: 0, resistance: 0 } }),
        unit(5, { locomotion, vitality: { maxHp: 100, defense: 0, resistance: 0 } }),
    );
    assert.deepEqual(units.filter(initial, hasLocomotion), [{ id: 8 }, { id: 5 }]);
    const combined = units.filter(initial, value => hasLocomotion(value) && hasVitality(value));
    assert.deepEqual(combined, [{ id: 5 }]);
    assert.equal(units.get(initial, combined[0]).vitality.hp, 100);
    assert.deepEqual(units.filter(initial, () => false), []);
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
    const candidates = units.filter(initial, hasLocomotion);
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
    assert.deepEqual(units.filter(current, hasLocomotion).map(reference => reference.id), [0, 1, 3]);
    assert.equal(units.get(initial, candidates[1]).vitality.hp, 100);
    assert.equal(units.get(initial, candidates[2]).id, 2);
});
