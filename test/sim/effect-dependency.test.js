import assert from "node:assert/strict";
import { test } from "node:test";
import { Effects } from "../../dist/core/tactical/unit/effect/effects.js";
import { ref } from "../../dist/core/tactical/unit/effect/effect.js";
import { empty, project, derive, dependents } from "../../dist/core/tactical/unit/effect/dependency.js";

const definition = { id: "dependency-test", initialize: () => ({}) };
const unitLifetime = id => ({ type: "UNIT", ref: { id } });
const hostedLifetime = (type, host, id) => ({ type, ref: { host: { id: host }, id } });

function host(id, entries) {
    let effects = Effects.empty();
    for (const entry of entries) {
        effects = effects.add({
            id: effects.nextId,
            host: { id },
            definition,
            data: {},
            source: null,
            scopes: entry.scopes,
            enabled: entry.enabled ?? true,
            status: entry.status ?? "ACTIVE",
        });
    }
    return { id, effects };
}

function update(host, id, transform) {
    const current = host.effects.get(id);
    return { ...host, effects: host.effects.replace(ref(current), transform(current)) };
}

function identities(entries) {
    return entries.map(entry => [entry.host.id, entry.id]);
}

test("empty dependency state separates lifetime domains and returns empty array buckets", () => {
    const state = empty();
    assert.deepEqual(Object.keys(state).sort(), ["action", "effect", "elementalBurst", "skill", "unit"]);
    for (const partition of Object.values(state)) {
        assert.equal(partition instanceof Map, true);
        assert.equal(partition.size, 0);
    }
    for (const lifetime of [unitLifetime(1), ...["ACTION", "SKILL", "ELEMENTAL_BURST", "EFFECT"].map(type => hostedLifetime(type, 1, 0))]) {
        assert.deepEqual(dependents(state, lifetime), []);
    }
});

test("project publishes sorted array buckets that queries return directly", () => {
    const lifetime = unitLifetime(5);
    const laterHost = host(9, [{ scopes: [lifetime] }, { scopes: [lifetime] }]);
    const earlierHost = host(2, [{ scopes: [lifetime] }]);
    const state = project([laterHost, earlierHost]);
    const bucket = state.unit.get(5);
    assert.equal(Array.isArray(bucket), true);
    assert.deepEqual(identities(bucket), [[2, 0], [9, 0], [9, 1]]);
    assert.equal(dependents(state, lifetime), bucket);
    assert.equal(dependents(state, lifetime), bucket);

    const appended = { ...earlierHost, effects: earlierHost.effects.add({
        ...earlierHost.effects.get(0), id: 1,
    }) };
    const updated = derive(state, [{ previousUnit: earlierHost, nextUnit: appended }]);
    assert.deepEqual(identities(dependents(updated, lifetime)), [[2, 0], [2, 1], [9, 0], [9, 1]]);
    assert.deepEqual(identities(bucket), [[2, 0], [9, 0], [9, 1]]);
});

for (const [type, partition] of [["ACTION", "action"], ["SKILL", "skill"], ["ELEMENTAL_BURST", "elementalBurst"], ["EFFECT", "effect"]]) {
    test(`${type} dependencies keep equal local IDs on different hosts independent`, () => {
        const first = hostedLifetime(type, 1, 0);
        const second = hostedLifetime(type, 2, 0);
        const left = host(10, [{ scopes: [first] }]);
        const right = host(11, [{ scopes: [second] }]);
        const state = project([left, right]);
        assert.deepEqual(identities(dependents(state, first)), [[10, 0]]);
        assert.deepEqual(identities(dependents(state, second)), [[11, 0]]);
        assert.equal(dependents(state, first), state[partition].get(1).get(0));
        assert.equal(dependents(state, second), state[partition].get(2).get(0));

        const changed = update(left, 0, effect => ({ ...effect, status: "ENDING" }));
        const updated = derive(state, [{ previousUnit: left, nextUnit: changed }]);
        assert.deepEqual(dependents(updated, first), []);
        assert.equal(updated[partition].has(1), false);
        assert.equal(updated[partition].get(2), state[partition].get(2));
        assert.equal(dependents(updated, second), dependents(state, second));
    });
}

