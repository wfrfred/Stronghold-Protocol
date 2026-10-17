import assert from "node:assert/strict";
import { test } from "node:test";
import {
    initialize,
    resolveMaxHp,
    resolveDefense,
    setMaxHpContribution,
    removeMaxHpContribution,
    setDefenseContribution,
    setResistanceContribution,
} from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import { initializers } from "../../dist/core/tactical/unit/capability/catalog.js";
import { create } from "../../dist/core/tactical/unit/contribution/attribute.js";
import { battlefieldView, getUnit, transitionUnit } from "../../dist/core/tactical/battle/state.js";
import { fixtureBattle, initialize as initializeUnit } from "../helpers/unit.js";
import { effectFixtureWork } from "../helpers/effects.js";

test("Vitality starts full at its effective MaxHP and preserves fractional attributes", () => {
    const battle = fixtureBattle();
    for (const [maxHp, expected] of [[0, 1], [0.5, 1], [1, 1], [100.5, 100.5]]) {
        const definition = { maxHp, defense: 20.5, resistance: 10.25 };
        const result = initialize(battle, definition);
        assert.equal(result.state, battle);
        assert.equal(result.value.hp, expected);
        assert.equal(resolveMaxHp(result.value, definition), expected);
        assert.deepEqual(result.value.defense, []);
        assert.deepEqual(result.value.resistance, []);
    }
    assert.equal(Object.hasOwn(initializers, "defense"), false);
});

test("Vitality initialization rejects invalid base attributes at the shared construction boundary", () => {
    for (const field of ["maxHp", "defense", "resistance"]) {
        for (const invalid of [-1, NaN, Infinity, -Infinity, undefined]) {
            assert.throws(() => initializeUnit({
                id: 1,
                position: [0, 0],
                definition: {
                    id: "invalid-vitality",
                    vitality: { maxHp: 100, defense: 0, resistance: 0, [field]: invalid },
                },
            }), new RegExp(field));
        }
    }
});

test("MaxHP transitions preserve fractional HP ratios and the effective minimum", () => {
    const battle = fixtureBattle();
    const definition = { maxHp: 100.5, defense: 0, resistance: 0 };
    const initial = { ...initialize(battle, definition).value, hp: 25.125 };
    const increased = setMaxHpContribution(initial, definition, {
        id: "equipment", value: [create({ finalAddition: 100.5 })],
    });
    assert.equal(increased.hp, 50.25);
    assert.equal(resolveMaxHp(increased, definition), 201);
    const restored = removeMaxHpContribution(increased, definition, "equipment");
    assert.equal(restored.hp, 25.125);
    assert.equal(resolveMaxHp(restored, definition), 100.5);
    assert.equal(initial.hp, 25.125);
    assert.equal(increased.hp, 50.25);

    const floorDefinition = { maxHp: 0.5, defense: 0, resistance: 0 };
    const atFloor = { ...initialize(battle, floorDefinition).value, hp: 0.25 };
    const reduced = setMaxHpContribution(atFloor, floorDefinition, {
        id: "penalty", value: [create({ finalAddition: -10 })],
    });
    assert.equal(resolveMaxHp(reduced, floorDefinition), 1);
    assert.equal(reduced.hp, 0.25);
});

test("dynamic DEF and RES contributions use current Unit and battlefield facts without changing snapshots", () => {
    const target = initializeUnit({
        id: 1,
        position: [0, 0],
        definition: { id: "target", vitality: { maxHp: 100, defense: 20.5, resistance: 10.25 } },
    });
    const source = initializeUnit({
        id: 2,
        position: [1, 0],
        definition: { id: "source", vitality: { maxHp: 100, defense: 0, resistance: 0 } },
    });
    const modified = {
        ...target,
        vitality: setResistanceContribution(setDefenseContribution(target.vitality, {
            id: "conditional-defense",
            value: ({ unit }) => [create({ finalAddition: unit.vitality.hp < 50 ? -100 : 5.25 })],
        }), {
            id: "source-resistance",
            value: ({ battlefield }) => [create({ finalAddition: battlefield.getUnit(2).vitality.hp })],
        }),
    };
    const initial = effectFixtureWork(modified, source);
    const current = transitionUnit(transitionUnit(initial, 1, unit => ({
        ...unit, vitality: { ...unit.vitality, hp: 25 },
    })), 2, unit => ({ ...unit, vitality: { ...unit.vitality, hp: 20.5 } }));
    const resolve = battle => {
        const unit = getUnit(battle, 1);
        return resolveDefense(unit.vitality, unit.definition.vitality, { unit, battlefield: battlefieldView(battle) });
    };
    assert.deepEqual(resolve(initial), { defense: 25.75, resistance: 100 });
    assert.deepEqual(resolve(current), { defense: 0, resistance: 30.75 });
    assert.deepEqual(resolve(initial), { defense: 25.75, resistance: 100 });
    assert.equal(getUnit(current, 1).vitality.defense, modified.vitality.defense);
    assert.equal(target.vitality.defense.length, 0);
});
