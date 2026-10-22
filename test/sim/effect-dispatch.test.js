import { invincible, healFree } from "../../dist/content/tactical/effects/protection.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { unit, workFor, attach, request, damageEffect, healingEffect, setSelf, stateOf } from "../helpers/vitality.js";
import { getUnit, transitionUnit } from "../../dist/core/tactical/battle/state.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import * as damage from "../../dist/core/tactical/battle/damage/hook.js";
import * as healing from "../../dist/core/tactical/battle/healing/hook.js";
import { calculateDamage } from "../../dist/core/tactical/battle/damage/calculate.js";
import { applyDamage } from "../../dist/core/tactical/battle/damage/apply.js";
import { calculateHealing } from "../../dist/core/tactical/battle/healing/calculate.js";
import { applyHealing } from "../../dist/core/tactical/battle/healing/apply.js";

const settle = (battle, input) => applyDamage(input, calculateDamage(battle, input));
const damageHook = (id, stage, invoke, priority = 0, accepts = () => true) => ({ id, stage, priority, accepts, invoke });
const healingHook = (id, stage, invoke, priority = 0, accepts = () => true) => ({ id, stage, priority, accepts, invoke });
const healRequest = (power = 10, overrides = {}) => ({ source: { id: 1 }, target: { id: 2 }, parameters: { power, multiplier: 1 }, ...overrides });
const heal = (battle, input) => applyHealing(input, calculateHealing(battle, input));
const withDamage = (unit, ...entries) => ({ ...unit, vitality: entries.reduce((state, entry) => damage.setHook(state, entry), unit.vitality) });

test("hook dispatch checks each Effect against its current status immediately before invocation", () => {
    const calls = [];
    let enableSecond = false;
    const first = damageEffect("first", {}, [{
        stage: "receiving", priority: 10,
        invoke(state, _context, _self, pending) {
            calls.push("first");
            return { state: effects.setEnabled(state, { host: { id: 2 }, id: 1 }, enableSecond), value: pending };
        },
    }]);
    const second = damageEffect("second", {}, [{ stage: "receiving", invoke(state, _context, _self, pending) {
        calls.push("second"); return { state, value: pending };
    } }]);
    const target = attach(attach(unit(2), first), second);
    let battle = workFor(unit(1), target);
    battle = settle(battle, request()).state;
    assert.deepEqual(calls, ["first"]);
    enableSecond = true;
    battle = settle(battle, request()).state;
    assert.deepEqual(calls, ["first", "first", "second"]);
    assert.equal(target.effects.values().toArray()[1].status, "ACTIVE");
});

test("finishing a pending Effect removes its Hook before that candidate can execute", () => {
    const calls = [];
    const first = damageEffect("end-second", {}, [{ stage: "receiving", priority: 10,
        invoke(state, _context, _self, pending) {
            calls.push("first");
            return { state: effects.end(state, { host: { id: 2 }, id: 1 }, "EXPLICIT"), value: pending };
        },
    }]);
    const second = damageEffect("ended", {}, [{ stage: "receiving", invoke(state, _context, _self, pending) {
        calls.push("second"); return { state, value: pending };
    } }], { onEnd(state) { calls.push("end"); return state; } });
    const result = settle(workFor(unit(1), attach(attach(unit(2), first), second)), request());
    assert.deepEqual(calls, ["first", "end"]);
    assert.equal(getUnit(result.state, 2).effects.values().toArray().length, 1);
    assert.equal(getUnit(result.state, 2).vitality.damageHooks.length, 1);
});

test("selected Hook IDs use current replacements while nested damage selects its own latest candidates", () => {
    const calls = [];
    let nested = false;
    let changed = false;
    const multiply = factor => (state, _context, input) => ({ state, value: { ...input, attack: { ...input.attack, power: input.attack.power * factor } } });
    const replacement = damageHook("second", "sourceFormula", (state, context, input) => {
        calls.push("replacement"); return multiply(2)(state, context, input);
    });
    const added = damageHook("third", "sourceFormula", (state, context, input) => {
        calls.push("added"); return multiply(3)(state, context, input);
    });
    const first = damageHook("first", "sourceFormula", (state, _context, input) => {
        calls.push(nested ? "nested-first" : "first");
        if (!changed) {
            changed = true;
            state = transitionUnit(state, 1, value => withDamage({ ...value, vitality: damage.removeHook(value.vitality, "second") }, replacement, added));
            nested = true;
            state = settle(state, request(10)).state;
            nested = false;
        }
        return { state, value: input };
    }, 10);
    const old = damageHook("second", "sourceFormula", (state, _context, input) => { calls.push("removed"); return { state, value: input }; });
    const source = withDamage(unit(1, { hp: 1000 }), first, old);
    const initial = settle(workFor(source, unit(2, { hp: 1000 })), request(100));
    assert.deepEqual(calls, ["first", "nested-first", "replacement", "added", "replacement"]);
    assert.equal(initial.value.application.hpLoss, 200);
    assert.equal(getUnit(initial.state, 2).vitality.hp, 740);
    assert.deepEqual(source.vitality.damageHooks, [first, old]);
    calls.length = 0;
    const later = settle(initial.state, request(100));
    assert.equal(later.value.application.hpLoss, 600);
    assert.deepEqual(calls, ["first", "replacement", "added"]);
});

