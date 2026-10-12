import assert from "node:assert/strict";
import { test } from "node:test";
import {
    battlefieldView,
    getUnit,
    transitionUnit,
} from "../../dist/core/tactical/battle/execution/context.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/query.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { definition, effectFixtureWork, install, at } from "../helpers/effects.js";
import { attackEffect, auraUnit, auraEffect } from "../helpers/aura.js";
const power = (battle, id) => resolveAttackPower(id, battlefieldView(battle));
const move = (battle, id, x) =>
    transitionUnit(battle, id, (unit) => ({ ...unit, position: [x, 0] }));

test("aura membership persists after a child ends until leave and reentry", () => {
    const receiver = attackEffect("receiver");
    const aura = auraEffect(receiver, { accepts: (unit) => unit.position[0] < 2 });
    const battle = effectFixtureWork(auraUnit(0), auraUnit(1, [1, 0]));
    const ref = install(battle, aura, 0);
    const child = get(battle, ref).state.bindings[0].refs[0];
    const before = battlefieldView(battle);
    effects.end(battle, child);
    effects.advance(at(battle, 1));
    assert.equal(power(battle, 1), 100);
    assert.deepEqual(get(battle, ref).state.bindings[0].refs, [child]);
    move(battle, 1, 3);
    effects.advance(at(battle, 2));
    assert.deepEqual(get(battle, ref).state.bindings, []);
    move(battle, 1, 1);
    effects.advance(at(battle, 3));
    assert.notDeepEqual(get(battle, ref).state.bindings[0].refs[0], child);
    assert.equal(power(battle, 1), 120);
    assert.equal(before.getUnit(1).effects.instances[0].status, "ACTIVE");
});

test("aura refresh frequency belongs to its tick callback", () => {
    const aura = auraEffect(attackEffect("interval"), {
        accepts: (unit) => unit.position[0] < 2,
        refreshInterval: 3,
    });
    const battle = effectFixtureWork(auraUnit(0), auraUnit(1, [1, 0]), auraUnit(2, [3, 0]));
    const ref = install(battle, aura, 0);
    effects.advance(at(battle, 0));
    move(battle, 1, 3);
    move(battle, 2, 1);
    for (const tick of [1, 2]) {
        effects.advance(at(battle, tick));
        assert.equal(power(battle, 1), 120);
        assert.equal(power(battle, 2), 100);
    }
    effects.advance(at(battle, 3));
    assert.equal(power(battle, 1), 100);
    assert.equal(power(battle, 2), 120);
    assert.equal(get(battle, ref).state.nextRefreshTick, 6);
});

test("host lifetime closes remote children only when explicitly bound", () => {
    for (const bindLifetime of [true, false]) {
        const battle = effectFixtureWork(auraUnit(0), auraUnit(1));
        const aura = auraEffect(attackEffect(`bound-${bindLifetime}`), { bindLifetime });
        const ref = install(battle, aura, 0);
        const child = get(battle, ref).state.bindings[0].refs[0];
        effects.endScope(battle, { type: "UNIT", unitId: 0 }, "RETREAT");
        assert.equal(get(battle, ref), undefined);
        assert.equal(get(battle, child) === undefined, bindLifetime);
        assert.equal(power(battle, 1), bindLifetime ? 100 : 120);
    }
});

