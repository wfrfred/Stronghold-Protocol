import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { getUnit, transitionUnit } from "../../dist/core/tactical/battle/execution/context.js";
import * as effect from "../../dist/core/tactical/unit/effect/operations.js";
import { get, find } from "../../dist/core/tactical/unit/effect/query.js";
import {
    definition,
    effectFixtureWork,
    install,
    at,
    attackBuff,
    refreshAttack,
} from "../helpers/effects.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";

const unit = (id = 0) =>
    initializeUnit({
        id,
        position: [0, 0],
        definition: {
            id: `effect-unit-${id}`,
            vitality: { maxHp: 100 },
            offense: { attack: 100 },
        },
    });

test("effects: a direct static definition initializes private state and runs apply before enable", () => {
    const seen = [];
    const value = definition(
        "direct",
        { count: 0 },
        {
            onApply(context) {
                assert.equal(get(context.battle, context.ref).definition, value);
                context.setState((current) => ({ count: current.count + 1 }));
                seen.push(["apply", context.self.state.count]);
            },
            onEnable(context) {
                seen.push(["enable", context.self.state.count]);
            },
        },
    );
    const battle = effectFixtureWork(unit());
    const old = battle.battlefield.snapshot("draft");
    const ref = install(battle, value);
    assert.equal(get(battle, ref).definition, value);
    assert.deepEqual(get(battle, ref).state, { count: 1 });
    assert.equal(get(battle, ref).status, "ACTIVE");
    assert.deepEqual(seen, [
        ["apply", 1],
        ["enable", 1],
    ]);
    assert.equal(old.getUnit(0).effects?.instances.length ?? 0, 0);
});

test("effects: updates share immutable values and find pairs a definition with its state", () => {
    const nested = { amount: 1 };
    const value = definition("state", { count: 1, nested });
    const other = definition("other");
    const battle = effectFixtureWork(unit());
    const ref = install(battle, value);
    const old = get(battle, ref);
    effect.setState(battle, ref, value, (current) => ({ ...current, count: 2 }));
    const current = get(battle, ref);
    assert.equal(current.state.nested, nested);
    assert.equal(old.state.count, 1);
    assert.equal(current.state.count, 2);
    assert.equal(find(getUnit(battle, 0), value, ref.effectId), current);
    assert.equal(find(getUnit(battle, 0), other, ref.effectId), undefined);
});

test("effects: disabling withdraws output while preserving private state and identity", () => {
    const seen = [];
    const value = attackBuff("attack", 20, {
        onApply: () => seen.push("apply"),
        onEnable: () => seen.push("enable"),
        onDisable: () => seen.push("disable"),
    });
    const battle = effectFixtureWork(unit());
    const ref = install(battle, value);
    const attack = () => resolveAttackPower(0, battle.battlefield.snapshot("draft"));
    assert.equal(attack(), 120);
    effect.setEnabled(battle, ref, false);
    assert.equal(attack(), 100);
    effect.setState(battle, ref, value, { amount: 30 });
    assert.equal(attack(), 100);
    effect.setEnabled(battle, ref, true);
    assert.equal(attack(), 130);
    assert.deepEqual(seen, ["apply", "enable", "disable", "enable"]);
    assert.equal(get(battle, ref).id, ref.effectId);
});

test("effects: content explicitly refreshes a static contribution after changing private state", () => {
    const value = attackBuff();
    const battle = effectFixtureWork(unit());
    const ref = install(battle, value);
    const previous = battle.battlefield.snapshot("draft");
    effect.setState(battle, ref, value, { amount: 50 });
    assert.equal(resolveAttackPower(0, battle.battlefield.snapshot("draft")), 120);
    refreshAttack(battle, ref);
    assert.equal(resolveAttackPower(0, battle.battlefield.snapshot("draft")), 150);
    assert.equal(resolveAttackPower(0, previous), 120);
});

test("effects: ending withdraws outputs before terminal business and repeated ending does nothing", () => {
    const seen = [];
    const value = attackBuff("ending", 20, {
        onDisable(context) {
            seen.push(["disable", context.self.status]);
        },
        onEnd(context) {
            seen.push([
                "end",
                context.reason,
                resolveAttackPower(0, context.battle.battlefield.snapshot("draft")),
            ]);
            context.end("REENTRANT");
        },
    });
    const battle = effectFixtureWork(unit());
    const ref = install(battle, value);
    effect.end(battle, ref, "DISPELLED");
    effect.end(battle, ref, "OTHER");
    assert.deepEqual(
        seen.map((entry) => entry[0]),
        ["disable", "end"],
    );
    assert.deepEqual(seen[1], ["end", "DISPELLED", 100]);
    assert.equal(resolveAttackPower(0, battle.battlefield.snapshot("draft")), 100);
});

test("effects: callbacks read current Unit state after a preceding nested operation", () => {
    const value = definition(
        "current-host",
        {},
        {
            onApply(context) {
                transitionUnit(context.battle, 0, (current) => ({
                    ...current,
                    vitality: { ...current.vitality, hp: 30 },
                }));
                assert.equal(context.unit.vitality.hp, 30);
            },
            onTick(context) {
                context.setState({ observedHp: context.unit.vitality.hp, tick: context.tick });
            },
        },
    );
    const battle = effectFixtureWork(unit());
    const ref = install(battle, value);
    effect.advance(at(battle, 7));
    assert.deepEqual(get(battle, ref).state, { observedHp: 30, tick: 7 });
});

test("effects: a callback sees termination when a nested operation ends its instance", () => {
    const seen = [];
    const value = definition(
        "ended-by-operation",
        {},
        {
            onTick(context) {
                effect.end(context.battle, context.ref);
                seen.push(context.self.status);
            },
        },
    );
    const battle = effectFixtureWork(unit());
    const ref = install(battle, value);

    effect.advance(at(battle, 1));

    assert.deepEqual(seen, ["FINISHED"]);
    assert.equal(get(battle, ref), undefined);
});
