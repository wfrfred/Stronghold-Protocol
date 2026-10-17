import assert from "node:assert/strict";
import { test } from "node:test";
import { unit, workFor, attach, healingEffect, damage } from "../helpers/vitality.js";
import { calculateHealing } from "../../dist/core/tactical/battle/healing/calculate.js";
import { applyHealing } from "../../dist/core/tactical/battle/healing/apply.js";
import { getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { leave } from "../../dist/core/tactical/battle/execution/unit.js";
import { setMaxHpContribution } from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import * as attribute from "../../dist/core/tactical/unit/contribution/attribute.js";

const request = (power = 20, overrides = {}) => ({
    source: { id: 1 }, target: { id: 2 }, parameters: { power, multiplier: 1 }, ...overrides,
});
const heal = (battle, input = request()) => applyHealing(input, calculateHealing(battle, input));
const hp = (battle, id = 2) => getUnit(battle, id)?.vitality.hp;
const entry = (stage, invoke, priority = 0) => ({ stage, invoke, priority });
const change = (battle, id, transition) => updateUnit(battle, transition(getUnit(battle, id)));

function damaging(battle, power, target = { id: 2 }) {
    return damage(battle, {
        source: null, target, parameters: { type: "TRUE", attack: { power, multiplier: 1, addition: 0 } },
    });
}

test("healing pipeline: Calculate threads Parameters and numeric Output without restoring HP", () => {
    const calls = [];
    const input = request(10);
    const source = attach(unit(1), healingEffect("source", {}, [
        entry("sourceFormula", (state, context, _self, current) => {
            assert.equal(context.parameters, input.parameters);
            calls.push("sourceFormula"); return { state, value: { ...current, multiplier: 2 } };
        }),
        entry("output", (state, { request: original }, _self, amount) => {
            assert.equal(original, input);
            calls.push(["output", amount]); return { state, value: amount + 3 };
        }),
    ]));
    const target = attach(unit(2, { hp: 50, maxHp: 100 }), healingEffect("target", {}, [
        entry("targetFormula", (state, context, _self, current) => {
            assert.equal(context.parameters, input.parameters);
            calls.push(["targetFormula", current.multiplier]);
            return { state, value: { ...current, power: current.power + 5 } };
        }),
        entry("receiving", () => assert.fail("Calculate must not begin Receiving")),
    ]));
    const calculated = calculateHealing(workFor(source, target), input);
    assert.deepEqual(calculated.value, { amount: 33 });
    assert.equal(hp(calculated.state), 50);
    assert.deepEqual(input.parameters, { power: 10, multiplier: 1 });
    assert.deepEqual(calls, ["sourceFormula", ["targetFormula", 2], ["output", 30]]);
});

test("healing pipeline: Receiving and notifications follow committed HP facts in participant order", () => {
    const calls = [];
    const observer = (id) => healingEffect(id, {}, [
        entry("hpApplied", (state, context) => {
            calls.push([`${id}:hpApplied`, hp(state), context.received.amount, context.application.hpGain]);
            return { state, value: undefined };
        }),
        entry("completed", (state, { outcome }) => {
            calls.push([`${id}:completed`, hp(state), outcome.kind, outcome.application.hpGain]);
            return { state, value: undefined };
        }),
    ]);
    const receiver = healingEffect("receiving", {}, [
        entry("receivingStarted", (state, { calculated }) => {
            calls.push(["started", hp(state), calculated.amount]); return { state, value: undefined };
        }),
        entry("receiving", (state, _context, _self, pending) => {
            calls.push(["receiving", hp(state), pending.amount]);
            return { state, value: { ...pending, amount: pending.amount + 5 } };
        }),
    ]);
    const initial = workFor(attach(unit(1), observer("source")), attach(attach(unit(2, { hp: 80, maxHp: 100 }), observer("target")), receiver));
    const result = heal(initial);
    assert.deepEqual(result.value.application, { hpBefore: 80, hpAfter: 100, hpGain: 20 });
    assert.deepEqual(calls, [
        ["started", 80, 20], ["receiving", 80, 20], ["target:hpApplied", 100, 25, 20],
        ["source:hpApplied", 100, 25, 20], ["target:completed", 100, "APPLIED", 20], ["source:completed", 100, "APPLIED", 20],
    ]);
    assert.equal(hp(initial), 80);
});

test("healing pipeline: full HP and zero initial healing retain Receiving and APPLIED notifications", () => {
    for (const [initialHp, power] of [[100, 20], [50, 0], [50, -20]]) {
        const calls = [];
        const observe = healingEffect("observe-zero", {}, [
            entry("receivingStarted", (state, { calculated }) => { calls.push(["started", calculated.amount]); return { state, value: undefined }; }),
            entry("receiving", (state, _context, _self, pending) => { calls.push("receiving"); return { state, value: pending }; }),
            entry("hpApplied", (state, { application }) => { calls.push(["hpApplied", application.hpGain]); return { state, value: undefined }; }),
            entry("completed", (state, { outcome }) => { calls.push(outcome.kind); return { state, value: undefined }; }),
        ]);
        const result = heal(workFor(unit(1), attach(unit(2, { hp: initialHp, maxHp: 100 }), observe)), request(power));
        assert.equal(result.value.kind, "APPLIED");
        assert.equal(result.value.application.hpGain, 0);
        assert.equal(hp(result.state), initialHp);
        assert.deepEqual(calls, [["started", Math.max(0, power)], "receiving", ["hpApplied", 0], "APPLIED"]);
    }
});

test("healing pipeline: Receiving damage and a nested heal determine the latest HP baseline", () => {
    let nested = false;
    const before = healingEffect("before", {}, [entry("receiving", (state, _context, _self, pending) => {
        if (!nested) {
            nested = true;
            state = damaging(state, 30).state;
            state = heal(state, request(10, { source: null })).state;
        }
        return { state, value: pending };
    })]);
    const result = heal(workFor(unit(1), attach(unit(2, { hp: 70, maxHp: 100 }), before)), request(100));
    assert.deepEqual(result.value.application, { hpBefore: 50, hpAfter: 100, hpGain: 50 });
    assert.equal(hp(result.state), 100);
    assert.deepEqual(result.state.events.map(({ type, amount }) => [type, amount]), [["DAMAGE", 30], ["HEAL", 10], ["HEAL", 50]]);
});

test("healing pipeline: Receiving MaxHP changes are applied before calculating actual restoration", () => {
    const resize = healingEffect("resize", {}, [entry("receiving", (state, _context, _self, pending) => ({
        state: change(state, 2, value => ({
            ...value,
            vitality: setMaxHpContribution(value.definition.vitality, value.vitality, {
                id: "double-hp", value: [attribute.create({ multiplier: 1 })],
            }),
        })), value: pending,
    }))]);
    const result = heal(workFor(unit(1), attach(unit(2, { hp: 50, maxHp: 100 }), resize)), request(150));
    assert.deepEqual(result.value.application, { hpBefore: 100, hpAfter: 200, hpGain: 100 });
    assert.equal(hp(result.state), 200);
});

test("healing pipeline: HP Applied reactions change current HP without rewriting restoration facts", () => {
    const observed = [];
    const reaction = healingEffect("reaction", {}, [
        entry("hpApplied", (state, context) => {
            observed.push(context.application);
            return { state: damaging(state, 25).state, value: undefined };
        }),
        entry("completed", (state, { outcome }) => {
            observed.push(outcome.application); assert.equal(hp(state), 45); return { state, value: undefined };
        }),
    ]);
    const result = heal(workFor(unit(1), attach(unit(2, { hp: 50, maxHp: 100 }), reaction)));
    assert.deepEqual(result.value.application, { hpBefore: 50, hpAfter: 70, hpGain: 20 });
    assert.equal(observed[0], result.value.application);
    assert.equal(observed[1], result.value.application);
    assert.equal(hp(result.state), 45);
});

test("healing pipeline: source departure skips its later Hooks while sampled healing still applies", () => {
    const source = attach(unit(1), healingEffect("source", {}, [
        entry("sourceFormula", (state, _context, _self, current) => ({ state: leave(state, 1, "DEATH"), value: { ...current, multiplier: 2 } })),
        entry("output", () => assert.fail("departed source cannot run Output")),
        entry("hpApplied", () => assert.fail("departed source cannot observe HP Applied")),
        entry("completed", () => assert.fail("departed source cannot observe Completed")),
    ]));
    const result = heal(workFor(source, unit(2, { hp: 20, maxHp: 100 })));
    assert.equal(getUnit(result.state, 1), undefined);
    assert.equal(result.value.application.hpGain, 40);
    assert.equal(hp(result.state), 60);
});

test("healing pipeline: a LEAVING source cannot run its Hooks but its previously sampled healing remains valid", () => {
    const source = attach(unit(1), healingEffect("leaving-source", {}, [
        entry("sourceFormula", () => assert.fail("LEAVING source cannot run Formula")),
        entry("output", () => assert.fail("LEAVING source cannot run Output")),
        entry("completed", () => assert.fail("LEAVING source cannot observe Completed")),
    ]));
    const result = heal(workFor({ ...source, lifecycle: "LEAVING" }, unit(2, { hp: 20, maxHp: 100 })));
    assert.equal(result.value.application.hpGain, 20);
    assert.equal(hp(result.state), 40);
});

test("healing pipeline: missing, LEAVING, and zero HP targets reject ordinary healing", () => {
    const unavailable = [undefined, { ...unit(2, { hp: 20, maxHp: 100 }), lifecycle: "LEAVING" }, unit(2, { hp: 0, maxHp: 100 })];
    for (const target of unavailable) {
        const initial = target === undefined ? workFor(unit(1)) : workFor(unit(1), target);
        const calculated = calculateHealing(initial, request());
        assert.equal(calculated.value, undefined);
        const result = applyHealing(request(), calculated);
        assert.deepEqual(result.value, { kind: "REJECTED" });
        assert.equal(result.state, initial);
        assert.deepEqual(result.state.events, []);
    }
});

test("healing pipeline: Apply rechecks target eligibility against the carried BattleState", () => {
    const input = request();
    const initial = workFor(unit(1), unit(2, { hp: 50, maxHp: 100 }));
    const calculated = calculateHealing(initial, input);
    const state = leave(calculated.state, 2, "DEATH");
    const result = applyHealing(input, { ...calculated, state });
    assert.deepEqual(result.value, { kind: "REJECTED" });
    assert.equal(getUnit(result.state, 2), undefined);
});

test("healing pipeline: nested lethal damage makes restoration unavailable without resurrection", () => {
    const removal = healingEffect("lethal", {}, [entry("receiving", (state, _context, _self, pending) => ({
        state: damaging(state, 100).state, value: pending,
    }))]);
    const result = heal(workFor(unit(1), attach(unit(2, { hp: 20, maxHp: 100 }), removal)));
    assert.equal(result.value.kind, "UNAVAILABLE");
    assert.equal(result.value.received.amount, 20);
    assert.equal(getUnit(result.state, 2), undefined);
    assert.equal(result.state.removedUnits.length, 1);
    assert.equal(result.state.events.filter(({ type }) => type === "HEAL").length, 0);
});

test("healing pipeline: cancellation does not stop later responses and stays observable after removal", () => {
    const seen = [];
    const source = attach(unit(1), healingEffect("source", {}, [entry("completed", (state, context) => {
        seen.push(context.outcome);
        assert.equal(getUnit(state, 2), undefined);
        return { state, value: undefined };
    })]));
    const receiver = healingEffect("cancel", {}, [
        entry("receiving", (state, _context, _self, pending) => ({ state, value: { ...pending, cancellation: { reason: "BLOCKED" } } }), 100),
        entry("receiving", (state, _context, _self, pending) => {
            seen.push(pending.cancellation.reason);
            return { state: leave(state, 2, "DEATH"), value: pending };
        }),
        entry("hpApplied", () => assert.fail("cancelled healing cannot apply HP")),
    ]);
    const result = heal(workFor(source, attach(unit(2, { hp: 50, maxHp: 100 }), receiver)));
    assert.equal(result.value.kind, "CANCELLED");
    assert.deepEqual(seen, ["BLOCKED", result.value]);
    const event = result.state.events.find(({ type }) => type === "HEAL");
    assert.equal(event.amount, 0);
    assert.equal(event.receivedAmount, 20);
    assert.equal(event.cancellation.reason, "BLOCKED");
    assert.equal(event.hp, null);
});

test("healing pipeline: self-healing notifies a single participant once per notification node", () => {
    const calls = [];
    const observer = healingEffect("self", {}, [
        entry("hpApplied", (state) => { calls.push("hpApplied"); return { state, value: undefined }; }),
        entry("completed", (state) => { calls.push("completed"); return { state, value: undefined }; }),
    ]);
    const result = heal(workFor(attach(unit(1, { hp: 50, maxHp: 100 }), observer)), request(20, { target: { id: 1 } }));
    assert.deepEqual(calls, ["hpApplied", "completed"]);
    assert.equal(hp(result.state, 1), 70);
});
