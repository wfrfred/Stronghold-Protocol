import { invincible } from "../../dist/content/tactical/effects/protection.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    unit, workFor, attach, request, parameters, damageEffect, barrier, stateOf, view,
} from "../helpers/vitality.js";
import { contributionEffect } from "../helpers/effects.js";
import * as modifier from "../../dist/core/tactical/unit/contribution/attribute.js";
import { setAttackContribution, removeAttackContribution } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { setResistanceContribution, removeResistanceContribution } from "../../dist/core/tactical/unit/capability/defense/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { calculateDamage } from "../../dist/core/tactical/battle/damage/calculate.js";
import { applyDamage } from "../../dist/core/tactical/battle/damage/apply.js";
import { healing } from "../helpers/vitality.js";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import { retireCombatUnit } from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";

const settle = (battle, input) => applyDamage(input, calculateDamage(battle, input));
const rule = (id, stage, transform, priority = 0, properties = {}) => damageEffect(id, {}, [{
    stage, priority,
    invoke: (state, context, _self, value) => ({ state, value: transform(context, value) }),
}], properties);
const scaleAttack = (factor) => (_context, value) => ({
    ...value, attack: { ...value.attack, multiplier: value.attack.multiplier * factor },
});
const scaleReceived = (factor) => (_context, value) => ({ ...value, amount: value.amount * factor });
const trueRequest = (power, overrides = {}) => request(power, { parameters: parameters(power, "TRUE"), ...overrides });
const heal = (state, targetUnitId, power) => healing(state, {
    source: null, target: { id: targetUnitId }, parameters: { power, multiplier: 1 },
});

test("damage pipeline: numeric contributions retain four distinct positions and clamp the direct multiplier", () => {
    assert.equal(modifier.apply(100, [
        modifier.create({ addition: 10, multiplier: 0.5, finalAddition: 7, finalScaler: 2 }),
        modifier.create({ addition: 20, multiplier: 0.5, finalAddition: 3, finalScaler: 0.5 }),
    ]), 270);
    assert.equal(modifier.apply(100, [modifier.create({ multiplier: -2, finalAddition: 7, finalScaler: 2 })]), 14);
});

test("damage pipeline: dynamic low HP attack reads current state and stable prior snapshots", () => {
    const lowHp = contributionEffect("low-hp", {}, {
        capability: "offense", set: setAttackContribution, remove: removeAttackContribution,
        dynamic: true,
        value: (_self, { unit }) => unit.vitality.hp < unit.definition.vitality.maxHp / 2
            ? [modifier.create({ multiplier: 1 })] : [],
    });
    const source = attach(unit(1, { hp: 750, maxHp: 1000 }), lowHp);
    let battle = settle(workFor(source, unit(2)), trueRequest(500, { source: { id: 2 }, target: { id: 1 } })).state;
    const damaged = view(battle);
    battle = heal(battle, 1, 400).state;
    assert.equal(resolveAttackPower(1, damaged), 200);
    assert.equal(damaged.getUnit(1).vitality.hp, 250);
    assert.equal(getUnit(battle, 1).vitality.hp, 650);
    assert.equal(resolveAttackPower(1, view(battle)), 100);
    assert.equal(source.vitality.hp, 750);
});

test("damage pipeline: formula parameter replacement and multiplication retain execution order", () => {
    const replace = (_context, value) => ({ ...value, attack: { ...value.attack, multiplier: 3 } });
    for (const [first, second, expected] of [[scaleAttack(2), replace, 300], [replace, scaleAttack(2), 600]]) {
        const source = attach(unit(1), rule("attack-scale", "sourceFormula", (context, input) => second(context, first(context, input))));
        const input = request(100);
        const calculated = calculateDamage(workFor(source, unit(2)), input);
        assert.equal(calculated.value.amount, expected);
        assert.equal(getUnit(calculated.state, 2).vitality.hp, 5000);
        assert.equal(applyDamage(input, calculated).value.application.hpLoss, expected);
    }
});

test("damage pipeline: fixed penetration precedes proportional penetration", () => {
    for (const [type, defense, resistance, expected] of [
        ["PHYSICAL", 200, 0, 950], ["ARTS", 0, 80, 650], ["ARTS", 0, 150, 550],
    ]) {
        const input = request(1000, { parameters: parameters(1000, type, { fixed: type === "PHYSICAL" ? 100 : 10, proportional: 0.5 }) });
        const calculated = calculateDamage(workFor(unit(1), unit(2, { defense, resistance })), input);
        assert.equal(calculated.value.amount, expected);
    }
});

