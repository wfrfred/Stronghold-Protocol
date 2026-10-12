import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import {
    battlefieldView,
    getUnit,
    updateUnit,
} from "../../dist/core/tactical/battle/state.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import {
    removeHook,
    setHook,
} from "../../dist/core/tactical/unit/capability/vitality/damage/hook.js";
import * as effect from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/query.js";
import { effectFixtureWork, install, definition, attackBuff } from "../helpers/effects.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";

const unit = (id) =>
    initializeUnit({
        id,
        position: [0, 0],
        definition: {
            id: `scope-unit-${id}`,
            vitality: { maxHp: 100 },
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
                trace.push(context.self.state.name);
                return state;
            },
        },
    );
    let battle = effectFixtureWork(unit(0), unit(1), unit(2));
    let a;
    ({ state: battle, value: a } = install(battle, value, 0, { state: { name: "parent" } }));
    let b;
    ({ state: battle, value: b } = install(battle, value, 1, {
        state: { name: "left" },
        scopes: [a],
    }));
    let c;
    ({ state: battle, value: c } = install(battle, value, 2, {
        state: { name: "right" },
        scopes: [a],
    }));
    let d;
    ({ state: battle, value: d } = install(battle, value, 2, {
        state: { name: "shared" },
        scopes: [b, c],
    }));
    battle = effect.end(battle, a, "DISPELLED").state;
    assert.deepEqual(new Set(trace), new Set(["parent", "left", "right", "shared"]));
    assert.equal(trace.length, 4);
    assert.equal(trace.at(-1), "parent");
    assert.ok([a, b, c, d].every((ref) => get(battle, ref) === undefined));
    battle = effect.end(battle, d).state;
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
        scopes: [{ type: "UNIT", unitId: 0 }],
    }));
    battle = effect.endScope(battle, { type: "UNIT", unitId: 0 }, "RETREAT");
    assert.ok(get(battle, independent));
    assert.equal(get(battle, bound), undefined);
    battle = effect.endScope(battle, { type: "UNIT", unitId: 1 }, "DEATH");
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
                const result = effect.install(state, context.unit, child, {}, context.call);
                installed = result.value;
                return result.state;
            },
        },
    );
    let battle = effectFixtureWork(unit(0));
    battle = install(battle, parent).state;
    battle = effect.endScope(battle, { type: "UNIT", unitId: 0 }, "DEATH");
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
                    getUnit(state, 1),
                    child,
                    {
                        scopes: [context.ref],
                    },
                    context.call,
                );
                accepted = result.value;
                return result.state;
            },
        },
    );
    let battle = effectFixtureWork(unit(0), unit(1));
    let ref;
    ({ state: battle, value: ref } = install(battle, parent, 0));
    battle = effect.end(battle, ref).state;
    assert.equal(accepted, undefined);
    assert.equal(getUnit(battle, 1).effects?.instances.length ?? 0, 0);
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
                return effect.end(state, later, "EXPLICIT", context.call).state;
            },
        },
    );
    let battle = effectFixtureWork(unit(0), unit(1));
    let ref;
    ({ state: battle, value: ref } = install(battle, first, 0));
    ({ state: battle, value: later } = install(battle, last, 1));
    battle = effect.end(battle, ref).state;
    assert.equal(get(battle, later), undefined);
});

test("effect lifetimes: ending the same instance in its disable callback remains terminal and idempotent", () => {
    const calls = [];
    const value = attackBuff("terminal", 20, {
        onDisable(state, context) {
            calls.push("disable");
            state = effect.setEnabled(state, context.ref, true, context.call);
            return effect.end(state, context.ref, "NESTED", context.call).state;
        },
        onEnd: (state) => {
            calls.push("end");
            return state;
        },
    });
    let battle = effectFixtureWork(unit(0));
    let ref;
    ({ state: battle, value: ref } = install(battle, value));
    battle = effect.end(battle, ref).state;
    assert.deepEqual(calls, ["disable", "end"]);
    assert.equal(get(battle, ref), undefined);
    assert.equal(resolveAttackPower(0, battlefieldView(battle)), 100);
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

    battle = effect.endScope(battle, { type: "UNIT", unitId: 0 }, "RETREAT");

    assert.deepEqual(enabled, []);
    assert.deepEqual(getUnit(battle, 0).effects.instances, []);
});

test("effect lifetimes: terminal hook cleanup cannot recreate a host killed by a child's ending", () => {
    const resources = new CombatResources();
    const parent = definition(
        "parent-hook",
        {},
        {
            onInstall(state, context) {
                return updateUnit(
                    state,
                    setHook(context.unit, {
                        id: "parent-hook",
                        stage: "reaction",
                        priority: 0,
                        enabled: () => true,
                        invoke(state) {
                            return { state, value: {} };
                        },
                    }),
                );
            },
            onEnd(state, context) {
                const host = getUnit(state, context.ref.unitId);
                return host === undefined
                    ? state
                    : updateUnit(state, removeHook(host, "parent-hook"));
            },
        },
    );
    const child = definition(
        "child-death",
        {},
        {
            onEnd(state, context) {
                return resolveDamage(
                    state,
                    {
                        sourceUnitId: null,
                        targetUnitId: 0,
                        damageType: "TRUE",
                        operands: createDamageOperands(100),
                        tick: context.tick,
                    },
                    resources,
                    context.call,
                ).state;
            },
        },
    );
    let battle = effectFixtureWork(unit(0), unit(1));
    let ref;
    ({ state: battle, value: ref } = install(battle, parent, 0));
    battle = install(battle, child, 1, { scopes: [ref] }).state;

    battle = effect.end(battle, ref).state;

    assert.equal(getUnit(battle, 0), undefined);
    assert.deepEqual(battle.registeredUnitIds, []);
    assert.deepEqual(
        battle.removedUnits.map(({ unitId, reason }) => [unitId, reason]),
        [[0, "DEATH"]],
    );
});
