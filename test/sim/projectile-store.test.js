import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureBattle } from "../helpers/unit.js";
import { battlefieldView } from "../../dist/core/tactical/battle/state.js";
import { Projectiles } from "../../dist/core/tactical/battlefield/projectile/projectiles.js";
import { get, ref } from "../../dist/core/tactical/battlefield/projectile/operations.js";

const definition = (id) => ({
    id,
});

const projectile = (id, program, state = {}) => ({
    id,
    definition: program,
    lifecycle: "ACTIVE",
    position: [0, 0],
    state,
});

test("projectile queries are lazy, repeatable and bound to their collection version", () => {
    const first = projectile(3, definition("first", { count: 1 }));
    const second = projectile(1, definition("second", { label: "ready" }));
    const original = Projectiles.empty().add(first).add(second);
    const observed = [];
    const values = original.values().map(value => {
        observed.push(value.id);
        return value.position;
    });
    const keys = original.keys();
    const replacement = { ...first, position: [1, 0] };
    const changed = original.replace(ref(first), replacement).remove(second.id);

    assert.deepEqual(observed, []);
    assert.deepEqual(values.take(1).toArray(), [[0, 0]]);
    assert.deepEqual(observed, [3]);
    assert.deepEqual(values.toArray(), [[0, 0], [0, 0]]);
    assert.deepEqual(values.toArray(), [[0, 0], [0, 0]]);
    assert.deepEqual(observed, [3, 3, 1, 3, 1]);
    assert.deepEqual(keys.toArray(), [3, 1]);
    assert.deepEqual(keys.toArray(), [3, 1]);
    assert.deepEqual(changed.keys().toArray(), [3]);
    assert.deepEqual(changed.values().map(value => value.position).toArray(), [[1, 0]]);
    assert.strictEqual(original.get(first.id), first);
    assert.strictEqual(changed.get(first.id), replacement);
});

test("projectile updates preserve strict missing, duplicate and Definition identity contracts", () => {
    const first = projectile(0, definition("shell", { count: 1 }));
    const second = projectile(1, definition("other", {}));
    const original = Projectiles.empty().add(first).add(second);
    const sameIdDefinition = definition("shell", { count: 1 });

    assert.strictEqual(original.replace(ref(first), first), original);
    assert.throws(() => original.add(first), /duplicate projectile/);
    const missing = { ...first, id: 99 };
    assert.throws(() => original.replace(ref(missing), missing), /unknown projectile/);
    assert.throws(() => original.replace(ref(first), missing), /identity cannot change/);
    assert.throws(() => original.remove(99), /unknown projectile/);
    assert.throws(() => original.replace(ref(first), { ...first, definition: sameIdDefinition }), /definition cannot change/);
    assert.throws(() => Projectiles.empty().add({ ...first, id: -1 }), /projectile id/);
    assert.deepEqual(original.keys().toArray(), [0, 1]);
    assert.deepEqual(original.remove(0).add(first).keys().toArray(), [1, 0]);
    assert.equal(original.size, 2);
});

test("known references and Definition identities recover the same complete projectile", () => {
    const firstDefinition = definition("charges", { charges: 2 });
    const secondDefinition = definition("label", { label: "ready" });
    const first = projectile(0, firstDefinition, { charges: 2 });
    const second = projectile(1, secondDefinition, { label: "ready" });
    const original = Projectiles.empty().add(first).add(second);
    const known = ref(first);

    assert.strictEqual(original.get(known), first);
    assert.strictEqual(original.get(first.id, firstDefinition), first);
    assert.equal(original.get(first.id, secondDefinition), undefined);
    assert.equal(original.get(first.id, definition("charges", { charges: 2 })), undefined);
    assert.equal(original.get(999), undefined);
    assert.equal(original.read(999, () => assert.fail("missing reader invoked")), undefined);
    assert.deepEqual(original.read(first.id, self => self.state), { charges: 2 });
    assert.deepEqual(original.read(second.id, self => self.state), { label: "ready" });

    const battle = fixtureBattle();
    const state = { ...battle, battlefield: { ...battle.battlefield, projectiles: original } };
    assert.strictEqual(get(state, known), first);
    assert.strictEqual(battlefieldView(state).getProjectile(known), first);
    assert.deepEqual(state.battlefield.projectiles.values().map(ref).toArray(), [ref(first), ref(second)]);
});

test("projectile snapshots retain private payloads and share immutable instances independently of queries", () => {
    const payload = { charges: 2, nested: { value: 7 } };
    const first = projectile(0, definition("charges", payload), payload);
    const original = Projectiles.empty().add(first);
    const snapshot = original.snapshot();
    const replacement = { ...first, state: { ...payload, charges: 1 }, position: [1, 0] };
    const changed = original.replace(ref(first), replacement);

    assert.ok(Array.isArray(snapshot));
    assert.strictEqual(snapshot[0], first);
    assert.strictEqual(snapshot[0].state, payload);
    assert.strictEqual(snapshot[0].state.nested, payload.nested);
    assert.deepEqual(snapshot[0].state, { charges: 2, nested: { value: 7 } });
    assert.deepEqual(changed.snapshot()[0].state, { charges: 1, nested: { value: 7 } });
    assert.strictEqual(changed.snapshot()[0], replacement);
    assert.equal(original.get(0).definition, first.definition);
});