test("damage pipeline: resistance contributions clamp before penetration", () => {
    const effect = contributionEffect("resistance", {}, {
        capability: "defense", set: setResistanceContribution, remove: removeResistanceContribution,
        value: () => [modifier.create({ finalAddition: 70 })],
    });
    const target = attach(unit(2, { resistance: 80 }), effect);
    const input = request(1000, { parameters: parameters(1000, "ARTS", { fixed: 10, proportional: 0.5 }) });
    const calculated = calculateDamage(workFor(unit(1), target), input);
    assert.equal(calculated.value.amount, 550);
    const result = applyDamage(input, calculated);
    assert.equal(getUnit(result.state, 2).vitality.hp, 4450);
    assert.equal(getUnit(result.state, 2).definition.defense.resistance, 80);
});

test("damage pipeline: barrier before doubling takes 400 HP; doubling before barrier takes 900", () => {
    for (const [barrierPriority, scalePriority, expected] of [[100, 0, 400], [0, 100, 900]]) {
        const shield = barrier("barrier", 500, barrierPriority);
        const target = attach(attach(unit(2), shield), rule("fragile", "receiving", scaleReceived(2), scalePriority));
        const result = settle(workFor(unit(1), target), request(700));
        assert.equal(result.value.kind, "APPLIED");
        assert.equal(result.value.received.amount, expected);
        assert.equal(result.value.application.hpLoss, expected);
        assert.equal(stateOf(result.state, 2, shield).remainingAmount, 0);
        assert.equal(target.effects.values()[0].data.remainingAmount, 500);
    }
});

test("damage pipeline: reduction and complete absorption consume barrier budget without cancellation", () => {
    const shield = barrier("barrier", 800);
    const target = attach(attach(unit(2), shield), rule("reduction", "receiving", (_context, pending) => ({ ...pending, amount: pending.amount - 100 }), 100));
    const result = settle(workFor(unit(1), target), request(700));
    assert.equal(result.value.kind, "APPLIED");
    assert.equal(result.value.received.amount, 0);
    assert.equal(result.value.received.cancellation, null);
    assert.equal(result.value.application.hpLoss, 0);
    assert.equal(stateOf(result.state, 2, shield).remainingAmount, 200);
    assert.equal(target.effects.values()[0].data.remainingAmount, 800);
});

test("damage pipeline: Effect overwriting gates hooks while retaining suppressed instances", () => {
    const weak = rule("weak", "receiving", scaleReceived(2), 0, { group: { id: "fragile", priority: 2 } });
    const strong = rule("strong", "receiving", scaleReceived(3), 0, { group: { id: "fragile", priority: 3 } });
    const battle = workFor(unit(1), attach(attach(unit(2), weak), strong));
    assert.equal(settle(battle, request(100)).value.application.hpLoss, 300);
    assert.deepEqual(getUnit(battle, 2).effects.values().map((self) => self.status), ["INACTIVE", "ACTIVE"]);
});

test("damage pipeline: Contribution groups and Effect groups have separate responsibilities", () => {
    const attack = contributionEffect("attack", {}, {
        capability: "offense", set: setAttackContribution, remove: removeAttackContribution,
        group: { id: "shared", priority: 100 }, value: () => [modifier.create({ multiplier: 1 })],
    });
    const weak = rule("weak", "receiving", scaleReceived(2), 0, { group: { id: "shared", priority: 1 } });
    const strong = rule("strong", "receiving", scaleReceived(3), 0, { group: { id: "shared", priority: 2 } });
    const battle = workFor(unit(1), attach(attach(attach(unit(2), attack), weak), strong));
    assert.equal(resolveAttackPower(2, view(battle)), 200);
    assert.equal(settle(battle, request(100)).value.application.hpLoss, 300);
});

