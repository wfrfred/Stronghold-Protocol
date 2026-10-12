import { setData } from "../../dist/core/tactical/unit/effect/effect.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import {
    getUnit,
    battlefieldView,
    transitionUnit,
} from "../../dist/core/tactical/battle/state.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import {
    setMaxHpContribution,
    removeMaxHpContribution,
} from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import { resolveMaxHp } from "../../dist/core/tactical/unit/capability/vitality/query.js";
import { create } from "../../dist/core/tactical/unit/contribution/value.js";
import { effectFixtureWork, install, maxHpBuff, at } from "../helpers/effects.js";
const bonus = (amount) => create({ finalAddition: amount });
const receiver = (hp = 50) => {
    const unit = initializeUnit({
        id: 1,
        position: [0, 0],
        definition: { id: "host", vitality: { maxHp: 100 } },
    });
    return { ...unit, vitality: { ...unit.vitality, hp } };
};
const pair = (battle) => [getUnit(battle, 1).vitality.hp, resolveMaxHp(1, battlefieldView(battle))];
test("MaxHP: direct capability changes coordinate HP independently of Effects", () => {
    const initial = receiver();
    const installed = setMaxHpContribution(initial, { id: "equipment", value: [bonus(100)] });
    assert.deepEqual(pair(effectFixtureWork(installed)), [100, 200]);
    const replaced = setMaxHpContribution(installed, { id: "equipment", value: [bonus(200)] });
    assert.deepEqual(pair(effectFixtureWork(replaced)), [150, 300]);
    assert.equal(replaced.vitality.maxHp.length, 1);
    const removed = removeMaxHpContribution(replaced, "equipment");
    assert.deepEqual(pair(effectFixtureWork(removed)), [50, 100]);
    assert.equal(removeMaxHpContribution(removed, "missing"), removed);
    assert.deepEqual(pair(effectFixtureWork(initial)), [50, 100]);
    const dead = setMaxHpContribution(receiver(0), { id: "equipment", value: [bonus(100)] });
    assert.deepEqual(pair(effectFixtureWork(dead)), [0, 200]);
});

test("MaxHP outputs coordinate each setter before its lifecycle callback", () => {
    const observed = [];
    let battle = effectFixtureWork(receiver());
    const content = maxHpBuff("hp", 100, {
        onEnable: (state, ctx) => { observed.push(["enabled", getUnit(state, ctx.ref.unitId).vitality.hp]); return state; },
        onDisable: (state, ctx) => { observed.push(["disabled", getUnit(state, ctx.ref.unitId).vitality.hp]); return state; },
        onEnd: (state, ctx) => { observed.push(["ended", getUnit(state, ctx.ref.unitId).vitality.hp]); return state; },
    });
    const before = battlefieldView(battle);
    const installed = install(battle, content);
    battle = installed.state;
    const ref = installed.value;
    assert.deepEqual(pair(battle), [100, 200]);
    battle = effects.setEnabled(battle, ref, false);
    assert.deepEqual(pair(battle), [50, 100]);
    const current = getUnit(battle, ref.unitId).effects.values().find(effect => effect.id === ref.effectId);
    battle = effects.replaceEffect(battle, ref, setData(current, { amount: 200 }));
    battle = effects.setEnabled(battle, ref, true);
    assert.deepEqual(pair(battle), [150, 300]);
    battle = effects.end(battle, ref);
    assert.deepEqual(pair(battle), [50, 100]);
    assert.deepEqual(observed, [
        ["enabled", 100],
        ["disabled", 50],
        ["enabled", 150],
        ["disabled", 50],
        ["ended", 50],
    ]);
    assert.equal(before.getUnit(1).vitality.hp, 50);
});
test("MaxHP competing effects remove old outputs before installing new and restore the retained candidate", () => {
    let battle = effectFixtureWork(receiver());
    const first = install(battle, maxHpBuff("weak", 100, {
        group: { id: "hp", priority: 1 },
    }), 1);
    battle = first.state;
    const second = install(battle, maxHpBuff("strong", 200, {
        group: { id: "hp", priority: 2 },
    }), 1);
    battle = second.state;
    assert.deepEqual(pair(battle), [150, 300]);
    battle = effects.end(battle, second.value);
    assert.deepEqual(pair(battle), [100, 200]);
    battle = effects.end(battle, first.value);
    assert.deepEqual(pair(battle), [50, 100]);
});
test("MaxHP tick deadline and callback successor use the latest HP ratio", () => {
    let battle = effectFixtureWork(receiver());
    const successor = maxHpBuff("successor", 50);
    const content = maxHpBuff("expiring", 100, {
        onEnd: (state, ctx) => effects.install(state, getUnit(state, ctx.unit.id), successor, {}, ctx.call).state,
    });
    battle = install(battle, content, 1, { scopes: [{ type: "TICK", tick: 1 }] }).state;
    battle = transitionUnit(battle, 1, (unit) => ({ ...unit, vitality: { ...unit.vitality, hp: 40 } }));
    battle = effects.advance(at(battle, 1));
    assert.deepEqual(pair(battle), [30, 150]);
    assert.equal(getUnit(battle, 1).effects.values()[0].definition, successor);
});
