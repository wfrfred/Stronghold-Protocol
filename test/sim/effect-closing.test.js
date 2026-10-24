import { damage as dealDamage, parameters } from "../helpers/vitality.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { closeLifetime } from "../../dist/core/tactical/battle/execution/lifetime.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialize } from "../helpers/unit.js";
import {
    getUnit,
    updateUnit,
} from "../../dist/core/tactical/battle/state.js";

import {
    removeHook,
    setHook,
} from "../../dist/core/tactical/battle/damage/hook.js";
import * as effect from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/operations.js";
import { effectFixtureWork, install, definition, attackBuff } from "../helpers/effects.js";
import { resolveAttack } from "../../dist/core/tactical/unit/capability/offense/query.js";

const unit = (id) =>
    initialize({
        id,
        position: [0, 0],
        definition: {
            id: `scope-unit-${id}`,
            vitality: { maxHp: 100, defense: 0, resistance: 0 },
            offense: { attack: 100 },
        },
    });

test("effect lifetimes: parent ending cascades across Units and shared descendants end once", () => {
    const trace = [];
    const value = definition(
        "dependent",
        {},
        {
            onEnd: (state, context) => {
                trace.push(context.self.data.name);
                return state;
            },
        },
    );
    let battle = effectFixtureWork(unit(0), unit(1), unit(2));
    let a;
    ({ state: battle, value: a } = install(battle, value, 0, { data: { name: "parent" } }));
    let b;
    ({ state: battle, value: b } = install(battle, value, 1, {
        data: { name: "left" },
        scopes: [{ type: "EFFECT", ref: a }],
    }));
    let c;
    ({ state: battle, value: c } = install(battle, value, 2, {
        data: { name: "right" },
        scopes: [{ type: "EFFECT", ref: a }],
    }));
    let d;
    ({ state: battle, value: d } = install(battle, value, 2, {
        data: { name: "shared" },
        scopes: [{ type: "EFFECT", ref: b }, { type: "EFFECT", ref: c }],
    }));
    battle = effect.end(battle, a, "DISPELLED");
    assert.deepEqual(new Set(trace), new Set(["parent", "left", "right", "shared"]));
    assert.equal(trace.length, 4);
    assert.equal(trace.at(-1), "parent");
    assert.ok([a, b, c, d].every((ref) => get(battle, ref) === undefined));
    battle = effect.end(battle, d);
    assert.equal(trace.length, 4);
});

test("effect lifetimes: provenance does not imply dependence on the source Unit", () => {
    let battle = effectFixtureWork(unit(0), unit(1));
    let independent;
    ({ state: battle, value: independent } = install(battle, definition("poison"), 1, {
        source: 0,
    }));
    let bound;
    ({ state: battle, value: bound } = install(battle, definition("aura-child"), 1, {
        source: 0,
        scopes: [{ type: "UNIT", ref: { id: 0 } }],
    }));
    battle = closeLifetime(battle, { type: "UNIT", ref: unitRef(getUnit(battle, 0)) }, "RETREAT");
    assert.ok(get(battle, independent));
    assert.equal(get(battle, bound), undefined);
    battle = closeLifetime(battle, { type: "UNIT", ref: unitRef(getUnit(battle, 1)) }, "DEATH");
    assert.equal(get(battle, independent), undefined);
});

test("effect lifetimes: a closing host rejects a new dependent before its install callback", () => {
    let attempts = 0;
    let installed;
    const child = definition(
        "new-child",
        {},
        {
            onInstall: (state) => {
                attempts++;
                return state;
            },
        },
    );
    const parent = definition(
        "parent",
        {},
        {
            onEnd(state, context) {
                const result = effect.install(state, unitRef(context.unit), child, {});
                installed = result.value;
                return result.state;
            },
        },
    );
    let battle = effectFixtureWork(unit(0));
    battle = install(battle, parent).state;
    battle = closeLifetime(battle, { type: "UNIT", ref: unitRef(getUnit(battle, 0)) }, "DEATH");
    assert.equal(installed, undefined);
    assert.equal(attempts, 0);
});

test("effect lifetimes: a closed parent cannot admit a remote dependent during terminal business", () => {
    let accepted;
    const child = definition("new-dependent");
    const parent = definition(
        "parent",
        {},
        {
            onEnd(state, context) {
                const result = effect.install(
                    state,
                    unitRef(getUnit(state, 1)),
                    child,
                    {
                        scopes: [{ type: "EFFECT", ref: context.ref }],
                    },
                );
                accepted = result.value;
                return result.state;
            },
        },
    );
    let battle = effectFixtureWork(unit(0), unit(1));
    let ref;
    ({ state: battle, value: ref } = install(battle, parent, 0));
    battle = effect.end(battle, ref);
    assert.equal(accepted, undefined);
    assert.equal(getUnit(battle, 1).effects?.values().length ?? 0, 0);
});

