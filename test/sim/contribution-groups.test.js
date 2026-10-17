import assert from "node:assert/strict";
import { test } from "node:test";
import { initialize } from "../helpers/unit.js";
import {
    battlefieldView,
    transitionUnit,
} from "../../dist/core/tactical/battle/state.js";
import {
    setAttackContribution,
    removeAttackContribution,
} from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { setDefenseContribution, resolveDefense } from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { create } from "../../dist/core/tactical/unit/contribution/attribute.js";
import { effectFixtureWork } from "../helpers/effects.js";
const base = (id) =>
    initialize({
        id,
        position: [0, 0],
        definition: {
            id: `unit-${id}`,
            offense: { attack: 100 },
            vitality: { maxHp: 100, defense: 0, resistance: 0 },
        },
    });
const entry = (id, amount, priority) => ({
    id,
    value: [create({ finalAddition: amount })],
    group: { id: "inspiration", priority },
});
test("attribute selection keeps weaker candidates while independent attributes stack", () => {
    let unit = ({ ...base(1), offense: setAttackContribution(base(1).offense, entry("a", 300, 0.3)) });
    unit = ({ ...unit, offense: setAttackContribution(unit.offense, entry("b", 60, 0.6)) });
    unit = ({ ...unit, vitality: setDefenseContribution(unit.vitality, { id: "a", value: [create({ finalAddition: 10 })] }) });
    unit = ({ ...unit, vitality: setDefenseContribution(unit.vitality, { id: "b", value: [create({ finalAddition: 20 })] }) });
    let battle = effectFixtureWork(unit);
    const before = battlefieldView(battle);
    assert.equal(resolveAttackPower(1, before), 160);
    const current = before.getUnit(1);
    assert.equal(resolveDefense(current.vitality, current.definition.vitality, { unit: current, battlefield: before }).defense, 30);
    battle = transitionUnit(battle, 1, (current) => ({ ...current, offense: removeAttackContribution(current.offense, "b") }));
    assert.equal(resolveAttackPower(1, battlefieldView(battle)), 400);
    assert.equal(resolveAttackPower(1, before), 160);
});
test("dynamic values read current sources while selection changes explicitly", () => {
    const dynamic = (id, source, coefficient) => ({
        id,
        group: { id: "inspiration", priority: coefficient },
        value: ({ battlefield }) => [
            create({ finalAddition: resolveAttackPower(source, battlefield) * coefficient }),
        ],
    });
    let unit = ({ ...base(1), offense: setAttackContribution(base(1).offense, dynamic("a", 2, 0.3)) });
    unit = ({ ...unit, offense: setAttackContribution(unit.offense, dynamic("b", 3, 0.6)) });
    let battle = effectFixtureWork(unit, base(2), base(3));
    assert.equal(resolveAttackPower(1, battlefieldView(battle)), 160);
    battle = transitionUnit(battle, 3, (current) =>
        ({ ...current, offense: setAttackContribution(current.offense, { id: "source", value: [create({ finalAddition: 100 })] }) }),
    );
    assert.equal(resolveAttackPower(1, battlefieldView(battle)), 220);
    const before = battlefieldView(battle);
    battle = transitionUnit(battle, 1, (current) => ({ ...current, offense: setAttackContribution(current.offense, dynamic("a", 2, 0.7)) }));
    assert.equal(resolveAttackPower(1, battlefieldView(battle)), 170);
    assert.equal(resolveAttackPower(1, before), 220);
});
