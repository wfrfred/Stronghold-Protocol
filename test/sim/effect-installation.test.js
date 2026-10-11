import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import * as effect from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/query.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { effectFixtureWork, install, attackBuff } from "../helpers/effects.js";

const host = () =>
    initializeUnit({
        id: 0,
        position: [0, 0],
        definition: {
            id: "installation-host",
            vitality: { maxHp: 100 },
            offense: { attack: 100 },
        },
    });

const group = (priority) => ({ id: "installation-rules", priority });
const attack = (battle) => resolveAttackPower(0, battle.battlefield.snapshot("draft"));

test("effect installation: a nested weaker rule does not enable its parent before installation completes", () => {
    const trace = [];
    const battle = effectFixtureWork(host());
    const child = attackBuff("child", 20);
    let childRef;
    const parent = attackBuff("parent", 0, {
        onApply(context) {
            trace.push("apply begin");
            childRef = effect.apply(context.battle, context.unit, child, { group: group(1) });
            context.setState({ amount: 100 });
            trace.push("apply end");
        },
        onEnable(context) {
            trace.push(["enable", context.self.state.amount]);
        },
    });

    const parentRef = install(battle, parent, 0, { group: group(2) });

    assert.equal(attack(battle), 200);
    assert.deepEqual(trace, ["apply begin", "apply end", ["enable", 100]]);
    assert.equal(get(battle, parentRef).status, "ACTIVE");
    assert.equal(get(battle, childRef).status, "INACTIVE");
});

for (const grouped of [false, true]) {
    test(`effect installation: ${grouped ? "a grouped" : "an ungrouped"} rule can change its enable flag before publishing its final output`, () => {
        const trace = [];
        const battle = effectFixtureWork(host());
        const parent = attackBuff("parent", 0, {
            onApply(context) {
                trace.push("apply begin");
                effect.setEnabled(context.battle, context.ref, false);
                effect.setEnabled(context.battle, context.ref, true);
                context.setState({ amount: 100 });
                trace.push("apply end");
            },
            onEnable(context) {
                trace.push(["enable", context.self.state.amount]);
            },
        });

        install(battle, parent, 0, grouped ? { group: group(2) } : {});

        assert.equal(attack(battle), 200);
        assert.deepEqual(trace, ["apply begin", "apply end", ["enable", 100]]);
    });
}

test("effect installation: an independent child enables while its parent finishes its own installation", () => {
    const trace = [];
    const battle = effectFixtureWork(host());
    const child = attackBuff("child", 20, {
        onEnable() {
            trace.push("child enable");
        },
    });
    const parent = attackBuff("parent", 0, {
        onApply(context) {
            trace.push("apply begin");
            effect.apply(context.battle, context.unit, child);
            context.setState({ amount: 100 });
            trace.push("apply end");
        },
        onEnable(context) {
            trace.push(["enable", context.self.state.amount]);
        },
    });

    install(battle, parent);

    assert.equal(attack(battle), 220);
    assert.deepEqual(trace, ["apply begin", "child enable", "apply end", ["enable", 100]]);
});
