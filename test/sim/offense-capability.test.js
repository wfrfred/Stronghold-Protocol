import assert from "node:assert/strict";
import { test } from "node:test";
import {
    initialize,
    setAttackContribution,
    removeAttackContribution,
} from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { resolveAttack } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { initialize as initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { registerUnit, removeUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import * as units from "../../dist/core/tactical/unit/query.js";
import * as attribute from "../../dist/core/tactical/unit/contribution/attribute.js";
import { fixtureBattle } from "../helpers/unit.js";

const createUnit = (battle, id, attack, capabilities = {}) => initializeUnit(battle, {
    id,
    position: [id, 0],
    definition: { id: `offense-${id}`, offense: { attack }, ...capabilities },
}).value;

test("Offense initialization validates its base attribute through both construction entrances", () => {
    const battle = fixtureBattle(7);

    for (const attack of [0, 0.25, 125.75]) {
        const initialized = initialize(battle, { attack });
        assert.strictEqual(initialized.state, battle);
        assert.deepEqual(initialized.value, { attack: [] });
        const unit = createUnit(battle, 0, attack);
        assert.equal(resolveAttack(registerUnit(battle, unit), units.ref(unit)), attack);
    }

    for (const attack of [-0.25, NaN, Infinity, -Infinity, "100", undefined]) {
        assert.throws(() => initialize(battle, { attack }), /attack must be a finite nonnegative number/);
        assert.throws(() => createUnit(battle, 0, attack), /attack must be a finite nonnegative number/);
    }
});

test("Offense contribution replacement and removal preserve prior states and no-op identity", () => {
    const battle = fixtureBattle();
    const initial = initialize(battle, { attack: 100 }).value;
    const first = { id: "bonus", value: [attribute.create({ addition: 20 })] };
    const replaced = { id: "bonus", value: [attribute.create({ multiplier: 0.5 })] };
    const added = setAttackContribution(initial, first);
    const updated = setAttackContribution(added, replaced);

    assert.deepEqual(initial.attack, []);
    assert.deepEqual(added.attack, [first]);
    assert.deepEqual(updated.attack, [replaced]);
    assert.strictEqual(setAttackContribution(updated, replaced), updated);
    assert.strictEqual(removeAttackContribution(updated, "absent"), updated);
    assert.deepEqual(removeAttackContribution(updated, "bonus"), initial);
    assert.notStrictEqual(removeAttackContribution(updated, "bonus"), updated);
});

test("Offense dynamic contributions receive the queried battle and its current typed owner", () => {
    let battle = fixtureBattle(2);
    const source = createUnit(battle, 0, 40);
    const sourceRef = units.ref(source);
    const original = createUnit(battle, 1, 10);
    const receiver = {
        ...original,
        offense: setAttackContribution(original.offense, {
            id: "dynamic",
            value: (current, self) => {
                assert.strictEqual(units.get(current, units.ref(self)), self);
                return [attribute.create({
                    finalAddition: resolveAttack(current, sourceRef) + self.position[0] + current.tick,
                })];
            },
        }),
    };
    battle = registerUnit(registerUnit(battle, source), receiver);
    const initial = battle;
    const reference = units.ref(receiver);
    assert.equal(resolveAttack(initial, reference), 53);

    battle = updateUnit(battle, {
        ...source,
        offense: setAttackContribution(source.offense, {
            id: "source-bonus",
            value: [attribute.create({ addition: 25 })],
        }),
    });
    battle = updateUnit({ ...battle, tick: 4 }, { ...receiver, position: [3, 0] });

    assert.equal(resolveAttack(battle, reference), 82);
    assert.equal(resolveAttack(initial, reference), 53);
    assert.equal(resolveAttack(initial, sourceRef), 40);
    assert.equal(resolveAttack(battle, sourceRef), 65);
});

test("Offense resolves exclusive contribution winners before evaluating dynamic values", () => {
    const initial = fixtureBattle();
    const original = createUnit(initial, 0, 100);
    let weakerEvaluations = 0;
    const weaker = {
        id: "a-weaker",
        group: { id: "inspiration", priority: 1 },
        value: () => {
            weakerEvaluations++;
            return [attribute.create({ finalAddition: 500 })];
        },
    };
    const stronger = {
        id: "z-stronger",
        group: { id: "inspiration", priority: 2 },
        value: (_battle, self) => [attribute.create({ finalAddition: self.definition.offense.attack / 2 })],
    };
    const unit = {
        ...original,
        offense: setAttackContribution(setAttackContribution(original.offense, weaker), stronger),
    };
    const battle = registerUnit(initial, unit);
    const reference = units.ref(unit);

    assert.equal(resolveAttack(battle, reference), 150);
    assert.equal(weakerEvaluations, 0);
    const current = updateUnit(battle, {
        ...unit,
        offense: removeAttackContribution(unit.offense, stronger.id),
    });
    assert.equal(resolveAttack(current, reference), 600);
    assert.equal(weakerEvaluations, 1);
    assert.equal(resolveAttack(battle, reference), 150);
    assert.equal(weakerEvaluations, 1);
});

test("Offense queries stop evaluating contributions after the referenced Unit is removed", () => {
    const initial = fixtureBattle();
    const original = createUnit(initial, 0, 100);
    let evaluations = 0;
    const unit = {
        ...original,
        offense: setAttackContribution(original.offense, {
            id: "observed",
            value: () => {
                evaluations++;
                return [];
            },
        }),
    };
    const battle = registerUnit(initial, unit);
    const reference = units.ref(unit);
    assert.equal(resolveAttack(battle, reference), 100);
    const removed = removeUnit(battle, unit.id, "SCRIPT");

    assert.equal(resolveAttack(removed, reference), undefined);
    assert.equal(evaluations, 1);
    assert.equal(resolveAttack(battle, reference), 100);
});

test("Offense attribute queries do not impose lifecycle, HP or spatial qualifications", () => {
    const initial = fixtureBattle();
    const original = createUnit(initial, 0, 75.5, {
        vitality: { maxHp: 100, defense: 0, resistance: 0 },
        spatialPresence: {},
    });
    const unit = {
        ...original,
        lifecycle: "LEAVING",
        vitality: { ...original.vitality, hp: 0 },
        spatialPresence: { ...original.spatialPresence, present: false },
    };
    const battle = registerUnit(initial, unit);

    assert.equal(resolveAttack(battle, units.ref(unit)), 75.5);
});

test("Offense retains fractional attribute values and applies only its nonnegative bound", () => {
    const initial = fixtureBattle();
    const original = createUnit(initial, 0, 100.25);
    const unit = {
        ...original,
        offense: setAttackContribution(original.offense, {
            id: "four-terms",
            value: [attribute.create({ addition: 0.25, multiplier: 0.5, finalAddition: 0.75, finalScaler: 1.2 })],
        }),
    };
    const battle = registerUnit(initial, unit);
    const reference = units.ref(unit);
    assert.ok(Math.abs(resolveAttack(battle, reference) - 181.8) < 1e-9);

    const clamped = updateUnit(battle, {
        ...unit,
        offense: setAttackContribution(unit.offense, {
            id: "four-terms",
            value: [attribute.create({ finalAddition: -101 })],
        }),
    });
    assert.equal(resolveAttack(clamped, reference), 0);
    assert.ok(Math.abs(resolveAttack(battle, reference) - 181.8) < 1e-9);
});
