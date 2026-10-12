import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import {
    getUnit,
    battlefieldView,
    transitionUnit,
} from "../../dist/core/tactical/battle/execution/context.js";
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
    const battle = effectFixtureWork(receiver());
    const content = maxHpBuff("hp", 100, {
        onEnable: (ctx) => observed.push(["enabled", ctx.unit.vitality.hp]),
        onDisable: (ctx) => observed.push(["disabled", ctx.unit.vitality.hp]),
        onEnd: (ctx) => observed.push(["ended", ctx.unit.vitality.hp]),
    });
    const before = battlefieldView(battle);
    const ref = install(battle, content);
    assert.deepEqual(pair(battle), [100, 200]);
    effects.setEnabled(battle, ref, false);
    assert.deepEqual(pair(battle), [50, 100]);
    effects.setState(battle, ref, content, { amount: 200 });
    effects.setEnabled(battle, ref, true);
    assert.deepEqual(pair(battle), [150, 300]);
    effects.end(battle, ref);
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
    const battle = effectFixtureWork(receiver());
    const first = install(battle, maxHpBuff("weak", 100, {
        group: { id: "hp", priority: 1 },
    }), 1);
    const second = install(battle, maxHpBuff("strong", 200, {
        group: { id: "hp", priority: 2 },
    }), 1);
    assert.deepEqual(pair(battle), [150, 300]);
    effects.end(battle, second);
    assert.deepEqual(pair(battle), [100, 200]);
    effects.end(battle, first);
    assert.deepEqual(pair(battle), [50, 100]);
});
test("MaxHP tick deadline and callback successor use the latest HP ratio", () => {
    const battle = effectFixtureWork(receiver());
    const successor = maxHpBuff("successor", 50);
    const content = maxHpBuff("expiring", 100, {
        onEnd: (ctx) => effects.install(ctx.battle, ctx.unit, successor),
    });
    install(battle, content, 1, { scopes: [{ type: "TICK", tick: 1 }] });
    transitionUnit(battle, 1, (unit) => ({ ...unit, vitality: { ...unit.vitality, hp: 40 } }));
    effects.advance(at(battle, 1));
    assert.deepEqual(pair(battle), [30, 150]);
    assert.equal(getUnit(battle, 1).effects.instances[0].definition, successor);
});