test("damage pipeline: final formula type reaches output and receiving while Request stays fixed", () => {
    const seen = [];
    const source = attach(attach(unit(1), rule("conversion", "sourceFormula", (_context, input) => ({
        type: "ARTS", attack: input.attack, penetration: { fixed: 0, proportional: 0 },
    }))), rule("output", "output", (context, amount) => {
        seen.push([context.request.parameters.type, context.type, amount]);
        return amount * 2;
    }));
    const target = attach(unit(2, { defense: 90, resistance: 50 }), rule("observe", "receiving", (context, pending) => {
        seen.push([context.request.parameters.type, context.calculated.type, pending.amount]);
        return pending;
    }));
    const input = request(100);
    const calculated = calculateDamage(workFor(source, target), input);
    assert.deepEqual(calculated.value, { type: "ARTS", amount: 100 });
    assert.equal(applyDamage(input, calculated).value.application.hpLoss, 100);
    assert.equal(input.parameters.type, "PHYSICAL");
    assert.deepEqual(seen, [["PHYSICAL", "ARTS", 50], ["PHYSICAL", "ARTS", 100]]);
});

test("damage pipeline: priority precedes registration order with stable equal-priority ordering", () => {
    for (const reverse of [false, true]) {
        const first = rule("first", "receiving", (_context, pending) => ({ ...pending, amount: (pending.amount - 100) * 3 }));
        const last = rule("last", "receiving", scaleReceived(2));
        let target = unit(2);
        for (const content of reverse ? [last, first] : [first, last]) target = attach(target, content);
        target = attach(target, rule("high", "receiving", (_context, pending) => ({ ...pending, amount: pending.amount - 50 }), 1000));
        assert.equal(settle(workFor(unit(1), target), request(300)).value.application.hpLoss, reverse ? 1200 : 900);
    }
});

test("damage pipeline: missing target rejects calculation and reception without changing state", () => {
    const battle = workFor(unit(1));
    const input = request(100);
    const calculated = calculateDamage(battle, input);
    assert.equal(calculated.value, undefined);
    const result = applyDamage(input, calculated);
    assert.deepEqual(result.value, { kind: "REJECTED" });
    assert.equal(result.state, battle);
});

test("damage pipeline: invincibility rejects reception after calculation and preserves barrier resources", () => {
    const shield = barrier("shield", 500);
    const observations = [];
    const source = attach(unit(1), damageEffect("observer", {}, [
        { stage: "output", invoke: (state, _context, _self, amount) => ({ state, value: amount * 2 }) },
        { stage: "completed", invoke(state, context) { observations.push(context); return { state, value: undefined }; } },
    ]));
    const target = attach(attach(unit(2), invincible), shield);
    const input = request(700);
    const calculated = calculateDamage(workFor(source, target), input);
    assert.equal(calculated.value.amount, 1400);
    const result = applyDamage(input, calculated);
    assert.deepEqual(result.value, { kind: "REJECTED" });
    assert.equal(stateOf(result.state, 2, shield).remainingAmount, 500);
    assert.equal(observations[0].outcome, result.value);
});

test("damage pipeline: cancelled damage skips later barrier consumption but still permits reflection", () => {
    const shield = barrier("shield", 500);
    const evade = rule("evade", "receiving", (_context, pending) => ({ ...pending, cancellation: { reason: "EVADED" } }), 100);
    const reflection = damageEffect("reflect", {}, [{
        stage: "receiving", priority: -100,
        invoke(state, context, _self, pending) {
            state = settle(state, trueRequest(20, { source: context.request.target, target: context.request.source })).state;
            return { state, value: pending };
        },
    }]);
    const target = attach(attach(attach(unit(2, { hp: 1000 }), evade), shield), reflection);
    const result = settle(workFor(unit(1, { hp: 1000 }), target), request(100));
    assert.equal(result.value.kind, "CANCELLED");
    assert.equal(result.value.received.amount, 100);
    assert.equal(result.value.received.cancellation.reason, "EVADED");
    assert.equal(stateOf(result.state, 2, shield).remainingAmount, 500);
    assert.equal(getUnit(result.state, 1).vitality.hp, 980);
    assert.equal(getUnit(result.state, 2).vitality.hp, 1000);
});