test("the same numeric identity in different lifetime domains does not share a bucket", () => {
    const lifetimes = [unitLifetime(1), ...["ACTION", "SKILL", "ELEMENTAL_BURST", "EFFECT"].map(type => hostedLifetime(type, 1, 0))];
    const state = project(lifetimes.map((lifetime, index) => host(index + 10, [{ scopes: [lifetime] }])));
    for (const [index, lifetime] of lifetimes.entries()) {
        assert.deepEqual(identities(dependents(state, lifetime)), [[index + 10, 0]]);
    }
});

test("incremental updates share untouched partitions, host branches and sibling buckets", () => {
    const removed = hostedLifetime("ACTION", 1, 0);
    const retained = hostedLifetime("SKILL", 3, 0);
    const editedHost = host(10, [{ scopes: [removed, retained] }]);
    const untouchedHost = host(11, [{ scopes: [
        hostedLifetime("ACTION", 1, 1), hostedLifetime("ACTION", 2, 0),
        hostedLifetime("ELEMENTAL_BURST", 4, 0), hostedLifetime("EFFECT", 5, 0), unitLifetime(7),
    ] }]);
    const state = project([editedHost, untouchedHost]);
    const nextHost = update(editedHost, 0, effect => ({ ...effect, scopes: [retained] }));
    const updated = derive(state, [{ previousUnit: editedHost, nextUnit: nextHost }]);
    assert.notEqual(updated, state);
    assert.notEqual(updated.action, state.action);
    assert.notEqual(updated.action.get(1), state.action.get(1));
    assert.equal(updated.action.get(1).has(0), false);
    assert.equal(updated.action.get(1).get(1), state.action.get(1).get(1));
    assert.equal(updated.action.get(2), state.action.get(2));
    for (const partition of ["unit", "skill", "elementalBurst", "effect"]) {
        assert.equal(updated[partition], state[partition]);
    }
    assert.deepEqual(identities(dependents(state, removed)), [[10, 0]]);
    assert.deepEqual(dependents(updated, removed), []);
    assert.equal(derive(state, [{ previousUnit: editedHost, nextUnit: { ...editedHost, position: [8, 0] } }]), state);
    const dataOnly = update(editedHost, 0, effect => ({ ...effect, data: { changed: true } }));
    assert.equal(derive(state, [{ previousUnit: editedHost, nextUnit: dataOnly }]), state);
});

test("duplicate scopes register once and ENDING removes only that Effect's dependencies", () => {
    const lifetime = hostedLifetime("EFFECT", 3, 0);
    const owner = host(10, [
        { scopes: [lifetime, { ...lifetime, ref: { host: { id: 3 }, id: 0 } }, { type: "TICK", tick: 5 }] },
        { scopes: [lifetime], status: "INACTIVE", enabled: false },
        { scopes: [lifetime], status: "INSTALLING" },
        { scopes: [lifetime], status: "ENDING" },
    ]);
    const state = project([owner]);
    assert.deepEqual(identities(dependents(state, lifetime)), [[10, 0], [10, 1], [10, 2]]);
    const ending = update(owner, 0, effect => ({ ...effect, status: "ENDING" }));
    const updated = derive(state, [{ previousUnit: owner, nextUnit: ending }]);
    assert.deepEqual(identities(dependents(updated, lifetime)), [[10, 1], [10, 2]]);
    assert.deepEqual(identities(dependents(state, lifetime)), [[10, 0], [10, 1], [10, 2]]);
    const absent = derive(updated, [{ previousUnit: ending, nextUnit: undefined }]);
    assert.deepEqual(dependents(absent, lifetime), []);
    assert.equal(absent.effect.size, 0);
    assert.deepEqual(absent, empty());
});
