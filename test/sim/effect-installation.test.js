import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import * as effect from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/query.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { effectFixtureWork, install, definition, attackBuff } from "../helpers/effects.js";

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
    const child = attackBuff("child", 20, { group: group(1) });
    let childRef;
    const parent = attackBuff("parent", 0, {
        group: group(2),
        onInstall(context) {
            assert.equal(context.self.status, "INSTALLING");
            trace.push("install begin");
            childRef = effect.install(context.battle, context.unit, child);
            assert.equal(context.self.status, "INSTALLING");
            context.setState({ amount: 100 });
            trace.push("install end");
        },
        onEnable(context) {
            trace.push(["enable", context.self.state.amount]);
        },
    });

    const parentRef = install(battle, parent);

    assert.equal(attack(battle), 200);
    assert.deepEqual(trace, ["install begin", "install end", ["enable", 100]]);
    assert.equal(get(battle, parentRef).status, "ACTIVE");
    assert.equal(get(battle, childRef).status, "INACTIVE");
});

for (const grouped of [false, true]) {
    test(`effect installation: ${grouped ? "a grouped" : "an ungrouped"} rule can change its enable flag before publishing its final output`, () => {
        const trace = [];
        const battle = effectFixtureWork(host());
        const parent = attackBuff("parent", 0, {
            ...(grouped ? { group: group(2) } : {}),
            onInstall(context) {
                assert.equal(context.self.status, "INSTALLING");
                trace.push("install begin");
                effect.setEnabled(context.battle, context.ref, false);
                effect.setEnabled(context.battle, context.ref, true);
                context.setState({ amount: 100 });
                assert.equal(context.self.status, "INSTALLING");
                trace.push("install end");
            },
            onEnable(context) {
                trace.push(["enable", context.self.state.amount]);
            },
        });

        install(battle, parent);

        assert.equal(attack(battle), 200);
        assert.deepEqual(trace, ["install begin", "install end", ["enable", 100]]);
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
        onInstall(context) {
            assert.equal(context.self.status, "INSTALLING");
            trace.push("install begin");
            effect.install(context.battle, context.unit, child);
            assert.equal(context.self.status, "INSTALLING");
            context.setState({ amount: 100 });
            trace.push("install end");
        },
        onEnable(context) {
            trace.push(["enable", context.self.state.amount]);
        },
    });

    install(battle, parent);

    assert.equal(attack(battle), 220);
    assert.deepEqual(trace, ["install begin", "child enable", "install end", ["enable", 100]]);
});

test("effect installation: ending during installation never publishes the effect's output", () => {
    const trace = [];
    const battle = effectFixtureWork(host());
    const content = attackBuff("self-ending", 100, {
        onInstall(context) {
            assert.equal(context.self.status, "INSTALLING");
            trace.push("install");
            context.end("NOT_APPLICABLE");
            assert.equal(context.self.status, "ENDING");
        },
        onEnable: () => trace.push("enable"),
        onDisable: () => trace.push("disable"),
        onEnd(context) {
            assert.equal(context.self.status, "ENDING");
            trace.push("end");
        },
    });

    const ref = install(battle, content);

    assert.deepEqual(trace, ["install", "end"]);
    assert.equal(get(battle, ref), undefined);
    assert.equal(attack(battle), 100);
});

test("effect installation: closing the host from a nested installation never enables the parent", () => {
    const trace = [];
    const battle = effectFixtureWork(host());
    const child = definition(
        "host-closing-child",
        {},
        {
            onInstall(context) {
                effect.endScope(context.battle, { type: "UNIT", unitId: 0 }, "RETREAT");
            },
        },
    );
    const parent = attackBuff("parent", 100, {
        onInstall(context) {
            effect.install(context.battle, context.unit, child);
            assert.equal(context.self.status, "ENDING");
        },
        onEnable: () => trace.push("enable"),
        onEnd: () => trace.push("end"),
    });

    const ref = install(battle, parent);

    assert.deepEqual(trace, ["end"]);
    assert.equal(get(battle, ref), undefined);
    assert.equal(attack(battle), 100);
});
