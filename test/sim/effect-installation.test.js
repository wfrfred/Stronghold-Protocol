import { ref as effectRef } from "../../dist/core/tactical/unit/effect/effect.js";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { closeLifetime } from "../../dist/core/tactical/battle/execution/lifetime.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialize } from "../helpers/unit.js";
import * as effect from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/operations.js";
import { resolveAttack } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { effectFixtureWork, install, definition, attackBuff } from "../helpers/effects.js";

const host = () =>
    initialize({
        id: 0,
        position: [0, 0],
        definition: {
            id: "installation-host",
            vitality: { maxHp: 100, defense: 0, resistance: 0 },
            offense: { attack: 100 },
        },
    });

const group = (priority) => ({ id: "installation-rules", priority });
const attack = (battle) => resolveAttack(battle, unitRef(getUnit(battle, 0)));

test("effect installation: a nested weaker rule does not enable its parent before installation completes", () => {
    const trace = [];
    let battle = effectFixtureWork(host());
    const child = attackBuff("child", 20, { group: group(1) });
    let childRef;
    const parent = attackBuff("parent", 0, {
        group: group(2),
        onInstall(state, self) {
            assert.equal(self.status, "INSTALLING");
            trace.push("install begin");
            ({ state, value: childRef } = effect.install(
                state,
                self.host,
                child,
                {},
            ));
            assert.equal(get(state, effectRef(self)).status, "INSTALLING");
            state = effect.update(state, effectRef(self), data => ({ amount: 100 }));
            trace.push("install end");
            return state;
        },
        onEnable(state, self) {
            trace.push(["enable", self.data.amount]);
            return state;
        },
    });

    let parentRef;
    ({ state: battle, value: parentRef } = install(battle, parent));

    assert.equal(attack(battle), 200);
    assert.deepEqual(trace, ["install begin", "install end", ["enable", 100]]);
    assert.equal(get(battle, parentRef).status, "ACTIVE");
    assert.equal(get(battle, childRef).status, "INACTIVE");
});

for (const grouped of [false, true]) {
    test(`effect installation: ${grouped ? "a grouped" : "an ungrouped"} rule can change its enable flag before publishing its final output`, () => {
        const trace = [];
        let battle = effectFixtureWork(host());
        const parent = attackBuff("parent", 0, {
            ...(grouped ? { group: group(2) } : {}),
            onInstall(state, self) {
                assert.equal(self.status, "INSTALLING");
                trace.push("install begin");
                state = effect.setEnabled(state, effectRef(self), false);
                state = effect.setEnabled(state, effectRef(self), true);
                state = effect.update(state, effectRef(self), data => ({ amount: 100 }));
                assert.equal(get(state, effectRef(self)).status, "INSTALLING");
                trace.push("install end");
                return state;
            },
            onEnable(state, self) {
                trace.push(["enable", self.data.amount]);
                return state;
            },
        });

        battle = install(battle, parent).state;

        assert.equal(attack(battle), 200);
        assert.deepEqual(trace, ["install begin", "install end", ["enable", 100]]);
    });
}

test("effect installation: an independent child enables while its parent finishes its own installation", () => {
    const trace = [];
    let battle = effectFixtureWork(host());
    const child = attackBuff("child", 20, {
        onEnable(state) {
            trace.push("child enable");
            return state;
        },
    });
    const parent = attackBuff("parent", 0, {
        onInstall(state, self) {
            assert.equal(self.status, "INSTALLING");
            trace.push("install begin");
            state = effect.install(state, self.host, child, {}).state;
            assert.equal(get(state, effectRef(self)).status, "INSTALLING");
            state = effect.update(state, effectRef(self), data => ({ amount: 100 }));
            trace.push("install end");
            return state;
        },
        onEnable(state, self) {
            trace.push(["enable", self.data.amount]);
            return state;
        },
    });

    battle = install(battle, parent).state;

    assert.equal(attack(battle), 220);
    assert.deepEqual(trace, ["install begin", "child enable", "install end", ["enable", 100]]);
});

test("effect installation: ending during installation never publishes the effect's output", () => {
    const trace = [];
    let battle = effectFixtureWork(host());
    const content = attackBuff("self-ending", 100, {
        onInstall(state, self) {
            assert.equal(self.status, "INSTALLING");
            trace.push("install");
            state = effect.end(state, effectRef(self), "NOT_APPLICABLE");
            assert.equal(get(state, effectRef(self)), undefined);
            return state;
        },
        onEnable: (state) => {
            trace.push("enable");
            return state;
        },
        onDisable: (state) => {
            trace.push("disable");
            return state;
        },
        onEnd(state, self) {
            assert.equal(self.status, "ENDING");
            trace.push("end");
            return state;
        },
    });

    let ref;
    ({ state: battle, value: ref } = install(battle, content));

    assert.deepEqual(trace, ["install", "end"]);
    assert.equal(get(battle, ref), undefined);
    assert.equal(attack(battle), 100);
});

test("effect installation: closing the host from a nested installation never enables the parent", () => {
    const trace = [];
    let battle = effectFixtureWork(host());
    const child = definition(
        "host-closing-child",
        {},
        {
            onInstall(state, self) {
                return closeLifetime(state, { type: "UNIT", ref: self.host }, "RETREAT");
            },
        },
    );
    const parent = attackBuff("parent", 100, {
        onInstall(state, self) {
            state = effect.install(state, self.host, child, {}).state;
            assert.equal(get(state, effectRef(self)), undefined);
            return state;
        },
        onEnable: (state) => {
            trace.push("enable");
            return state;
        },
        onEnd: (state) => {
            trace.push("end");
            return state;
        },
    });

    let ref;
    ({ state: battle, value: ref } = install(battle, parent));

    assert.deepEqual(trace, ["end"]);
    assert.equal(get(battle, ref), undefined);
    assert.equal(attack(battle), 100);
});
