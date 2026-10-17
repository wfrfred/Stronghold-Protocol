import assert from "node:assert/strict";
import { test } from "node:test";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import { leave } from "../../dist/core/tactical/battle/execution/unit.js";
import * as skills from "../../dist/core/tactical/unit/capability/skill/operations.js";
import * as sp from "../../dist/core/tactical/unit/capability/skill/sp.js";
import { ref as activationRef } from "../../dist/core/tactical/unit/capability/skill/activation.js";
import { get as getActivation } from "../../dist/core/tactical/unit/capability/skill/query.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { get as getHookHost, ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { fixture, change } from "../helpers/skill.js";
import { definition as effectDefinition } from "../helpers/effects.js";

const hook = (id, invoke) => ({ id, invoke });

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

test("onStart self-termination follows creation notification and entered content can continue", () => {
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
    const state = change(f.state, (skill) => ({ ...skill,
        activated: [hook("created", (battle) => { trace.push("activated"); return { state: battle, value: undefined }; })],
        ended: [hook("ended", (battle) => { trace.push("ended"); return { state: battle, value: undefined }; })],
    }));
    const settled = skills.activate(state, f.ref);
    assert.deepEqual(trace, ["activated", "start", "end", "ended", "continued"]);
    assert.equal(getUnit(settled.state, 1).skill.active, null);
    assert.equal(settled.state.events.filter(({ type }) => type === "SKILL_FINISHED").length, 1);
});

