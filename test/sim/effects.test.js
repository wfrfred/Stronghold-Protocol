import { setData } from "../../dist/core/tactical/unit/effect/effect.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialize } from "../helpers/unit.js";
import {
    battlefieldView,
    getUnit,
    transitionUnit,
} from "../../dist/core/tactical/battle/state.js";
import * as effect from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/operations.js";
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
    initialize({
        id,
        position: [0, 0],
        definition: {
            id: `effect-unit-${id}`,
            vitality: { maxHp: 100 },
            offense: { attack: 100 },
        },
    });

test("effects: a direct static definition initializes private state and runs install before enable", () => {
    const seen = [];
    const value = definition(
        "direct",
        { count: 0 },
        {
            onInstall(state, context) {
                assert.equal(get(state, context.ref).definition, value);
                const next = setData(context.self, (current) => ({
                    count: current.count + 1,
                }));
                seen.push(["install", next.data.count]);
                return effect.replaceEffect(state, context.ref, next);
            },
            onEnable(state, context) {
                seen.push(["enable", context.self.data.count]);
                return state;
            },
        },
    );
    let battle = effectFixtureWork(unit());
    const old = battlefieldView(battle);
    let ref;
    ({ state: battle, value: ref } = install(battle, value));
    assert.equal(get(battle, ref).definition, value);
    assert.deepEqual(get(battle, ref).data, { count: 1 });
    assert.equal(get(battle, ref).status, "ACTIVE");
    assert.deepEqual(seen, [
        ["install", 1],
        ["enable", 1],
    ]);
    assert.equal(old.getUnit(0).effects?.values().length ?? 0, 0);
});

test("effects: updates share immutable values and container queries pair a definition with its data", () => {
    const nested = { amount: 1 };
    const value = definition("state", { count: 1, nested });
    const other = definition("other");
    let battle = effectFixtureWork(unit());
    let ref;
    ({ state: battle, value: ref } = install(battle, value));
    const old = get(battle, ref);
    battle = effect.replaceEffect(
        battle,
        ref,
        setData(old, (current) => ({ ...current, count: 2 })),
    );
    const current = get(battle, ref);
    assert.equal(current.data.nested, nested);
    assert.equal(old.data.count, 1);
    assert.equal(current.data.count, 2);
    assert.equal(getUnit(battle, 0).effects.get(ref.id, value), current);
    assert.equal(getUnit(battle, 0).effects.get(ref.id, other), undefined);
});

test("effects: disabling withdraws output while preserving private state and identity", () => {
    const seen = [];
    const value = attackBuff("attack", 20, {
        onInstall: (state) => {
            seen.push("install");
            return state;
        },
        onEnable: (state) => {
            seen.push("enable");
            return state;
        },
        onDisable: (state) => {
            seen.push("disable");
            return state;
        },
    });
    let battle = effectFixtureWork(unit());
    let ref;
    ({ state: battle, value: ref } = install(battle, value));
    const attack = () => resolveAttackPower(0, battlefieldView(battle));
    assert.equal(attack(), 120);
    battle = effect.setEnabled(battle, ref, false);
    assert.equal(attack(), 100);
    battle = effect.replaceEffect(
        battle,
        ref,
        setData(get(battle, ref), { amount: 30 }),
    );
    assert.equal(attack(), 100);
    battle = effect.setEnabled(battle, ref, true);
    assert.equal(attack(), 130);
    assert.deepEqual(seen, ["install", "enable", "disable", "enable"]);
    assert.equal(get(battle, ref).id, ref.id);
});

test("effects: content explicitly refreshes a static contribution after changing private state", () => {
    const value = attackBuff();
    let battle = effectFixtureWork(unit());
    let ref;
    ({ state: battle, value: ref } = install(battle, value));
    const previous = battlefieldView(battle);
    battle = effect.replaceEffect(
        battle,
        ref,
        setData(get(battle, ref), { amount: 50 }),
    );
    assert.equal(resolveAttackPower(0, battlefieldView(battle)), 120);
    battle = refreshAttack(battle, ref);
    assert.equal(resolveAttackPower(0, battlefieldView(battle)), 150);
    assert.equal(resolveAttackPower(0, previous), 120);
});

test("effects: ending withdraws outputs before terminal business and repeated ending does nothing", () => {
    const seen = [];
    const value = attackBuff("ending", 20, {
        onDisable(state, context) {
            seen.push(["disable", context.self.status]);
            return state;
        },
        onEnd(state, context) {
            seen.push(["end", context.reason, resolveAttackPower(0, battlefieldView(state))]);
            return effect.end(state, context.ref, "REENTRANT", context.call);
        },
    });
    let battle = effectFixtureWork(unit());
    let ref;
    ({ state: battle, value: ref } = install(battle, value));
    battle = effect.end(battle, ref, "DISPELLED");
    battle = effect.end(battle, ref, "OTHER");
    assert.deepEqual(
        seen.map((entry) => entry[0]),
        ["disable", "end"],
    );
    assert.deepEqual(seen[1], ["end", "DISPELLED", 100]);
    assert.equal(resolveAttackPower(0, battlefieldView(battle)), 100);
});

test("effects: callbacks read current Unit state after a preceding nested operation", () => {
    const value = definition(
        "current-host",
        {},
        {
            onInstall(state, context) {
                state = transitionUnit(state, 0, (current) => ({
                    ...current,
                    vitality: { ...current.vitality, hp: 30 },
                }));
                assert.equal(context.unit.vitality.hp, 100, "Context retains its input version");
                assert.equal(getUnit(state, 0).vitality.hp, 30);
                return state;
            },
            onTick(state, context) {
                return effect.replaceEffect(
                    state,
                    context.ref,
                    setData(context.self, {
                        observedHp: context.unit.vitality.hp,
                        tick: context.tick,
                    }),
                );
            },
        },
    );
    let battle = effectFixtureWork(unit());
    let ref;
    ({ state: battle, value: ref } = install(battle, value));
    battle = effect.advance(at(battle, 7));
    assert.deepEqual(get(battle, ref).data, { observedHp: 30, tick: 7 });
});

test("effects: a callback sees termination when a nested operation ends its instance", () => {
    const seen = [];
    const value = definition(
        "ended-by-operation",
        {},
        {
            onTick(state, context) {
                state = effect.end(state, context.ref, "EXPLICIT", context.call);
                seen.push(context.self.status);
                assert.equal(get(state, context.ref), undefined);
                return state;
            },
        },
    );
    let battle = effectFixtureWork(unit());
    let ref;
    ({ state: battle, value: ref } = install(battle, value));

    battle = effect.advance(at(battle, 1));

    assert.deepEqual(seen, ["ACTIVE"], "Context values retain their input version after ending");
    assert.equal(get(battle, ref), undefined);
});
