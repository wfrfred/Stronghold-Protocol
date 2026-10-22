import assert from "node:assert/strict";
import { test } from "node:test";
import { Effects } from "../../dist/core/tactical/unit/effect/effects.js";
import { ref } from "../../dist/core/tactical/unit/effect/effect.js";
import { project, derive, dependents } from "../../dist/core/tactical/battlefield/storage/effect-lifetimes.js";

function instance(id, definition, data = definition.initialize(), host = { id: 0 }) {
    return {
        id,
        host,
        definition,
        data,
        source: null,
        scopes: [],
        enabled: true,
        status: "ACTIVE",
    };
}

test("Effect Store queries preserve old versions and replacement retains registration order", () => {
    const shield = { id: "shield", initialize: () => ({ charges: 2 }) };
    const poison = { id: "poison", initialize: () => ({ power: 10 }) };
    const first = instance(0, shield);
    const second = instance(1, poison);
    const original = Effects.empty().add(first).add(second);
    const oldKeys = original.keys();
    const oldValues = original.values();
    const consumed = { ...first, data: { charges: 1 } };
    const updated = original.replace(ref(first), consumed);
    const removed = updated.remove(0);
    const third = instance(2, shield);
    const added = removed.add(third);

    assert.equal(Effects.empty().size, 0);
    assert.deepEqual(oldKeys.toArray(), [0, 1]);
    assert.deepEqual(oldKeys.toArray(), [0, 1]);
    assert.deepEqual(oldValues.toArray(), [first, second]);
    assert.deepEqual(oldValues.toArray(), [first, second]);
    assert.deepEqual(updated.keys().toArray(), [0, 1]);
    assert.deepEqual(updated.values().toArray(), [consumed, second]);
    assert.deepEqual(added.keys().toArray(), [1, 2]);
    assert.deepEqual(added.values().toArray(), [second, third]);
    assert.equal(original.get(ref(first)).data.charges, 2);
    assert.equal(updated.get(ref(first)).data.charges, 1);
    assert.equal(removed.get(ref(first)), undefined);
    assert.equal(added.size, 2);
    assert.equal(added.nextId, 3);
});

test("Effect Store retains its missing-update no-op policy and never reuses allocated identities", () => {
    const definition = { id: "effect", initialize: () => ({ count: 1 }) };
    const first = instance(0, definition);
    const original = Effects.empty().add(first);
    const missing = instance(7, definition);
    const removed = original.remove(first.id);

    assert.strictEqual(original.replace(ref(first), first), original);
    assert.strictEqual(original.replace(ref(missing), missing), original);
    assert.strictEqual(original.remove(missing.id), original);
    assert.strictEqual(removed.remove(first.id), removed);
    assert.strictEqual(removed.replace(ref(first), first), removed);
    assert.equal(removed.nextId, 1);
    assert.throws(() => original.add(first), RangeError);
    assert.throws(() => original.add(instance(2, definition)), RangeError);
    assert.throws(() => removed.add(first), RangeError);
    assert.deepEqual(original.keys().toArray(), [0]);
    assert.deepEqual(removed.keys().toArray(), []);
    assert.equal(removed.add(instance(1, definition)).nextId, 2);
});

test("Effect Store rejects redirected replacement identities and changed Definitions", () => {
    const definition = { id: "effect", initialize: () => ({ count: 1 }) };
    const first = instance(0, definition);
    const original = Effects.empty().add(first);
    const identity = ref(first);
    const moved = { ...first, host: { id: 1 } };

    assert.throws(() => original.replace(identity, { ...first, id: 1 }), TypeError);
    assert.throws(() => original.replace(identity, moved), TypeError);
    assert.throws(() => original.replace(ref(moved), moved), TypeError);
    assert.throws(() => original.replace(identity, {
        ...first,
        definition: { ...definition },
    }), TypeError);
    assert.strictEqual(original.get(identity), first);
    assert.deepEqual(original.keys().toArray(), [0]);
    assert.equal(original.nextId, 1);
});

test("Effect Store restores precise reads only for the matching host and Definition identity", () => {
    const definition = { id: "effect", initialize: () => ({ count: 1 }) };
    const first = instance(0, definition);
    const original = Effects.empty().add(first);

    assert.strictEqual(original.get(ref(first)), first);
    assert.strictEqual(original.get(first.id, definition), first);
    assert.strictEqual(original.get(first.id).definition, definition);
    assert.equal(original.get(first.id, { ...definition }), undefined);
    assert.equal(original.get({ ...ref(first), host: { id: 1 } }), undefined);
    assert.equal(original.read(first.id, self => self.data.count), 1);
    assert.equal(original.read(9, () => { throw new Error("missing Effect reader called"); }), undefined);
});

test("Effect lifetime indexes follow Store versions without rebuilding unchanged containers", () => {
    const definition = { id: "scoped", initialize: () => ({ count: 1 }) };
    const first = { ...instance(0, definition), scopes: [{ type: "UNIT", unitId: 3 }] };
    const host = { id: 0, effects: Effects.empty().add(first) };
    const original = project([host]);
    const changedEffect = { ...first, scopes: [{ type: "UNIT", unitId: 4 }] };
    const changedHost = {
        ...host,
        effects: host.effects.replace(ref(first), changedEffect),
    };
    const updated = derive(original, [{ previousUnit: host, nextUnit: changedHost }]);
    const closedHost = { ...changedHost, effects: changedHost.effects.remove(first.id) };
    const closed = derive(updated, [{ previousUnit: changedHost, nextUnit: closedHost }]);

    assert.strictEqual(derive(original, [{ previousUnit: host, nextUnit: { ...host } }]), original);
    assert.deepEqual(dependents(original, { type: "UNIT", unitId: 3 }), [ref(first)]);
    assert.deepEqual(dependents(updated, { type: "UNIT", unitId: 3 }), []);
    assert.deepEqual(dependents(updated, { type: "UNIT", unitId: 4 }), [ref(first)]);
    assert.deepEqual(dependents(closed, { type: "UNIT", unitId: 4 }), []);
    assert.deepEqual(dependents(updated, { type: "UNIT", unitId: 4 }), [ref(first)]);
});
