import assert from "node:assert/strict";
import { test } from "node:test";
import { Effects } from "../../dist/core/tactical/unit/effect/effects.js";
import { ref } from "../../dist/core/tactical/unit/effect/effect.js";

const instance = (id, definition, data) => ({
    id,
    host: { id: 0 },
    definition,
    data,
    source: null,
    scopes: [],
    enabled: true,
    status: "INACTIVE",
});

test("Effects stores heterogeneous data and updates retain preceding immutable containers", () => {
    const shield = { id: "shield", initialize: () => ({ charges: 2 }) };
    const poison = { id: "poison", initialize: () => ({ nextTick: 5, damage: 10 }) };
    const shieldEffect = instance(0, shield, shield.initialize());
    const poisonEffect = instance(1, poison, poison.initialize());
    const empty = Effects.empty();
    const first = empty.add(shieldEffect);
    const both = first.add(poisonEffect);
    const consumed = { ...shieldEffect, data: { charges: 1 } };
    const updated = both.replace(ref(shieldEffect), consumed);
    const removed = updated.remove(0);

    assert.deepEqual(empty.values().toArray(), []);
    assert.deepEqual(first.values().toArray(), [shieldEffect]);
    assert.deepEqual(both.values().toArray(), [shieldEffect, poisonEffect]);
    assert.equal(both.get(0, shield).data.charges, 2);
    assert.equal(updated.get(0, shield).data.charges, 1);
    assert.equal(updated.get(1, poison), poisonEffect);
    assert.equal(updated.get(0), consumed);
    assert.equal(removed.get(0), undefined);
    assert.deepEqual(removed.values().toArray(), [poisonEffect]);
    assert.equal(removed.nextId, 2, "deletion preserves instance identity allocation progress");
});

test("Effects restores generic data through Definition identity rather than its string ID", () => {
    const definition = { id: "shield", initialize: () => ({ charges: 2 }) };
    const otherDefinition = { id: "shield", initialize: () => ({ charges: 10 }) };
    const effect = instance(0, definition, definition.initialize());
    const effects = Effects.empty().add(effect);

    assert.equal(effects.get(0, definition), effect);
    assert.equal(effects.get(0, otherDefinition), undefined);
    assert.equal(effects.get(1, definition), undefined);
    assert.equal(effects.nextId, 1);
});

test("Effects rejects duplicate, skipped and reused identities without changing stored values", () => {
    const definition = { id: "shield", initialize: () => ({ charges: 2 }) };
    const first = instance(0, definition, definition.initialize());
    const effects = Effects.empty().add(first);
    const entries = effects.values().toArray();

    assert.throws(() => effects.add(first), RangeError);
    assert.throws(() => effects.add(instance(2, definition, { charges: 1 })), RangeError);
    assert.deepEqual(effects.values().toArray(), entries);
    assert.equal(effects.get(0, definition), first);
    assert.equal(effects.nextId, 1);

    const removed = effects.remove(0);
    assert.throws(() => removed.add(first), RangeError);
    assert.deepEqual(removed.values().toArray(), []);
    assert.equal(removed.nextId, 1);
    assert.equal(removed.add(instance(1, definition, { charges: 1 })).nextId, 2);
});

test("Effects replacement preserves the installed Definition object", () => {
    const definition = { id: "shield", initialize: () => ({ charges: 2 }) };
    const differentDefinition = { id: "shield", initialize: () => ({ charges: 10 }) };
    const effect = instance(0, definition, definition.initialize());
    const effects = Effects.empty().add(effect);
    const entries = effects.values().toArray();

    assert.throws(
        () => effects.replace(ref(effect), { ...effect, definition: differentDefinition }),
        TypeError,
    );
    assert.deepEqual(effects.values().toArray(), entries);
    assert.equal(effects.get(0, definition), effect);
    assert.equal(effects.get(0, differentDefinition), undefined);
    assert.equal(effects.nextId, 1);
});

test("Effects only stores instances, while JSON preserves their data and allocation progress", () => {
    const forbidden = () => { throw new Error("storage must not execute lifecycle callbacks"); };
    const definition = {
        id: "stored-only",
        initialize: forbidden,
        onInstall: forbidden,
        onEnable: forbidden,
        onDisable: forbidden,
        onTick: forbidden,
        onEnd: forbidden,
    };
    const effect = instance(0, definition, { charges: 3 });
    const stored = Effects.empty().add(effect);
    const disabled = stored.replace(ref(effect), { ...effect, enabled: false });
    const projected = JSON.parse(JSON.stringify({ effects: disabled }));

    assert.equal(disabled.read(0, (entry) => entry.definition.id), "stored-only");
    assert.deepEqual(projected.effects, {
        instances: [{
            id: 0,
            host: { id: 0 },
            definition: { id: "stored-only" },
            data: { charges: 3 },
            source: null,
            scopes: [],
            enabled: false,
            status: "INACTIVE",
        }],
        nextId: 1,
    });
    assert.deepEqual(disabled.remove(0).values().toArray(), []);
    assert.equal(disabled.get(0).enabled, false);
    assert.equal(projected.effects.get, undefined, "JSON output does not restore an Effects container");
    assert.equal(projected.effects.instances[0].definition.onTick, undefined);
    assert.equal(projected.effects.instances[0].definition.initialize, undefined);
});
