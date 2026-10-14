import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { setData } from "../../dist/core/tactical/unit/effect/effect.js";
import { battlefieldView } from "../../dist/core/tactical/battle/state.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import * as effect from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/operations.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { effectFixtureWork, install, definition, attackBuff } from "../helpers/effects.js";

const unit = () =>
    initialize({
        id: 0,
        position: [0, 0],
        definition: {
            id: "competition-unit",
            vitality: { maxHp: 100 },
            offense: { attack: 100 },
        },
    });
const group = (priority) => ({ id: "mutually-exclusive", priority });

test("effect groups: replacing the selected rule withdraws old output and restores its state when the winner ends", () => {
    const trace = [];
    const weak = attackBuff("weak", 20, {
        group: group(1),
        onEnable: (state, context) => {
            trace.push(["weak+", context.self.data.amount]);
            return state;
        },
        onDisable: (state) => {
            trace.push(["weak-"]);
            return state;
        },
    });
    const strong = attackBuff("strong", 50, {
        group: group(2),
        onEnable: (state) => {
            trace.push(["strong+"]);
            return state;
        },
        onDisable: (state) => {
            trace.push(["strong-"]);
            return state;
        },
    });
    let battle = effectFixtureWork(unit());
    let first;
    ({ state: battle, value: first } = install(battle, weak));
    let second;
    ({ state: battle, value: second } = install(battle, strong));
    assert.equal(get(battle, first).status, "INACTIVE");
    assert.equal(get(battle, first).enabled, true);
    assert.equal(get(battle, second).status, "ACTIVE");
    assert.equal(resolveAttackPower(0, battlefieldView(battle)), 150);
    battle = effect.replaceEffect(
        battle,
        first,
        setData(get(battle, first), { amount: 30 }),
    );
    battle = effect.end(battle, second);
    assert.equal(get(battle, first).status, "ACTIVE");
    assert.equal(get(battle, first).data.amount, 30);
    assert.equal(resolveAttackPower(0, battlefieldView(battle)), 130);
    assert.deepEqual(trace, [["weak+", 20], ["weak-"], ["strong+"], ["strong-"], ["weak+", 30]]);
});

test("effect groups: equal priority retains the earlier identity across different definitions", () => {
    let battle = effectFixtureWork(unit());
    let first;
    ({ state: battle, value: first } = install(
        battle,
        definition("first", {}, { group: group(2) }),
    ));
    let second;
    ({ state: battle, value: second } = install(
        battle,
        definition("second", {}, { group: group(2) }),
    ));
    assert.equal(get(battle, first).status, "ACTIVE");
    assert.equal(get(battle, second).status, "INACTIVE");
    battle = effect.end(battle, first);
    assert.equal(get(battle, second).status, "ACTIVE");
});

test("effect groups: disabling the strongest rule does not select a weaker fallback", () => {
    let battle = effectFixtureWork(unit());
    let weak;
    ({ state: battle, value: weak } = install(battle, attackBuff("weak", 20, { group: group(1) })));
    let strong;
    ({ state: battle, value: strong } = install(
        battle,
        attackBuff("strong", 50, { group: group(2) }),
    ));
    battle = effect.setEnabled(battle, strong, false);
    assert.equal(get(battle, strong).status, "INACTIVE");
    assert.equal(get(battle, weak).status, "INACTIVE");
    assert.equal(resolveAttackPower(0, battlefieldView(battle)), 100);
    battle = effect.end(battle, strong);
    assert.equal(get(battle, weak).status, "ACTIVE");
    assert.equal(resolveAttackPower(0, battlefieldView(battle)), 120);
});

test("effect groups: unrelated groups and ungrouped Effects provide their outputs together", () => {
    let battle = effectFixtureWork(unit());
    battle = install(battle, attackBuff("plain", 5)).state;
    battle = install(battle, attackBuff("one", 20, { group: { id: "one", priority: 1 } })).state;
    battle = install(battle, attackBuff("two", 30, { group: { id: "two", priority: 1 } })).state;
    assert.equal(resolveAttackPower(0, battlefieldView(battle)), 155);
});

test("effect groups: a stronger rule installed during withdrawal supersedes the outer selection", () => {
    let battle = effectFixtureWork(unit());
    let replacementRef;
    const replacement = attackBuff("replacement", 300, { group: group(3) });
    const weak = attackBuff("weak", 10, {
        group: group(1),
        onDisable(state, context) {
            const installed = effect.install(state, unitRef(context.unit), replacement, {}, context.call);
            replacementRef = installed.value;
            return installed.state;
        },
    });
    let weakRef;
    ({ state: battle, value: weakRef } = install(battle, weak));
    let middleRef;
    ({ state: battle, value: middleRef } = install(
        battle,
        attackBuff("middle", 100, { group: group(2) }),
    ));
    assert.equal(get(battle, weakRef).status, "INACTIVE");
    assert.equal(get(battle, middleRef).status, "INACTIVE");
    assert.equal(get(battle, replacementRef).status, "ACTIVE");
    assert.equal(resolveAttackPower(0, battlefieldView(battle)), 400);
});