test("nested healing independently selects its latest receiver candidates", () => {
    const calls = [];
    let changed = false;
    const originalHealing = healingHook("original", "receiving", (state, _context, pending) => { calls.push("original-healing"); return { state, value: pending }; });
    const newHealing = healingHook("new", "receiving", (state, _context, pending) => { calls.push("new-healing"); return { state, value: pending }; });
    const first = damageHook("damage", "receiving", (state, _context, pending) => {
        calls.push("damage");
        if (!changed) {
            changed = true;
            state = transitionUnit(state, 2, value => ({ ...value, vitality: healing.setHook(healing.removeHook(value.vitality, "original"), newHealing) }));
            state = heal(state, healRequest()).state;
        }
        return { state, value: pending };
    });
    const value = withDamage(unit(2, { hp: 500, maxHp: 1000 }), first);
    const receiver = { ...value, vitality: healing.setHook(value.vitality, originalHealing) };
    let battle = settle(workFor(unit(1), receiver), request(100)).state;
    assert.deepEqual(calls, ["damage", "new-healing"]);
    assert.equal(getUnit(battle, 2).vitality.hp, 410);
    battle = heal(battle, healRequest()).state;
    assert.deepEqual(calls, ["damage", "new-healing", "new-healing"]);
    assert.equal(getUnit(battle, 2).vitality.hp, 420);
});

test("nested damage admits hooks registered before its own dispatch", () => {
    const calls = [];
    let changed = false;
    const late = damageHook("late", "receiving", (state, _context, pending) => { calls.push("late-damage"); return { state, value: pending }; });
    const first = healingHook("healing", "receiving", (state, _context, pending) => {
        calls.push("healing");
        if (!changed) {
            changed = true;
            state = transitionUnit(state, 2, value => withDamage(value, late));
            state = settle(state, request(10)).state;
        }
        return { state, value: pending };
    });
    const value = unit(2, { hp: 500, maxHp: 1000 });
    let battle = workFor(unit(1), { ...value, vitality: healing.setHook(value.vitality, first) });
    battle = heal(battle, healRequest(20)).state;
    assert.deepEqual(calls, ["healing", "late-damage"]);
    assert.equal(getUnit(battle, 2).vitality.hp, 510);
    battle = settle(battle, request(10)).state;
    assert.deepEqual(calls, ["healing", "late-damage", "late-damage"]);
});

test("cancellation remains visible to later Receiving Hooks and Completed", () => {
    const calls = [];
    const cancel = damageHook("cancel", "receiving", (state, _context, pending) => {
        calls.push("cancel");
        return { state, value: { ...pending, cancellation: { reason: "BLOCKED" } } };
    }, 10);
    const after = damageHook("after", "receiving", (state, _context, pending) => {
        calls.push(pending.cancellation.reason); return { state, value: pending };
    });
    const completed = damageHook("completed", "completed", (state, { outcome }) => {
        calls.push(`completed:${outcome.kind}:${outcome.received.amount}`); return { state, value: undefined };
    });
    const result = settle(workFor(unit(1), withDamage(unit(2), cancel, after, completed)), request());
    assert.equal(result.value.kind, "CANCELLED");
    assert.deepEqual(calls, ["cancel", "BLOCKED", "completed:CANCELLED:100"]);
});

test("Completed enumerates each participant once when source and target are the same Unit", () => {
    const calls = [];
    const first = damageHook("first", "completed", state => { calls.push("first"); return { state, value: undefined }; }, 10);
    const second = damageHook("second", "completed", state => { calls.push("second"); return { state, value: undefined }; });
    settle(workFor(withDamage(unit(1), first, second)), request(10, { target: { id: 1 } }));
    assert.deepEqual(calls, ["first", "second"]);
});

