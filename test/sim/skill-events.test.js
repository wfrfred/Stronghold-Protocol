import assert from "node:assert/strict";
import { test } from "node:test";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import * as skills from "../../dist/core/tactical/unit/capability/skill/operations.js";
import * as sp from "../../dist/core/tactical/unit/capability/skill/sp.js";
import { ref as activationRef } from "../../dist/core/tactical/unit/capability/skill/activation.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { fixture, change } from "../helpers/skill.js";
import { definition as effectDefinition } from "../helpers/effects.js";

const hook = (id, invoke) => ({ id, enabled: () => true, invoke });

test("zero-duration activation completes lifecycle callbacks and records each lifecycle event once", () => {
    const trace = [];
    const dependent = effectDefinition("dependent", {}, { onEnd(battle) { trace.push("dependent"); return battle; } });
    const f = fixture({ activation: {
        trigger: "MANUAL", sustain: { type: "TIME", durationTicks: 0 }, initialize: () => ({}),
        onStart(battle, self) {
            trace.push("start");
            return effects.install(battle, self.host, dependent, { scopes: [{ type: "SKILL", ref: activationRef(self) }] }).state;
        },
        onEnd(battle, self) {
            assert.equal(getUnit(battle, 1).skill.active.status, "ENDING");
            assert.equal(getUnit(battle, 1).effects.values().length, 0);
            trace.push("end");
            return battle;
        },
    } });
    const settled = skills.activate(f.state, f.ref);
    assert.equal(settled.value.type, "ACTIVATED");
    assert.deepEqual(trace, ["start", "dependent", "end"]);
    assert.equal(getUnit(settled.state, 1).skill.active, null);
    assert.deepEqual(settled.state.events.filter(({ type }) => type.startsWith("SKILL_")).map(({ type }) => type), ["SKILL_ACTIVATED", "SKILL_FINISHED"]);
    assert.equal(skills.finish(settled.state, settled.value.ref), settled.state);
    assert.deepEqual(f.state.events, []);
});

test("an entered onStart program continues after synchronous self-termination", () => {
    const trace = [];
    const f = fixture({ activation: {
        trigger: "MANUAL", sustain: { type: "INFINITE" }, initialize: () => ({}),
        onStart(battle, self) {
            trace.push("start");
            battle = skills.finish(battle, activationRef(self));
            trace.push("continued");
            return battle;
        },
        onEnd(battle) { trace.push("end"); return battle; },
    } });
    const settled = skills.activate(f.state, f.ref);
    assert.deepEqual(trace, ["start", "end", "continued"]);
    assert.equal(getUnit(settled.state, 1).skill.active, null);
    assert.equal(settled.state.events.filter(({ type }) => type === "SKILL_FINISHED").length, 1);
});

test("each nested dispatch gets fresh candidates while the outer dispatch keeps its selected sequence", () => {
    const trace = [];
    const later = hook("later", (battle, _self, event) => { trace.push(["later", event.current]); return battle; });
    const f = fixture();
    let state = change(f.state, (skill) => ({ ...skill, spRecovered: [
        hook("install", (battle, self, event) => {
            trace.push(["install", event.current]);
            if (event.current !== 1) return battle;
            battle = change(battle, (current) => ({ ...current, spRecovered: [...current.spRecovered, later] }));
            return sp.recover(battle, unitRef(self), "TIME", 1).state;
        }),
    ] }));
    state = sp.pay(state, f.ref, 2).state;
    state = sp.recover(state, f.ref, "TIME", 1).state;
    assert.deepEqual(trace, [["install", 1], ["install", 2], ["later", 2]]);
});

test("removing a selected Hook during dispatch prevents its later invocation", () => {
    const trace = [];
    const f = fixture();
    let state = change(f.state, (skill) => ({ ...skill, spPaid: [
        hook("remove", (battle) => {
            trace.push("remove");
            return change(battle, (current) => ({ ...current, spPaid: current.spPaid.filter(({ id }) => id !== "removed") }));
        }),
        hook("removed", (battle) => { trace.push("removed"); return battle; }),
    ] }));
    state = sp.pay(state, f.ref, 1).state;
    assert.deepEqual(trace, ["remove"]);
});

test("operation Rules gate user controls but cannot veto timeout or forced cancellation", () => {
    const seen = [];
    const f = fixture({ activation: {
        trigger: "MANUAL", sustain: { type: "INFINITE" }, initialize: () => ({}),
        onOperation(battle, _self, operation) { seen.push(operation); return battle; },
    } });
    let state = skills.activate(f.state, f.ref).state;
    const reference = activationRef(getUnit(state, 1).skill.active);
    state = change(state, (skill) => ({ ...skill, rules: [...skill.rules, { id: "no-control", allowsOperation: () => false }] }));
    assert.equal(skills.operate(state, reference, "STOP").value.type, "REJECTED");
    assert.deepEqual(seen, []);
    state = skills.cancel(state, reference, "DEPARTURE");
    assert.equal(getUnit(state, 1).skill.active, null);
});

test("activation payment and identity are committed together before a payment Hook can terminate it", () => {
    let starts = 0;
    const facts = [];
    const f = fixture({ activation: {
        trigger: "MANUAL", sustain: { type: "INFINITE" }, initialize: () => ({}),
        onStart(battle) { starts++; return battle; },
    } });
    let state = change(f.state, (skill) => ({ ...skill,
        spPaid: [hook("stop", (battle, self, event) => {
            assert.equal(self.skill.sp.value, 0);
            assert.equal(self.skill.active.status, "ACTIVE");
            assert.deepEqual([event.previous, event.current], [2, 0]);
            return skills.finish(battle, activationRef(self.skill.active));
        })],
        activated: [hook("created", (battle, self, event) => {
            facts.push({ id: event.id, current: self.skill.active });
            return battle;
        })],
    }));
    const result = skills.activate(state, f.ref);
    assert.equal(result.value.type, "ACTIVATED");
    assert.equal(starts, 0);
    assert.deepEqual(facts, [{ id: 0, current: null }]);
    assert.equal(getUnit(result.state, 1).skill.active, null);
    assert.deepEqual(result.state.events.filter(({ type }) => type.startsWith("SKILL_")).map(({ type }) => type), ["SKILL_ACTIVATED", "SKILL_FINISHED"]);
});