test("each nested dispatch gets fresh candidates while the outer dispatch keeps its selected sequence", () => {
    const trace = [];
    const later = hook("later", (battle, { event }) => { trace.push(["later", event.current]); return { state: battle, value: undefined }; });
    const f = fixture();
    let state = change(f.state, (skill) => ({ ...skill, spRecovered: [
        hook("install", (battle, { host, event }) => {
            const self = getHookHost(battle, host);

            trace.push(["install", event.current]);
            if (event.current !== 1) return { state: battle, value: undefined };
            battle = change(battle, (current) => ({ ...current, spRecovered: [...current.spRecovered, later] }));
            return { state: sp.recover(battle, unitRef(self), "TIME", 1).state, value: undefined };
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
            return { state: change(battle, (current) => ({ ...current, spPaid: current.spPaid.filter(({ id }) => id !== "removed") })), value: undefined };
        }),
        hook("removed", (battle) => { trace.push("removed"); return { state: battle, value: undefined }; }),
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
        spPaid: [hook("stop", (battle, { host, event }) => {
            const self = getHookHost(battle, host);

            assert.equal(self.skill.sp.value, 0);
            assert.equal(self.skill.active.status, "ACTIVE");
            assert.deepEqual([event.previous, event.current], [2, 0]);
            return { state: skills.finish(battle, activationRef(self.skill.active)), value: undefined };
        })],
        activated: [hook("created", (battle, { host, event }) => {
            const self = getHookHost(battle, host);

            facts.push({ id: event.id, currentId: self.skill.active.id, status: self.skill.active.status });
            return { state: battle, value: undefined };
        })],
    }));
    const result = skills.activate(state, f.ref);
    assert.equal(result.value.type, "ACTIVATED");
    assert.equal(starts, 0);
    assert.deepEqual(facts, [{ id: 0, currentId: 0, status: "ACTIVE" }]);
    assert.equal(getUnit(result.state, 1).skill.active, null);
    assert.deepEqual(result.state.events.filter(({ type }) => type.startsWith("SKILL_")).map(({ type }) => type), ["SKILL_ACTIVATED", "SKILL_FINISHED"]);
});

test("creation notification precedes departure triggered by the activation payment Hook", () => {
    const trace = [];
    const f = fixture({ activation: {
        trigger: "MANUAL", sustain: { type: "INFINITE" }, initialize: () => ({}),
        onStart: () => assert.fail("a departed host cannot enter its start program"),
        onEnd(battle, self) {
            assert.equal(getUnit(battle, self.host.id).lifecycle, "LEAVING");
            trace.push("onEnd");
            return battle;
        },
    } });
    const state = change(f.state, (skill) => ({ ...skill,
        activated: [hook("created", (battle, { host, event }) => {
            const self = getHookHost(battle, host);

            assert.equal(self.skill.sp.value, 0);
            assert.equal(self.skill.active.id, event.id);
            trace.push("activated");
            return { state: battle, value: undefined };
        })],
        spPaid: [hook("depart", (battle, { host, event }) => {
            const self = getHookHost(battle, host);

            assert.deepEqual(event, { amount: 2, previous: 2, current: 0 });
            trace.push("spPaid");
            return { state: leave(battle, self.id, "RETREAT"), value: undefined };
        })],
        ended: [hook("ended", (battle) => { trace.push("ended"); return { state: battle, value: undefined }; })],
    }));
    const settled = skills.activate(state, f.ref);
    assert.equal(settled.value.type, "ACTIVATED");
    assert.deepEqual(trace, ["activated", "spPaid", "onEnd", "ended"]);
    assert.equal(getUnit(settled.state, 1), undefined);
    assert.deepEqual(settled.state.events.filter(({ type }) => type.startsWith("SKILL_")).map(({ type }) => type), ["SKILL_ACTIVATED", "SKILL_FINISHED"]);
});

test("an activated Hook can end the instance while later candidates and payment retain their original facts", () => {
    const trace = [];
    const f = fixture({ activation: {
        trigger: "MANUAL", sustain: { type: "INFINITE" }, initialize: () => ({}),
        onStart: () => assert.fail("the ended instance cannot enter its start program"),
        onEnd(battle) { trace.push("onEnd"); return battle; },
    } });
    const state = change(f.state, (skill) => ({ ...skill,
        activated: [
            hook("first", (battle, { host, event }) => {
                const self = getHookHost(battle, host);

                assert.equal(self.skill.sp.value, 0);
                trace.push("activated:first");
                battle = skills.finish(battle, activationRef(event));
                battle = sp.modify(battle, unitRef(self), 1, true).state;
                trace.push("activated:return");
                return { state: battle, value: undefined };
            }),
            hook("later", (battle, { host, event }) => {
                const self = getHookHost(battle, host);

                assert.equal(self.skill.active, null);
                assert.equal(event.id, 0);
                assert.equal(event.status, "ACTIVE");
                trace.push("activated:later");
                return { state: battle, value: undefined };
            }),
        ],
        ended: [hook("ended", (battle) => { trace.push("ended"); return { state: battle, value: undefined }; })],
        spPaid: [hook("paid", (battle, { host, event }) => {
            const self = getHookHost(battle, host);

            assert.equal(self.skill.active, null);
            assert.equal(self.skill.sp.value, 1);
            assert.deepEqual(event, { amount: 2, previous: 2, current: 0 });
            trace.push("spPaid");
            return { state: battle, value: undefined };
        })],
    }));
    const settled = skills.activate(state, f.ref);
    assert.equal(settled.value.type, "ACTIVATED");
    assert.deepEqual(trace, ["activated:first", "onEnd", "ended", "activated:return", "activated:later", "spPaid"]);
    assert.equal(getUnit(settled.state, 1).skill.active, null);
    assert.equal(settled.state.events.filter(({ type }) => type === "SKILL_FINISHED").length, 1);
});

test("an ended Hook may start a replacement without running the old start or timeout against it", () => {
    const starts = [];
    const payments = [];
    const f = fixture({
        sp: { initial: 4, capacity: 4, requirement: 2, cost: 2, recovery: { type: "NONE" } },
        activation: {
            trigger: "MANUAL", sustain: { type: "TIME", durationTicks: 0 }, initialize: () => ({}),
            onStart(battle, self) {
                starts.push(self.id);
                assert.equal(self.id, 1);
                return skills.extendTime(battle, activationRef(self), 5);
            },
        },
    });
    const state = change(f.state, (skill) => ({ ...skill,
        activated: [hook("replace-first", (battle, { event }) => ({ state: event.id === 0 ? skills.finish(battle, activationRef(event)) : battle, value: undefined }))],
        ended: [hook("restart", (battle, { host, event }) => {
            const self = getHookHost(battle, host);
return { state: event.activation.id === 0 ? skills.activate(battle, unitRef(self)).state : battle, value: undefined }; })],
        spPaid: [hook("paid", (battle, { event }) => {
            payments.push([event.previous, event.current]);
            return { state: battle, value: undefined };
        })],
    }));
    const settled = skills.activate(state, f.ref);
    assert.equal(settled.value.type, "ACTIVATED");
    assert.equal(settled.value.ref.id, 0);
    assert.equal(getActivation(settled.state, settled.value.ref), undefined);
    assert.deepEqual(starts, [1]);
    assert.deepEqual(payments, [[2, 0], [4, 2]]);
    assert.equal(getUnit(settled.state, 1).skill.active.id, 1);
    assert.deepEqual(getUnit(settled.state, 1).skill.active.sustain, { type: "TIME", endsAtTick: 5 });
    assert.deepEqual(settled.state.events.filter(({ type }) => type.startsWith("SKILL_")).map(({ type, activationId }) => [type, activationId]), [
        ["SKILL_ACTIVATED", 0], ["SKILL_FINISHED", 0], ["SKILL_ACTIVATED", 1],
    ]);
});


test("activation replacement changes live state while remaining observers retain the original context", () => {
    const f = fixture({
        sp: { initial: 4, capacity: 4, requirement: 2, cost: 2, recovery: { type: "NONE" } },
        activation: { trigger: "MANUAL", sustain: { type: "INFINITE" }, initialize: () => ({}) },
    });
    const seen = [];
    let original;
    const state = change(f.state, skill => ({ ...skill, activated: [
        {
            id: "replace",
            invoke(battle, context) {
                if (context.event.id === 0) {
                    original = context;
                    battle = skills.finish(battle, activationRef(context.event));
                    battle = skills.activate(battle, context.host).state;
                }
                return { state: battle, value: undefined };
            },
        },
        {
            id: "observe",
            invoke(battle, context) {
                if (context.event.id === 0) assert.equal(context, original);
                const current = getHookHost(battle, context.host).skill.active;
                seen.push([context.event.id, context.event.status, current.id]);
                return { state: battle, value: undefined };
            },
        },
    ] }));
    const result = skills.activate(state, f.ref);
    assert.deepEqual(seen, [[1, "ACTIVE", 1], [0, "ACTIVE", 1]]);
    assert.equal(getUnit(result.state, f.ref.id).skill.active.id, 1);
});