test("effect lifetimes: each subsequent terminal callback sees preceding state changes", () => {
    let later;
    const last = definition(
        "last",
        {},
        {
            onEnd(state, context) {
                assert.equal(context.unit.vitality.hp, 30);
                return state;
            },
        },
    );
    const first = definition(
        "first",
        {},
        {
            onEnd(state, context) {
                const receiver = getUnit(state, 1);
                state = updateUnit(state, {
                    ...receiver,
                    vitality: { ...receiver.vitality, hp: 30 },
                });
                return effect.end(state, later, "EXPLICIT");
            },
        },
    );
    let battle = effectFixtureWork(unit(0), unit(1));
    let ref;
    ({ state: battle, value: ref } = install(battle, first, 0));
    ({ state: battle, value: later } = install(battle, last, 1));
    battle = effect.end(battle, ref);
    assert.equal(get(battle, later), undefined);
});

test("effect lifetimes: ending the same instance in its disable callback remains terminal and idempotent", () => {
    const calls = [];
    const value = attackBuff("terminal", 20, {
        onDisable(state, context) {
            calls.push("disable");
            state = effect.setEnabled(state, context.ref, true);
            return effect.end(state, context.ref, "NESTED");
        },
        onEnd: (state) => {
            calls.push("end");
            return state;
        },
    });
    let battle = effectFixtureWork(unit(0));
    let ref;
    ({ state: battle, value: ref } = install(battle, value));
    battle = effect.end(battle, ref);
    assert.deepEqual(calls, ["disable", "end"]);
    assert.equal(get(battle, ref), undefined);
    assert.equal(resolveAttack(battle, unitRef(getUnit(battle, 0))), 100);
});

test("effect lifetimes: closing a host never reenables its suppressed effects", () => {
    const enabled = [];
    const weak = definition(
        "weak",
        {},
        {
            group: { id: "rule", priority: 1 },
            onEnable: (state) => {
                enabled.push("weak");
                return state;
            },
        },
    );
    const strong = definition(
        "strong",
        {},
        {
            group: { id: "rule", priority: 2 },
            onEnable: (state) => {
                enabled.push("strong");
                return state;
            },
        },
    );
    let battle = effectFixtureWork(unit(0));
    battle = install(battle, weak).state;
    battle = install(battle, strong).state;
    enabled.length = 0;

    battle = closeLifetime(battle, { type: "UNIT", ref: unitRef(getUnit(battle, 0)) }, "RETREAT");

    assert.deepEqual(enabled, []);
    assert.deepEqual(getUnit(battle, 0).effects.values().toArray(), []);
});

test("effect lifetimes: terminal hook cleanup cannot recreate a host killed by a child's ending", () => {

    const parent = definition(
        "parent-hook",
        {},
        {
            onInstall(state, context) {
                return updateUnit(
                    state,
                    ({ ...context.unit, vitality: setHook(context.unit.vitality, {
                        id: "parent-hook",
                        stage: "completed",
                        priority: 0,
                        accepts: () => true,
                        invoke(state) {
                            return { state, value: undefined };
                        },
                    }) }),
                );
            },
            onEnd(state, context) {
                const host = getUnit(state, context.ref.host.id);
                return host === undefined
                    ? state
                    : updateUnit(state, ({ ...host, vitality: removeHook(host.vitality, "parent-hook") }));
            },
        },
    );
    const child = definition(
        "child-death",
        {},
        {
            onEnd(state, context) {
                return dealDamage(state, { source: null, target: { id: 0 }, parameters: parameters(100, "TRUE") }).state;
            },
        },
    );
    let battle = effectFixtureWork(unit(0), unit(1));
    let ref;
    ({ state: battle, value: ref } = install(battle, parent, 0));
    battle = install(battle, child, 1, { scopes: [{ type: "EFFECT", ref }] }).state;

    battle = effect.end(battle, ref);

    assert.equal(getUnit(battle, 0), undefined);
    assert.deepEqual(getUnit(battle, 1).effects.values().toArray(), []);
    assert.deepEqual(
        battle.removedUnits.map(({ unitId, reason }) => [unitId, reason]),
        [[0, "DEATH"]],
    );
});
