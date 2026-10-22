import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { effectFixtureWork as workFor } from "../helpers/effects.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as modifier from "../../dist/core/tactical/unit/contribution/attribute.js";
import * as contribution from "../../dist/core/tactical/unit/contribution/contribution.js";
import { initialize } from "../helpers/unit.js";
import { copy } from "../../dist/core/tactical/unit/snapshot.js";
import {
    setAttackContribution,
    removeAttackContribution,
} from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { resolveAttack } from "../../dist/core/tactical/unit/capability/offense/query.js";
import {
    setResistanceContribution,
    resolveDefense,
} from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import {
    battlefieldView,
    createBattleState,
    getUnit,
    registerUnit,
    transitionUnit,
    removeUnit,
} from "../../dist/core/tactical/battle/state.js";

const unit = (id, attack = 100) =>
    initialize({
        id,
        definition: { id: `unit-${id}`, offense: { attack }, vitality: { maxHp: 100, defense: 0, resistance: 0 } },
        position: [0, 0],
    });
const value = (amount) => modifier.create({ finalAddition: amount });
test("contributions: set and remove preserve immutable arrays and shared values", () => {
    const group = { id: "attack", priority: 3 };
    const values = [value(10)];
    const input = { id: "sample", value: values, group };
    const baseline = [];
    const entries = contribution.set(baseline, input);
    assert.deepEqual(baseline, []);
    assert.equal(entries[0], input);
    assert.equal(entries[0].group, group);
    assert.equal(entries[0].value, values);
    assert.equal(contribution.set(entries, input), entries);
    assert.equal(contribution.remove(entries, "missing"), entries);
    assert.deepEqual(contribution.remove(entries, "sample"), []);
    assert.equal(entries[0], input);
});

test("contributions: set replaces a matching identity and shares unrelated entries", () => {
    const first = { id: "first", value: [value(10)] };
    const second = { id: "second", value: [value(20)] };
    const baseline = contribution.set(contribution.set([], first), second);
    const replacement = { id: "first", value: [value(30)] };
    const updated = contribution.set(baseline, replacement);
    assert.equal(updated.length, 2);
    assert.equal(updated[0], replacement);
    assert.equal(updated[1], second);
    assert.equal(baseline[0], first);
    assert.equal(contribution.remove(updated, "first")[0], second);
});

test("contributions: group priority and ID ties are independent of insertion order", () => {
    const entries = [
        { id: "effect/2", group: { id: "shared", priority: 2 }, value: [value(20)] },
        { id: "effect/10", group: { id: "shared", priority: 2 }, value: [value(10)] },
        { id: "strong", group: { id: "shared", priority: 3 }, value: [value(30)] },
        { id: "independent", value: [value(5)] },
    ];
    assert.deepEqual(contribution.resolve(entries), [[value(5)], [value(30)]]);
    const fallback = contribution.remove(entries, "strong");
    assert.deepEqual(contribution.resolve(fallback), [[value(10)], [value(5)]]);
    assert.deepEqual(contribution.resolve([...fallback].reverse()), contribution.resolve(fallback));
    assert.equal(fallback.length, 3);
});

test("contributions: winners alone evaluate and effective modifiers follow ID order", () => {
    const calls = [];
    const context = { amount: 7 };
    const entries = [
        {
            id: "z",
            value: (input) => {
                calls.push(input);
                return [value(input.amount)];
            },
        },
        {
            id: "loser",
            group: { id: "shared", priority: 0 },
            value: () => {
                throw new Error("loser evaluated");
            },
        },
        { id: "a", group: { id: "shared", priority: 1 }, value: [value(3)] },
    ];
    const selected = contribution.resolve(entries);
    assert.deepEqual(calls, []);
    assert.equal(selected[0], entries[2].value);
    assert.equal(selected[1], entries[0].value);
    assert.deepEqual(
        selected.flatMap((input) => modifier.evaluate(input, context)),
        [value(3), value(7)],
    );
    assert.deepEqual(calls, [context]);
    assert.equal(modifier.evaluate(entries[2].value, context), entries[2].value);
});

