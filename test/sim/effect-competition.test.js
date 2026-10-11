import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import * as effect from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/query.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { effectFixtureWork, install, definition, attackBuff } from "../helpers/effects.js";

const unit = () =>
    initializeUnit({
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
        onEnable: (context) => trace.push(["weak+", context.self.state.amount]),
        onDisable: () => trace.push(["weak-"]),
    });
    const strong = attackBuff("strong", 50, {
        onEnable: () => trace.push(["strong+"]),
        onDisable: () => trace.push(["strong-"]),
    });
    const battle = effectFixtureWork(unit());
    const first = install(battle, weak, 0, { group: group(1) });
    const second = install(battle, strong, 0, { group: group(2) });
    assert.equal(get(battle, first).status, "INACTIVE");
    assert.equal(get(battle, first).enabled, true);
    assert.equal(get(battle, second).status, "ACTIVE");
    assert.equal(resolveAttackPower(0, battle.battlefield.snapshot("draft")), 150);
    effect.setState(battle, first, weak, { amount: 30 });
    effect.end(battle, second);
    assert.equal(get(battle, first).status, "ACTIVE");
    assert.equal(get(battle, first).state.amount, 30);
    assert.equal(resolveAttackPower(0, battle.battlefield.snapshot("draft")), 130);
    assert.deepEqual(trace, [["weak+", 20], ["weak-"], ["strong+"], ["strong-"], ["weak+", 30]]);
});

test("effect groups: equal priority retains the earlier identity across different definitions", () => {
    const battle = effectFixtureWork(unit());
    const first = install(battle, definition("first"), 0, { group: group(2) });
    const second = install(battle, definition("second"), 0, { group: group(2) });
    assert.equal(get(battle, first).status, "ACTIVE");
    assert.equal(get(battle, second).status, "INACTIVE");
    effect.end(battle, first);
    assert.equal(get(battle, second).status, "ACTIVE");
});

test("effect groups: disabling the strongest rule does not select a weaker fallback", () => {
    const battle = effectFixtureWork(unit());
    const weak = install(battle, attackBuff("weak", 20), 0, { group: group(1) });
    const strong = install(battle, attackBuff("strong", 50), 0, { group: group(2) });
    effect.setEnabled(battle, strong, false);
    assert.equal(get(battle, strong).status, "INACTIVE");
    assert.equal(get(battle, weak).status, "INACTIVE");
    assert.equal(resolveAttackPower(0, battle.battlefield.snapshot("draft")), 100);
    effect.end(battle, strong);
    assert.equal(get(battle, weak).status, "ACTIVE");
    assert.equal(resolveAttackPower(0, battle.battlefield.snapshot("draft")), 120);
});

test("effect groups: unrelated groups and ungrouped Effects provide their outputs together", () => {
    const battle = effectFixtureWork(unit());
    install(battle, attackBuff("plain", 5));
    install(battle, attackBuff("one", 20), 0, { group: { id: "one", priority: 1 } });
    install(battle, attackBuff("two", 30), 0, { group: { id: "two", priority: 1 } });
    assert.equal(resolveAttackPower(0, battle.battlefield.snapshot("draft")), 155);
});

test("effect groups: a stronger rule installed during withdrawal supersedes the outer selection", () => {
    const battle = effectFixtureWork(unit());
    let replacementRef;
    const replacement = attackBuff("replacement", 300);
    const weak = attackBuff("weak", 10, {
        onDisable(context) {
            replacementRef = effect.apply(context.battle, context.unit, replacement, {
                group: group(3),
            });
        },
    });
    const weakRef = install(battle, weak, 0, { group: group(1) });
    const middleRef = install(battle, attackBuff("middle", 100), 0, { group: group(2) });
    assert.equal(get(battle, weakRef).status, "INACTIVE");
    assert.equal(get(battle, middleRef).status, "INACTIVE");
    assert.equal(get(battle, replacementRef).status, "ACTIVE");
    assert.equal(resolveAttackPower(0, battle.battlefield.snapshot("draft")), 400);
});
