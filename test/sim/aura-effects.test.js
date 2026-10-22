import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { closeLifetime } from "../../dist/core/tactical/battle/execution/lifetime.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    battlefieldView,
    getUnit,
    transitionUnit,
} from "../../dist/core/tactical/battle/state.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/operations.js";
import { resolveAttack } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { definition, effectFixtureWork, install, at } from "../helpers/effects.js";
import { attackEffect, auraUnit, auraEffect } from "../helpers/aura.js";
const move = (battle, id, x) =>
    transitionUnit(battle, id, (unit) => ({ ...unit, position: [x, 0] }));

test("aura membership persists after a child ends until leave and reentry", () => {
    const receiver = attackEffect("receiver");
    const aura = auraEffect(receiver, { accepts: (unit) => unit.position[0] < 2 });
    let battle = effectFixtureWork(auraUnit(0), auraUnit(1, [1, 0]));
    let ref;
    ({ state: battle, value: ref } = install(battle, aura, 0));
    const child = get(battle, ref).data.bindings[0].refs[0];
    const before = battlefieldView(battle);
    battle = effects.end(battle, child);
    battle = effects.advance(at(battle, 1));
    assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 1))), 100);
    assert.deepEqual(get(battle, ref).data.bindings[0].refs, [child]);
    battle = move(battle, 1, 3);
    battle = effects.advance(at(battle, 2));
    assert.deepEqual(get(battle, ref).data.bindings, []);
    battle = move(battle, 1, 1);
    battle = effects.advance(at(battle, 3));
    assert.notDeepEqual(get(battle, ref).data.bindings[0].refs[0], child);
    assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 1))), 120);
    assert.equal(before.getUnit(1).effects.values().toArray()[0].status, "ACTIVE");
});

test("aura refresh frequency belongs to its tick callback", () => {
    const aura = auraEffect(attackEffect("interval"), {
        accepts: (unit) => unit.position[0] < 2,
        refreshInterval: 3,
    });
    let battle = effectFixtureWork(auraUnit(0), auraUnit(1, [1, 0]), auraUnit(2, [3, 0]));
    let ref;
    ({ state: battle, value: ref } = install(battle, aura, 0));
    battle = effects.advance(at(battle, 0));
    battle = move(battle, 1, 3);
    battle = move(battle, 2, 1);
    for (const tick of [1, 2]) {
        battle = effects.advance(at(battle, tick));
        assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 1))), 120);
        assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 2))), 100);
    }
    battle = effects.advance(at(battle, 3));
    assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 1))), 100);
    assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 2))), 120);
    assert.equal(get(battle, ref).data.nextRefreshTick, 6);
});

test("host lifetime closes remote children only when explicitly bound", () => {
    for (const bindLifetime of [true, false]) {
        let battle = effectFixtureWork(auraUnit(0), auraUnit(1));
        const aura = auraEffect(attackEffect(`bound-${bindLifetime}`), { bindLifetime });
        let ref;
        ({ state: battle, value: ref } = install(battle, aura, 0));
        const child = get(battle, ref).data.bindings[0].refs[0];
        battle = closeLifetime(battle, { type: "UNIT", unitId: 0 }, "RETREAT");
        assert.equal(get(battle, ref), undefined);
        assert.equal(get(battle, child) === undefined, bindLifetime);
        assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 1))), bindLifetime ? 100 : 120);
    }
});