test("ordinary end policies decide each receiver against current state", () => {
    const trace = [];
    const marker = definition("retention-marker");
    const receiver = attackEffect("retention", {
        onEnd(ctx) {
            trace.push(["end", ctx.ref.unitId]);
            if (ctx.ref.unitId === 1) effects.install(ctx.battle, getUnit(ctx.battle, 2), marker);
        },
    });
    const aura = definition(
        "retention-aura",
        { bindings: [] },
        {
            onEnable(ctx) {
                for (const unitId of [1, 2]) {
                    const ref = effects.install(ctx.battle, getUnit(ctx.battle, unitId), receiver);
                    ctx.setState((state) => ({
                        ...state,
                        bindings: [...state.bindings, { unitId, ref }],
                    }));
                }
            },
            onEnd(ctx) {
                for (const binding of ctx.self.state.bindings) {
                    const keep = getUnit(ctx.battle, binding.unitId).effects.instances.some(
                        (value) => value.definition === marker,
                    );
                    trace.push(["decide", binding.unitId, keep]);
                    if (!keep) effects.end(ctx.battle, binding.ref);
                }
            },
        },
    );
    const battle = effectFixtureWork(auraUnit(0), auraUnit(1), auraUnit(2));
    const ref = install(battle, aura, 0);
    effects.end(battle, ref);
    assert.deepEqual(trace, [
        ["decide", 1, false],
        ["end", 1],
        ["decide", 2, true],
    ]);
    assert.equal(power(battle, 1), 100);
    assert.equal(power(battle, 2), 120);
});

test("group suppression preserves aura members and child identities", () => {
    const battle = effectFixtureWork(auraUnit(0), auraUnit(1));
    const aura = auraEffect(attackEffect("competing-child"), {
        group: { id: "aura", priority: 1 },
    });
    const ref = install(battle, aura);
    const binding = get(battle, ref).state.bindings[0];
    const winner = install(
        battle,
        definition(
            "aura-winner",
            {},
            {
                group: { id: "aura", priority: 2 },
            },
        ),
    );
    assert.equal(get(battle, ref).status, "INACTIVE");
    assert.equal(power(battle, 1), 100);
    effects.end(battle, winner);
    assert.deepEqual(get(battle, ref).state.bindings[0], binding);
    assert.equal(power(battle, 1), 120);
    assert.equal(getUnit(battle, 1).effects.nextId, 1);
});

test("reenabling refreshes departed receivers before restoring child outputs", () => {
    const enabled = [];
    const receiver = attackEffect("resume", { onEnable: (ctx) => enabled.push(ctx.ref.unitId) });
    const battle = effectFixtureWork(auraUnit(0), auraUnit(1, [1, 0]), auraUnit(2, [1, 0]));
    const ref = install(
        battle,
        auraEffect(receiver, { accepts: (unit) => unit.position[0] < 2 }),
        0,
    );
    const child = get(battle, ref).state.bindings[0].refs[0];
    effects.setEnabled(battle, ref, false);
    enabled.length = 0;
    move(battle, 1, 3);
    effects.setEnabled(battle, ref, true);
    assert.deepEqual(enabled, [2]);
    assert.equal(get(battle, child), undefined);
    assert.equal(power(battle, 1), 100);
    assert.equal(power(battle, 2), 120);
});

test("nested installation can disable an aura before later receivers enter", () => {
    const starts = [];
    const receiver = attackEffect("nested-stop", {
        onInstall(ctx) {
            starts.push(ctx.ref.unitId);
            effects.setEnabled(ctx.battle, ctx.self.scopes[0], false);
        },
    });
    const battle = effectFixtureWork(auraUnit(0), auraUnit(1), auraUnit(2));
    const ref = install(battle, auraEffect(receiver), 0);
    assert.deepEqual(starts, [1]);
    assert.equal(get(battle, ref).status, "INACTIVE");
    assert.equal(power(battle, 1), 100);
    assert.equal(getUnit(battle, 2).effects.instances.length, 0);
});

test("nested child installation ending the aura does not revive parent or child", () => {
    const starts = [];
    const receiver = attackEffect("nested-end", {
        onInstall(ctx) {
            starts.push(ctx.ref.unitId);
            effects.end(ctx.battle, ctx.self.scopes[0]);
        },
    });
    const battle = effectFixtureWork(auraUnit(0), auraUnit(1), auraUnit(2));
    const ref = install(battle, auraEffect(receiver), 0);
    assert.equal(get(battle, ref), undefined);
    assert.deepEqual(starts, [1]);
    assert.deepEqual(getUnit(battle, 1).effects.instances, []);
    assert.equal(power(battle, 1), 100);
});