test("nested operations read changed Effect state and inherit the current battle tick", () => {
    const uses = [];
    const content = damageEffect("once", { ready: true }, [{ stage: "receiving", invoke(state, context, self, pending) {
        uses.push(self.data.ready);
        if (self.data.ready) {
            state = setSelf(state, context, self, { ready: false });
            state = heal(state, healRequest(10)).state;
            state = settle(state, request(5)).state;
        }
        return { state, value: pending };
    } }]);
    const battle = { ...workFor(unit(1), attach(unit(2, { hp: 500, maxHp: 1000 }), content)), tick: 42 };
    const result = settle(battle, request(100));
    assert.deepEqual(uses, [true, false]);
    assert.deepEqual(stateOf(result.state, 2, content), { ready: false });
    assert.equal(getUnit(result.state, 2).vitality.hp, 405);
    assert.deepEqual(result.state.events.map(event => [event.type, event.amount, event.tick]), [
        ["HEAL", 10, 42], ["DAMAGE", 5, 42], ["DAMAGE", 100, 42],
    ]);
});

test("invincibility rejects Receiving while preserving the Completed outcome", () => {
    const calls = [];
    const content = damageEffect("observe", {}, [
        { stage: "receivingStarted", invoke(state) { calls.push("started"); return { state, value: undefined }; } },
        { stage: "receiving", invoke(state, _context, _self, pending) { calls.push("receiving"); return { state, value: pending }; } },
        { stage: "completed", invoke(state, { outcome }) { calls.push(outcome.kind); return { state, value: undefined }; } },
    ]);
    const result = settle(workFor(unit(1), attach(attach(unit(2), invincible), content)), request());
    assert.deepEqual(result.value, { kind: "REJECTED" });
    assert.deepEqual(calls, ["REJECTED"]);
});

test("healing hooks resolve numeric output and Receiving before notifying each participant", () => {
    const calls = [];
    const source = healingEffect("healing-output", {}, [
        { stage: "output", invoke(state, _context, _self, amount) {
            calls.push("output"); return { state, value: amount * 2 };
        } },
        { stage: "completed", invoke(state, { outcome }) {
            calls.push(`source:${outcome.application.hpGain}`); return { state, value: undefined };
        } },
    ]);
    const target = healingEffect("healing-receiving", {}, [
        { stage: "receiving", invoke(state, _context, _self, pending) {
            calls.push("receiving"); return { state, value: { ...pending, amount: pending.amount + 5 } };
        } },
        { stage: "completed", invoke(state, { outcome }) {
            calls.push(`target:${outcome.application.hpGain}`); return { state, value: undefined };
        } },
    ]);
    const result = heal(workFor(attach(unit(1), source), attach(unit(2, { hp: 990, maxHp: 1000 }), target)), healRequest(10));
    assert.equal(result.value.received.amount, 25);
    assert.equal(result.value.application.hpGain, 10);
    assert.deepEqual(calls, ["output", "receiving", "target:10", "source:10"]);
    assert.equal(getUnit(result.state, 2).vitality.hp, 1000);
});

test("healing cancellation stays visible to later Receiving Hooks and Completed", () => {
    const calls = [];
    const observer = healingEffect("observe-healing", {}, [
        { stage: "receiving", priority: 10, invoke(state, _context, _self, pending) {
            return { state, value: { ...pending, cancellation: { reason: "BLOCKED" } } };
        } },
        { stage: "receiving", invoke(state, _context, _self, pending) {
            calls.push(pending.cancellation.reason); return { state, value: pending };
        } },
        { stage: "completed", invoke(state, { outcome }) {
            calls.push(`completed:${outcome.kind}:${outcome.received.amount}`); return { state, value: undefined };
        } },
    ]);
    const result = heal(workFor(unit(1), attach(unit(2, { hp: 500, maxHp: 1000 }), observer)), healRequest(10));
    assert.equal(result.value.kind, "CANCELLED");
    assert.equal(getUnit(result.state, 2).vitality.hp, 500);
    assert.deepEqual(calls, ["BLOCKED", "completed:CANCELLED:10"]);
});

test("healing an explicitly referenced heal-free Unit uses the ordinary pipeline", () => {
    const calls = [];
    const observer = healingEffect("observe-heal-free", {}, [
        { stage: "receiving", invoke(state, _context, _self, pending) {
            calls.push("receiving"); return { state, value: pending };
        } },
        { stage: "completed", invoke(state, { outcome }) {
            calls.push(`completed:${outcome.application.hpGain}`); return { state, value: undefined };
        } },
    ]);
    const target = attach(attach(unit(2, { hp: 500, maxHp: 1000 }), healFree), observer);
    const result = heal(workFor(unit(1), target), healRequest(10));
    assert.equal(result.value.kind, "APPLIED");
    assert.equal(getUnit(result.state, 2).vitality.hp, 510);
    assert.deepEqual(calls, ["receiving", "completed:10"]);
});