test("ordinary end policies decide each receiver against current state", () => {
    const trace = [];
    const marker = definition("retention-marker");
    const receiver = attackEffect("retention", {
        onEnd(state, ctx) {
            trace.push(["end", ctx.ref.host.id]);
            return ctx.ref.host.id === 1
                ? effects.install(state, unitRef(getUnit(state, 2)), marker, {}).state
                : state;
        },
    });
    const aura = definition(
        "retention-aura",
        { bindings: [] },
        {
            onEnable(state, ctx) {
                for (const unitId of [1, 2]) {
                    const installed = effects.install(
                        state,
                        unitRef(getUnit(state, unitId)),
                        receiver,
                        {},
                    );
                    state = installed.state;
                    state = effects.update(state, ctx.ref, (current) => ({
                            ...current,
                            bindings: [...current.bindings, { unitId, ref: installed.value }],
                        }));
                }
                return state;
            },
            onEnd(state, ctx) {
                for (const binding of ctx.self.data.bindings) {
                    const keep = getUnit(state, binding.unitId).effects.values().toArray().some(
                        (value) => value.definition === marker,
                    );
                    trace.push(["decide", binding.unitId, keep]);
                    if (!keep) state = effects.end(state, binding.ref, "EXPLICIT");
                }
                return state;
            },
        },
    );
    let battle = effectFixtureWork(auraUnit(0), auraUnit(1), auraUnit(2));
    let ref;
    ({ state: battle, value: ref } = install(battle, aura, 0));
    battle = effects.end(battle, ref);
    assert.deepEqual(trace, [
        ["decide", 1, false],
        ["end", 1],
        ["decide", 2, true],
    ]);
    assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 1))), 100);
    assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 2))), 120);
});

test("group suppression preserves aura members and child identities", () => {
    let battle = effectFixtureWork(auraUnit(0), auraUnit(1));
    const aura = auraEffect(attackEffect("competing-child"), {
        group: { id: "aura", priority: 1 },
    });
    let ref;
    ({ state: battle, value: ref } = install(battle, aura));
    const binding = get(battle, ref).data.bindings[0];
    let winner;
    ({ state: battle, value: winner } = install(
        battle,
        definition(
            "aura-winner",
            {},
            {
                group: { id: "aura", priority: 2 },
            },
        ),
    ));
    assert.equal(get(battle, ref).status, "INACTIVE");
    assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 1))), 100);
    battle = effects.end(battle, winner);
    assert.deepEqual(get(battle, ref).data.bindings[0], binding);
    assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 1))), 120);
    assert.equal(getUnit(battle, 1).effects.nextId, 1);
});

test("reenabling refreshes departed receivers before restoring child outputs", () => {
    const enabled = [];
    const receiver = attackEffect("resume", {
        onEnable: (state, ctx) => {
            enabled.push(ctx.ref.host.id);
            return state;
        },
    });
    let battle = effectFixtureWork(auraUnit(0), auraUnit(1, [1, 0]), auraUnit(2, [1, 0]));
    let ref;
    ({ state: battle, value: ref } = install(
        battle,
        auraEffect(receiver, { accepts: (unit) => unit.position[0] < 2 }),
        0,
    ));
    const child = get(battle, ref).data.bindings[0].refs[0];
    battle = effects.setEnabled(battle, ref, false);
    enabled.length = 0;
    battle = move(battle, 1, 3);
    battle = effects.setEnabled(battle, ref, true);
    assert.deepEqual(enabled, [2]);
    assert.equal(get(battle, child), undefined);
    assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 1))), 100);
    assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 2))), 120);
});

test("nested installation can disable an aura before later receivers enter", () => {
    const starts = [];
    const receiver = attackEffect("nested-stop", {
        onInstall(state, ctx) {
            starts.push(ctx.ref.host.id);
            return effects.setEnabled(state, ctx.self.scopes[0].ref, false);
        },
    });
    let battle = effectFixtureWork(auraUnit(0), auraUnit(1), auraUnit(2));
    let ref;
    ({ state: battle, value: ref } = install(battle, auraEffect(receiver), 0));
    assert.deepEqual(starts, [1]);
    assert.equal(get(battle, ref).status, "INACTIVE");
    assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 1))), 100);
    assert.equal(getUnit(battle, 2).effects.values().toArray().length, 0);
});

test("nested child installation ending the aura does not revive parent or child", () => {
    const starts = [];
    const receiver = attackEffect("nested-end", {
        onInstall(state, ctx) {
            starts.push(ctx.ref.host.id);
            return effects.end(state, ctx.self.scopes[0].ref, "EXPLICIT");
        },
    });
    let battle = effectFixtureWork(auraUnit(0), auraUnit(1), auraUnit(2));
    let ref;
    ({ state: battle, value: ref } = install(battle, auraEffect(receiver), 0));
    assert.equal(get(battle, ref), undefined);
    assert.deepEqual(starts, [1]);
    assert.deepEqual(getUnit(battle, 1).effects.values().toArray(), []);
    assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 1))), 100);
});
