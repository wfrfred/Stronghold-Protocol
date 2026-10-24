import assert from "node:assert/strict";
import { test } from "node:test";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { ref } from "../../dist/core/tactical/unit/effect/effect.js";
import * as units from "../../dist/core/tactical/unit/query.js";
import { registerUnit } from "../../dist/core/tactical/battle/state.js";
import { leave } from "../../dist/core/tactical/battle/execution/unit.js";
import * as projectiles from "../../dist/core/tactical/battlefield/projectile/operations.js";
import { fixtureBattle, initialize } from "../helpers/unit.js";

function fixture() {
    let battle = fixtureBattle(5);
    for (const id of [1, 2]) {
        battle = registerUnit(battle, initialize({
            id, position: [id, 0], definition: { id: `effect-host-${id}` },
        }));
    }
    return battle;
}

test("Effect lifecycle callbacks receive their current instance directly and a separate end reason", () => {
    const calls = [];
    const observe = (name, battle, self, reason) => {
        assert.equal(effects.get(battle, ref(self)), self);
        assert.equal(units.get(battle, self.host).effects.get(ref(self)), self);
        calls.push([name, self.status, self.data.count, battle.tick, reason]);
        return battle;
    };
    const program = {
        id: "direct-self",
        initialize: () => ({ count: 0 }),
        onInstall(battle, self) {
            observe("install", battle, self);
            return effects.update(battle, ref(self), data => ({ count: data.count + 1 }));
        },
        onEnable: (battle, self) => observe("enable", battle, self),
        onDisable: (battle, self) => observe("disable", battle, self),
        onTick(battle, self) {
            observe("tick", battle, self);
            return effects.update(battle, ref(self), data => ({ count: data.count + 1 }));
        },
        onEnd: (battle, self, reason) => observe("end", battle, self, reason),
    };
    const installed = effects.install(fixture(), { id: 1 }, program);
    const reference = installed.value;
    let battle = effects.advance(installed.state);
    battle = effects.setEnabled(battle, reference, false);
    battle = effects.setEnabled(battle, reference, true);
    battle = effects.end(battle, reference, "TEST_END");
    assert.deepEqual(calls, [
        ["install", "INSTALLING", 0, 5, undefined],
        ["enable", "ACTIVE", 1, 5, undefined],
        ["tick", "ACTIVE", 1, 5, undefined],
        ["disable", "INACTIVE", 2, 5, undefined],
        ["enable", "ACTIVE", 2, 5, undefined],
        ["disable", "ENDING", 2, 5, undefined],
        ["end", "ENDING", 2, 5, "TEST_END"],
    ]);
    assert.equal(effects.get(battle, reference), undefined);
});

test("Effect onEnd receives private data updated by disable and dependent cleanup", () => {
    let parent;
    const seen = [];
    const program = {
        id: "parent-data",
        initialize: () => ({ count: 0 }),
        onDisable: (battle, self) => effects.update(battle, ref(self), data => ({ count: data.count + 1 })),
        onEnd(battle, self, reason) {
            assert.equal(self, effects.get(battle, ref(self)));
            seen.push([self.data.count, reason]);
            return battle;
        },
    };
    const installed = effects.install(fixture(), { id: 1 }, program);
    parent = installed.value;
    const child = effects.install(installed.state, { id: 2 }, {
        id: "child-data",
        initialize: () => ({}),
        onEnd(battle, self, reason) {
            assert.equal(self.status, "ENDING");
            assert.equal(reason, "PARENT_END");
            return effects.update(battle, parent, data => ({ count: data.count + 10 }));
        },
    }, { scopes: [{ type: "EFFECT", ref: parent }] });
    const battle = effects.end(child.state, parent, "PARENT_END");
    assert.deepEqual(seen, [[11, "PARENT_END"]]);
    assert.equal(effects.get(battle, parent), undefined);
    assert.equal(effects.get(battle, child.value), undefined);
});

test("Effect terminal self survives nested host removal and still cleans independent resources once", () => {
    const ended = [];
    let owned;
    const installed = effects.install(fixture(), { id: 1 }, {
        id: "resource-owner",
        initialize: () => ({ cleaned: false, resource: null }),
        onDisable: (battle, self) => effects.update(battle, ref(self), data => ({ ...data, cleaned: true })),
        onEnd(battle, self, reason) {
            assert.equal(units.get(battle, self.host), undefined);
            assert.equal(effects.get(battle, ref(self)), undefined);
            assert.equal(self.status, "ENDING");
            assert.equal(self.data.cleaned, true);
            assert.equal(self.data.resource, owned);
            ended.push(reason);
            return projectiles.stop(battle, self.data.resource);
        },
    });
    const producer = effects.install(installed.state, { id: 2 }, {
        id: "creates-resource-during-cleanup",
        initialize: () => ({}),
        onEnd(battle) {
            const created = projectiles.create(battle, { id: "owned-resource" }, {
                position: [0, 0], state: {},
            });
            owned = created.value;
            return effects.update(created.state, installed.value, data => ({ ...data, resource: owned }));
        },
    }, { scopes: [{ type: "EFFECT", ref: installed.value }] });
    const child = effects.install(producer.state, { id: 2 }, {
        id: "removes-parent-host",
        initialize: () => ({}),
        onEnd: battle => leave(battle, 1, "SCRIPT"),
    }, { scopes: [{ type: "EFFECT", ref: installed.value }] });
    const battle = effects.end(child.state, installed.value, "OUTER_END");
    assert.deepEqual(ended, ["OUTER_END"]);
    assert.equal(units.get(battle, { id: 1 }), undefined);
    assert.equal(projectiles.get(battle, owned), undefined);
    assert.equal(effects.get(battle, producer.value), undefined);
    assert.equal(effects.get(battle, child.value), undefined);
    assert.equal(battle.events.filter(event => event.type === "PROJECTILE_STOPPED").length, 1);
    assert.equal(effects.end(battle, installed.value), battle);
});
