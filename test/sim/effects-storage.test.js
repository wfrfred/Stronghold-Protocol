import assert from "node:assert/strict";
import { test } from "node:test";
import { Effects } from "../../dist/core/tactical/unit/effect/effects.js";

const instance = (id, definition, data) => ({
    id,
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
    const updated = both.replace(consumed);
    const removed = updated.remove(0);

    assert.deepEqual(empty.values(), []);
    assert.deepEqual(first.values(), [shieldEffect]);
    assert.deepEqual(both.values(), [shieldEffect, poisonEffect]);
    assert.equal(both.get(0, shield).data.charges, 2);
    assert.equal(updated.get(0, shield).data.charges, 1);
    assert.equal(updated.get(1, poison), poisonEffect);
    assert.equal(updated.get(0), consumed);
    assert.equal(removed.get(0), undefined);
    assert.deepEqual(removed.values(), [poisonEffect]);
    assert.equal(removed.nextId, 2, "deletion preserves instance identity allocation progress");
});

test("Effects restores generic data through Definition identity rather than its string ID", () => {
    const definition = { id: "shield", initialize: () => ({ charges: 2 }) };
    const otherDefinition = { id: "shield", initialize: () => ({ charges: 10 }) };
    const effect = instance(4, definition, definition.initialize());
    const effects = Effects.empty().add(effect);

    assert.equal(effects.get(4, definition), effect);
    assert.equal(effects.get(4, otherDefinition), undefined);
    assert.equal(effects.get(5, definition), undefined);
    assert.equal(effects.nextId, 5);
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
    const disabled = stored.replace({ ...effect, enabled: false });
    const projected = JSON.parse(JSON.stringify({ effects: disabled }));

    assert.deepEqual(projected.effects, {
        instances: [{
            id: 0,
            definition: { id: "stored-only" },
            data: { charges: 3 },
            source: null,
            scopes: [],
            enabled: false,
            status: "INACTIVE",
        }],
        nextId: 1,
    });
    assert.deepEqual(disabled.remove(0).values(), []);
    assert.equal(disabled.get(0).enabled, false);
});
