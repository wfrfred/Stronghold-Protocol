import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { getUnit, updateUnit } from "../../dist/core/tactical/battle/execution/context.js";
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
            onEnd: (context) => trace.push(context.self.state.name),
        },
    );
    const battle = effectFixtureWork(unit(0), unit(1), unit(2));
    const a = install(battle, value, 0, { initialState: { name: "parent" } });
    const b = install(battle, value, 1, { initialState: { name: "left" }, scopes: [a] });
    const c = install(battle, value, 2, { initialState: { name: "right" }, scopes: [a] });
    const d = install(battle, value, 2, { initialState: { name: "shared" }, scopes: [b, c] });
    effect.end(battle, a, "DISPELLED");
    assert.deepEqual(new Set(trace), new Set(["parent", "left", "right", "shared"]));
    assert.equal(trace.length, 4);
    assert.equal(trace.at(-1), "parent");
    assert.ok([a, b, c, d].every((ref) => get(battle, ref) === undefined));
    effect.end(battle, d);
    assert.equal(trace.length, 4);
});

test("effect lifetimes: provenance does not imply dependence on the source Unit", () => {
    const battle = effectFixtureWork(unit(0), unit(1));
    const independent = install(battle, definition("poison"), 1, { source: 0 });
    const bound = install(battle, definition("aura-child"), 1, {
        source: 0,
        scopes: [{ type: "UNIT", unitId: 0 }],
    });
    effect.endScope(battle, { type: "UNIT", unitId: 0 }, "RETREAT");
    assert.ok(get(battle, independent));
    assert.equal(get(battle, bound), undefined);
    effect.endScope(battle, { type: "UNIT", unitId: 1 }, "DEATH");
    assert.equal(get(battle, independent), undefined);
});

test("effect lifetimes: a closing host rejects a new dependent before its apply callback", () => {
    let attempts = 0;
    let installed;
    const child = definition(
        "new-child",
        {},
        {
            onApply: () => {
                attempts++;
            },
        },
    );
    const parent = definition(
        "parent",
        {},
        {
            onEnd(context) {
                installed = effect.apply(context.battle, context.unit, child);
            },
        },
    );
    const battle = effectFixtureWork(unit(0));
    install(battle, parent);
    effect.endScope(battle, { type: "UNIT", unitId: 0 }, "DEATH");
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
            onEnd(context) {
                accepted = effect.apply(context.battle, getUnit(context.battle, 1), child, {
                    scopes: [context.ref],
                });
            },
        },
    );
    const battle = effectFixtureWork(unit(0), unit(1));
    const ref = install(battle, parent, 0);
    effect.end(battle, ref);
    assert.equal(accepted, undefined);
    assert.equal(getUnit(battle, 1).effects?.instances.length ?? 0, 0);
});

test("effect lifetimes: each subsequent terminal callback sees preceding state changes", () => {
    let later;
    const last = definition(
        "last",
        {},
        {
            onEnd(context) {
                assert.equal(context.unit.vitality.hp, 30);
            },
        },
    );
    const first = definition(
        "first",
        {},
        {
            onEnd(context) {
                context.battle.battlefield.advance([
                    {
                        type: "UPDATE_UNIT",
                        unit: {
                            ...getUnit(context.battle, 1),
                            vitality: { ...getUnit(context.battle, 1).vitality, hp: 30 },
                        },
                    },
                ]);
                effect.end(context.battle, later);
            },
        },
    );
    const battle = effectFixtureWork(unit(0), unit(1));
    const ref = install(battle, first, 0);
    later = install(battle, last, 1);
    effect.end(battle, ref);
    assert.equal(get(battle, later), undefined);
});

test("effect lifetimes: ending the same instance in its disable callback remains terminal and idempotent", () => {
    const calls = [];
    const value = attackBuff("terminal", 20, {
        onDisable(context) {
            calls.push("disable");
            effect.setEnabled(context.battle, context.ref, true);
            context.end("NESTED");
        },
        onEnd: () => calls.push("end"),
    });
    const battle = effectFixtureWork(unit(0));
    const ref = install(battle, value);
    effect.end(battle, ref);
    assert.deepEqual(calls, ["disable", "end"]);
    assert.equal(get(battle, ref), undefined);
    assert.equal(resolveAttackPower(0, battle.battlefield.snapshot("draft")), 100);
});

test("effect lifetimes: closing a host never reenables its suppressed effects", () => {
    const enabled = [];
    const weak = definition("weak", {}, { onEnable: () => enabled.push("weak") });
    const strong = definition("strong", {}, { onEnable: () => enabled.push("strong") });
    const battle = effectFixtureWork(unit(0));
    install(battle, weak, 0, { group: { id: "rule", priority: 1 } });
    install(battle, strong, 0, { group: { id: "rule", priority: 2 } });
    enabled.length = 0;

    effect.endScope(battle, { type: "UNIT", unitId: 0 }, "RETREAT");

    assert.deepEqual(enabled, []);
    assert.deepEqual(getUnit(battle, 0).effects.instances, []);
});

test("effect lifetimes: terminal hook cleanup cannot recreate a host killed by a child's ending", () => {
    const resources = new CombatResources();
    const parent = definition(
        "parent-hook",
        {},
        {
            onApply(context) {
                updateUnit(
                    context.battle,
                    setHook(context.unit, {
                        id: "parent-hook",
                        stage: "reaction",
                        priority: 0,
                        enabled: () => true,
                        invoke() {},
                    }),
                );
            },
            onEnd(context) {
                updateUnit(context.battle, removeHook(context.unit, "parent-hook"));
            },
        },
    );
    const child = definition(
        "child-death",
        {},
        {
            onEnd(context) {
                resolveDamage(
                    context.battle,
                    {
                        sourceUnitId: null,
                        targetUnitId: 0,
                        damageType: "TRUE",
                        operands: createDamageOperands(100),
                        tick: context.tick,
                    },
                    resources,
                );
            },
        },
    );
    const battle = effectFixtureWork(unit(0), unit(1));
    const ref = install(battle, parent, 0);
    install(battle, child, 1, { scopes: [ref] });

    effect.end(battle, ref);

    assert.equal(getUnit(battle, 0), undefined);
    assert.deepEqual(battle.registeredUnitIds, []);
    assert.deepEqual(
        battle.removedUnits.map(({ unitId, reason }) => [unitId, reason]),
        [[0, "DEATH"]],
    );
});
