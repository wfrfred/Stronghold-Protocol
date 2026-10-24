import assert from "node:assert/strict";
import { test } from "node:test";
import { initialize, fixtureBattle } from "../helpers/unit.js";
import { registerUnit, removeUnit, getUnit } from "../../dist/core/tactical/battle/state.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { ref as effectRef } from "../../dist/core/tactical/unit/effect/effect.js";

function fixture(data, callbacks = {}, initial = {}) {
    const host = initialize({
        id: 0,
        position: [0, 0],
        definition: { id: "effect-update-host" },
    });
    const definition = { id: "updatable", initialize: () => data, ...callbacks };
    const created = effects.install(registerUnit(fixtureBattle(), host), unitRef(host), definition, initial);

    return { ...created, definition };
}

test("Effect update transforms current private data and preserves identity, Definition and lifecycle facts", () => {
    const nested = { sampled: 7 };
    const initial = fixture(
        { count: 1, nested },
        { group: { id: "updatable-group", priority: 2 } },
        { source: 42, enabled: false, scopes: [{ type: "TICK", tick: 100 }] },
    );
    const original = effects.get(initial.state, initial.value);
    const first = effects.update(initial.state, initial.value, data => ({ ...data, count: data.count + 4 }));
    let received;
    const second = effects.update(first, initial.value, data => {
        received = data;
        return { ...data, count: data.count + 1 };
    });
    const current = effects.get(second, initial.value);

    assert.strictEqual(received, effects.get(first, initial.value).data);
    assert.equal(received.count, 5);
    assert.equal(current.data.count, 6);
    assert.equal(original.data.count, 1);
    assert.strictEqual(current.data.nested, nested);
    assert.equal(current.id, original.id);
    assert.strictEqual(current.host, original.host);
    assert.strictEqual(current.definition, initial.definition);
    assert.strictEqual(current.scopes, original.scopes);
    assert.equal(current.source, 42);
    assert.equal(current.enabled, false);
    assert.equal(current.status, "INACTIVE");
    assert.equal(getUnit(second, 0).effects.nextId, getUnit(initial.state, 0).effects.nextId);
    assert.strictEqual(second.execution, initial.state.execution);
});

test("Effect update returns the original BattleState when the transform returns its input", () => {
    const created = fixture({ count: 1 });
    const original = effects.get(created.state, created.value);
    let calls = 0;
    const unchanged = effects.update(created.state, created.value, data => {
        calls++;
        assert.strictEqual(data, original.data);
        return data;
    });

    assert.strictEqual(unchanged, created.state);
    assert.strictEqual(effects.get(unchanged, created.value), original);
    assert.equal(calls, 1);
});

test("Effect update does not call its transform after the instance or its host has been removed", () => {
    const created = fixture({ count: 1 });
    const ended = effects.end(created.state, created.value);
    const removed = removeUnit(ended, created.value.host.id, "RETREAT");
    const forbidden = () => { throw new Error("missing Effect transform called"); };

    assert.strictEqual(effects.update(ended, created.value, forbidden), ended);
    assert.strictEqual(effects.update(removed, created.value, forbidden), removed);
    assert.equal(effects.get(ended, created.value), undefined);
    assert.equal(effects.get(removed, created.value), undefined);
});

test("Effect update remains available during both ENDING callbacks without reviving the instance", () => {
    const observed = [];
    const created = fixture({ phases: [] }, {
        onDisable(state, self) {
            const ref = effectRef(self);
            assert.equal(effects.get(state, ref).status, "ENDING");
            state = effects.update(state, ref, data => ({ ...data, phases: [...data.phases, "disable"] }));
            observed.push(effects.get(state, ref).data.phases);
            return state;
        },
        onEnd(state, self) {
            const ref = effectRef(self);
            assert.deepEqual(self.data.phases, ["disable"]);
            state = effects.update(state, ref, data => ({ ...data, phases: [...data.phases, "end"] }));
            assert.equal(effects.get(state, ref).status, "ENDING");
            assert.strictEqual(effects.end(state, ref), state);
            observed.push(effects.get(state, ref).data.phases);
            return state;
        },
    });
    const ended = effects.end(created.state, created.value);

    assert.deepEqual(observed, [["disable"], ["disable", "end"]]);
    assert.equal(effects.get(ended, created.value), undefined);
    assert.deepEqual(effects.get(created.state, created.value).data.phases, []);
    assert.equal(effects.get(created.state, created.value).status, "ACTIVE");
});

test("Effect installation callbacks can initialize private data before enable observes it", () => {
    const observed = [];
    const created = fixture({ count: 0 }, {
        onInstall(state, self) {
            const ref = effectRef(self);
            assert.equal(effects.get(state, ref).status, "INSTALLING");
            return effects.update(state, ref, data => ({ ...data, count: data.count + 1 }));
        },
        onEnable(state, self) {
            observed.push(self.data.count);
            return state;
        },
    });

    assert.deepEqual(observed, [1]);
    assert.equal(effects.get(created.state, created.value).data.count, 1);
    assert.equal(effects.get(created.state, created.value).status, "ACTIVE");
});

test("a failed Effect transform preserves the previously published instance", () => {
    const created = fixture({ count: 1 });
    const original = effects.get(created.state, created.value);
    const failure = new Error("transform failed");

    assert.throws(() => effects.update(created.state, created.value, () => { throw failure; }), error => error === failure);
    assert.strictEqual(effects.get(created.state, created.value), original);
    assert.equal(original.data.count, 1);
});