test("contributions: selection preserves domain payloads without interpreting or flattening them", () => {
    const budget = { fixed: 2, ratio: 0.5 };
    const entries = contribution.set(
        contribution.set([], { id: "budget", value: budget }),
        { id: "pending", value: ["first", "second"] },
    );
    const resolved = contribution.resolve(entries);
    assert.equal(resolved[0], budget);
    assert.equal(resolved[1], entries[1].value);
    assert.deepEqual(resolved, [budget, ["first", "second"]]);

    const volumes = [
        { id: "weak", value: 1, group: { id: "volume", priority: 1 } },
        { id: "strong", value: 3, group: { id: "volume", priority: 2 } },
        { id: "independent", value: -1 },
    ];
    assert.deepEqual(contribution.resolve(volumes), [-1, 3]);
    assert.equal(contribution.resolve(volumes).reduce((sum, value) => sum + value, 0), 2);
});

test("contributions: capability set, remove and replacement preserve prior snapshots", () => {
    const initial = unit(1);
    const sample = { id: "inspiration", value: [value(150)] };
    const sampled = ({ ...initial, offense: setAttackContribution(initial.offense, sample) });
    let work = workFor(sampled);
    assert.equal(resolveAttack(work, unitRef(getUnit(work, 1))), 250);
    work = transitionUnit(work, 1, (current) => ({ ...current, offense: removeAttackContribution(current.offense, "inspiration") }));
    assert.equal(resolveAttack(work, unitRef(getUnit(work, 1))), 100);
    work = transitionUnit(work, 1, (current) => ({ ...current, offense: setAttackContribution(current.offense, sample) }));
    assert.equal(resolveAttack(work, unitRef(getUnit(work, 1))), 250);
    const copied = copy(getUnit(work, 1));
    assert.equal(copied.offense.attack, getUnit(work, 1).offense.attack);
    const resumedSnapshot = work;
    work = transitionUnit(work, 1, (current) =>
        ({ ...current, offense: setAttackContribution(current.offense, { id: "inspiration", value: [value(200)] }) }),
    );
    assert.equal(resolveAttack(work, unitRef(getUnit(work, 1))), 300);
    assert.equal(resolveAttack(resumedSnapshot, unitRef(getUnit(resumedSnapshot, 1))), 250);
});

test("contributions: direct capability closures read current facts and retain previous snapshots", () => {
    const initial = ({ ...unit(1), offense: setAttackContribution(unit(1).offense, {
        id: "dynamic",
        value: (_battle, self) => [value(self.vitality.hp < 50 ? 100 : 0)],
    }) });
    let work = workFor(initial);
    const original = work;
    assert.equal(resolveAttack(original, unitRef(getUnit(original, 1))), 100);
    work = transitionUnit(work, 1, (current) => ({
        ...current,
        vitality: { ...current.vitality, hp: 30 },
    }));
    assert.equal(resolveAttack(work, unitRef(getUnit(work, 1))), 200);
    assert.equal(resolveAttack(original, unitRef(getUnit(original, 1))), 100);
    assert.equal(getUnit(work, 1).offense.attack, initial.offense.attack);
});

test("contributions: sampled and dynamic defense values resolve without mutating inputs", () => {
    for (const dynamic of [false, true])
        for (const [amount, expected] of [
            [0, 30],
            [10, 40],
            [-50, 0],
            [90, 100],
        ]) {
            const base = initialize({
                id: 1,
                position: [0, 0],
                definition: { id: "defended", vitality: { maxHp: 100, defense: 200, resistance: 30 } },
            });
            const modifiers = [value(amount)];
            const entry = { id: "resistance", value: dynamic ? () => modifiers : modifiers };
            const current = ({ ...base, vitality: setResistanceContribution(base.vitality, entry) });
            const view = battlefieldView(workFor(current));
            assert.deepEqual(resolveDefense(current.vitality, current.definition.vitality, { unit: current, battlefield: view }), { defense: 200, resistance: expected });
            assert.equal(current.vitality.resistance[0], entry);
            assert.equal(base.definition.vitality.resistance, 30);
        }
});