test("damage pipeline: reflection can kill the source before the outer damage is applied", () => {
    const reflection = damageEffect("reflect", {}, [{
        stage: "receiving",
        invoke(state, context, _self, pending) {
            state = settle(state, trueRequest(20, { source: context.request.target, target: context.request.source })).state;
            return { state, value: pending };
        },
    }]);
    const result = settle(workFor(unit(1, { hp: 10 }), attach(unit(2, { hp: 1000 }), reflection)), request(100));
    assert.equal(result.value.kind, "APPLIED");
    assert.equal(result.value.application.hpLoss, 100);
    assert.equal(getUnit(result.state, 1), undefined);
    assert.equal(getUnit(result.state, 2).vitality.hp, 900);
    assert.deepEqual(result.state.removedUnits.map(({ unitId, reason }) => [unitId, reason]), [[1, "DEATH"]]);
});

test("damage pipeline: before-damage healing sets the HP baseline and after-damage healing does not alter its report", () => {
    const healing = damageEffect("healing", {}, [
        { stage: "receiving", invoke(state, _context, _self, pending) { return { state: heal(state, 2, 100).state, value: pending }; } },
        { stage: "hpApplied", invoke(state) { return { state: heal(state, 2, 30).state, value: undefined }; } },
    ]);
    const result = settle(workFor(unit(1), attach(unit(2, { hp: 100, maxHp: 300 }), healing)), trueRequest(150));
    assert.equal(getUnit(result.state, 2).vitality.hp, 80);
    assert.deepEqual(result.value.application, { hpBefore: 200, hpAfter: 50, hpLoss: 150 });
});

test("damage pipeline: nested removal makes the outer application unavailable without duplicating death", () => {
    const removal = damageEffect("removal", {}, [{
        stage: "receiving", invoke(state, _context, _self, pending) {
            return { state: retireCombatUnit(state, 2), value: pending };
        },
    }]);
    const result = settle(workFor(unit(1), attach(unit(2), removal)), request(100));
    assert.equal(result.value.kind, "UNAVAILABLE");
    assert.equal(result.value.received.amount, 100);
    assert.equal(getUnit(result.state, 2), undefined);
    assert.equal(result.state.removedUnits.length, 1);
});

test("damage pipeline: cancellation remains observable when a later hook removes the receiver", () => {
    const cancellation = rule("cancel", "receiving", (_context, pending) => ({
        ...pending, cancellation: { reason: "BLOCKED" },
    }), 100);
    const removal = damageEffect("removal", {}, [{
        stage: "receiving", invoke(state, _context, _self, pending) {
            return { state: retireCombatUnit(state, 2), value: pending };
        },
    }]);
    const target = attach(attach(unit(2), cancellation), removal);
    const result = settle(workFor(unit(1), target), request(100));
    assert.equal(result.value.kind, "CANCELLED");
    assert.equal(getUnit(result.state, 2), undefined);
    const event = result.state.events.find(event => event.type === "DAMAGE");
    assert.equal(event.amount, 0);
    assert.equal(event.receivedAmount, 100);
    assert.equal(event.cancellation.reason, "BLOCKED");
    assert.equal(event.hp, null);
});

test("damage pipeline: lethal HP facts precede cleanup, and only surviving observers receive Completed", () => {
    const calls = [];
    let healed;
    const observer = damageEffect("observer", {}, [{
        stage: "completed", invoke(state, context) {
            calls.push(["completed", getUnit(state, 2), context.outcome.received.amount, context.outcome.application.hpLoss]);
            return { state, value: undefined };
        },
    }]);
    const dying = damageEffect("dying", {}, [
        { stage: "hpApplied", invoke(state, context) {
            calls.push(["hpApplied", getUnit(state, 2).vitality.hp, context.received.amount, context.application.hpLoss]);
            const result = heal(state, 2, 100);
            healed = result.value;
            return { state: result.state, value: undefined };
        } },
        { stage: "completed", invoke(state) { calls.push("dead-completed"); return { state, value: undefined }; } },
    ], { onEnd(state) { calls.push("cleanup"); return state; } });
    const result = settle(workFor(attach(unit(1), observer), attach(unit(2, { hp: 40, maxHp: 100 }), dying)), trueRequest(200));
    assert.equal(result.value.kind, "APPLIED");
    assert.deepEqual(result.value.application, { hpBefore: 40, hpAfter: 0, hpLoss: 40 });
    assert.deepEqual(healed, { kind: "REJECTED" });
    assert.deepEqual(calls, [["hpApplied", 0, 200, 40], "cleanup", ["completed", undefined, 200, 40]]);
    assert.equal(getUnit(result.state, 2), undefined);
    assert.equal(result.state.removedUnits.length, 1);
});
