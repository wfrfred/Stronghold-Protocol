import assert from "node:assert/strict";
import { test } from "node:test";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import * as skills from "../../dist/core/tactical/unit/capability/skill/operations.js";
import * as sp from "../../dist/core/tactical/unit/capability/skill/sp.js";
import { initialize as initializeSkill, removeRule } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { create as value } from "../../dist/core/tactical/unit/contribution/value.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import { ref } from "../../dist/core/tactical/unit/query.js";
import { effectFixtureWork } from "../helpers/effects.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import { start as startAction } from "../../dist/core/tactical/unit/action/operations.js";
import { fixture, definition, at, change, currentRef } from "../helpers/skill.js";

const resource = (overrides = {}) => ({
    initial: 0, capacity: 6, requirement: 3, cost: 3,
    recovery: { type: "TIME", intervalTicks: 30 }, ...overrides,
});
const read = (battle) => getUnit(battle, 1).skill;
const observe = (id, invoke) => ({ id, enabled: () => true, invoke });

test("skill definitions are shared and deployments initialize independent private state", () => {
    const f = fixture({ initialize: () => ({ count: 0 }), sp: resource({ initial: 1 }) });
    assert.equal(f.unit.definition.skill, f.definition);
    const another = initializeSkill(f.definition, 90);
    assert.deepEqual(another.data, { count: 0 });
    assert.notEqual(another.data, f.unit.skill.data);
    assert.equal(another.sp.value, 1);
    assert.equal(another.sp.lastTick, 90);
    assert.throws(() => definition({ sp: resource({ initial: 7 }) }), /capacity/);
    assert.throws(() => definition({ sp: resource({ initial: 0.5 }) }), /integer/);
});

for (const source of ["TIME", "ACTION", "HIT"]) {
    test(`${source} recovery caps capacity and preserves ordinary charge budgets`, () => {
        const recovery = source === "TIME" ? { type: source, intervalTicks: 30 } : { type: source, amount: 1 };
        const f = fixture({ sp: resource({ recovery }) });
        const gained = sp.recover(f.state, f.ref, source, 5);
        assert.equal(read(gained.state).sp.value, 5);
        assert.equal(read(sp.recover(gained.state, f.ref, source, 10).state).sp.value, 6);
        const paid = sp.pay(gained.state, f.ref);
        assert.equal(read(paid.state).sp.value, 2);
        const refused = sp.pay(paid.state, f.ref);
        assert.equal(refused.value.type, "REJECTED");
        assert.equal(refused.state, paid.state);
        assert.equal(sp.recover(gained.state, f.ref, source === "ACTION" ? "HIT" : "ACTION").value.type, "REJECTED");
        assert.throws(() => sp.recover(gained.state, f.ref, source, 0.5), /integer/);
    });
}

test("capacity, activation requirement and payment are separate numeric facts", () => {
    const f = fixture({ sp: resource({ initial: 5, capacity: 10, requirement: 5, cost: 2 }) });
    const activated = skills.activate(f.state, f.ref);
    assert.equal(activated.value.type, "ACTIVATED");
    assert.equal(read(activated.state).sp.value, 3);
    assert.equal(read(f.state).sp.value, 5);
});

test("payment needs no Activation and ignores recovery and activation Rules", () => {
    const f = fixture({ sp: resource({ initial: 5 }), activation: null });
    let state = change(f.state, (skill) => ({ ...skill, rules: [{
        id: "blocked", allowsActivation: () => false, allowsRecovery: () => false,
    }] }));
    state = sp.pay(state, f.ref, 3).state;
    assert.equal(read(state).sp.value, 2);
    assert.equal(read(state).active, null);
    assert.equal(read(state).nextActivationId, 0);
});

test("recovery Rules block ordinary positive modification, but not drains, payment or explicit force", () => {
    const f = fixture({ sp: resource({ initial: 4 }) });
    const state = change(f.state, (skill) => ({ ...skill, rules: [{ id: "block", allowsRecovery: () => false }] }));
    assert.equal(sp.recover(state, f.ref, "TIME", 1).state, state);
    assert.equal(sp.modify(state, f.ref, 1).state, state);
    assert.equal(read(sp.modify(state, f.ref, -2).state).sp.value, 2);
    assert.equal(read(sp.pay(state, f.ref, 3).state).sp.value, 1);
    assert.equal(read(sp.modify(state, f.ref, 20, true).state).sp.value, 6);
    assert.equal(read(sp.modify(state, f.ref, -20, true).state).sp.value, 0);
});

test("active recovery is a removable default Rule and payment remains legal during activation", () => {
    const f = fixture({ sp: resource({ initial: 6 }) });
    let state = skills.activate(f.state, f.ref).state;
    assert.equal(read(state).sp.value, 3);
    assert.equal(sp.recover(state, f.ref, "TIME", 1).value.type, "REJECTED");
    state = sp.pay(state, f.ref, 1).state;
    assert.equal(read(state).sp.value, 2);
    state = change(state, (skill) => removeRule(skill, "@skill/active-recovery"));
    state = sp.recover(state, f.ref, "TIME", 1).state;
    assert.equal(read(state).sp.value, 3);
    assert.equal(read(state).active.status, "ACTIVE");
});

test("natural SP pauses while full and resumes the saved remainder without a backlog", () => {
    const f = fixture({ sp: resource({ capacity: 2, requirement: 2, cost: 2 }) });
    let state = skills.advance(at(f.state, 15), f.ref);
    assert.equal(read(state).sp.recovery.remainingTicks, 15);
    state = sp.modify(state, f.ref, 2).state;
    state = skills.advance(at(state, 100), f.ref);
    assert.equal(read(state).sp.recovery.remainingTicks, 15);
    state = sp.pay(state, f.ref, 2).state;
    state = skills.advance(at(state, 114), f.ref);
    assert.equal(read(state).sp.value, 0);
    state = skills.advance(at(state, 115), f.ref);
    assert.equal(read(state).sp.value, 1);
    assert.equal(read(f.state).sp.recovery.remainingTicks, 30);
});

test("recovery restrictions pause the natural timer and do not accumulate missed periods", () => {
    const f = fixture({ sp: resource() });
    let state = skills.advance(at(f.state, 12), f.ref);
    state = change(state, (skill) => ({ ...skill, rules: [{ id: "block", allowsRecovery: () => false }] }));
    state = skills.advance(at(state, 200), f.ref);
    assert.equal(read(state).sp.value, 0);
    assert.equal(read(state).sp.recovery.remainingTicks, 18);
    state = change(state, (skill) => ({ ...skill, rules: skill.rules.filter(({ id }) => id !== "block") }));
    state = skills.advance(at(state, 217), f.ref);
    assert.equal(read(state).sp.value, 0);
    state = skills.advance(at(state, 218), f.ref);
    assert.equal(read(state).sp.value, 1);
});

test("a long natural advance stops its timer when the first pulse fills SP", () => {
    const f = fixture({ sp: resource({ initial: 1, capacity: 2, requirement: 2, cost: 2 }) });
    let state = skills.advance(at(f.state, 15), f.ref);
    assert.equal(read(state).sp.recovery.remainingTicks, 15);
    state = skills.advance(at(state, 100), f.ref);
    assert.equal(read(state).sp.value, 2);
    assert.equal(read(state).sp.recovery.remainingTicks, 30);
    state = sp.pay(state, f.ref, 2).state;
    state = skills.advance(at(state, 129), f.ref);
    assert.equal(read(state).sp.value, 0);
    state = skills.advance(at(state, 130), f.ref);
    assert.equal(read(state).sp.value, 1);
});

test("natural speed changes preserve absolute elapsed time instead of a completion fraction", () => {
    const f = fixture({ sp: resource() });
    let state = skills.advance(at(f.state, 12), f.ref);
    state = change(state, (skill) => ({ ...skill, sp: { ...skill.sp, recoverySpeed: [
        { id: "double", value: [value({ finalScaler: 2 })] },
    ] } }));
    state = skills.advance(state, f.ref);
    assert.equal(read(state).sp.recovery.periodTicks, 15);
    assert.equal(read(state).sp.recovery.remainingTicks, 3);
    state = skills.advance(at(state, 15), f.ref);
    assert.equal(read(state).sp.value, 1);
});

test("zero natural speed invalidates the timer and resumption starts a full period", () => {
    const f = fixture({ sp: resource() });
    let state = skills.advance(at(f.state, 12), f.ref);
    state = change(state, (skill) => ({ ...skill, sp: { ...skill.sp, recoveryMultiplier: [
        { id: "zero", value: [value({ finalScaler: 0 })] },
    ] } }));
    state = skills.advance(state, f.ref);
    assert.equal(read(state).sp.recovery, null);
    state = change(at(state, 100), (skill) => ({ ...skill, sp: { ...skill.sp, recoveryMultiplier: [] } }));
    state = skills.advance(state, f.ref);
    assert.equal(read(state).sp.recovery.remainingTicks, 30);
    state = skills.advance(at(state, 129), f.ref);
    assert.equal(read(state).sp.value, 0);
    state = skills.advance(at(state, 130), f.ref);
    assert.equal(read(state).sp.value, 1);
});

test("SP Hooks keep settled reports across nested payment and dispatch only their own business", () => {
    const seen = [];
    const f = fixture({ sp: resource({ initial: 9, capacity: 20, requirement: 10 }) });
    let state = change(f.state, (skill) => ({ ...skill,
        spRecovered: [
            observe("nested", (battle, self, event) => {
                seen.push(["first", event.previous, event.current]);
                return sp.pay(battle, ref(self), 11).state;
            }),
            observe("after", (battle, _self, event) => {
                seen.push(["after", event.previous, event.current, read(battle).sp.value]);
                return battle;
            }),
        ],
        spPaid: [observe("payment", (battle, _self, event) => {
            seen.push(["paid", event.previous, event.current]);
            return battle;
        })],
        spModified: [observe("not-modification", () => assert.fail("wrong resource notification"))],
    }));
    state = sp.recover(state, f.ref, "TIME", 2).state;
    assert.deepEqual(seen, [["first", 9, 11], ["paid", 11, 0], ["after", 9, 11, 0]]);
    assert.equal(read(state).sp.value, 0);
});

test("persistent data survives activations and activation data is initialized independently", () => {
    const f = fixture({ initialize: () => ({ count: 0 }), sp: null,
        activation: { trigger: "MANUAL", sustain: { type: "INFINITE" }, initialize: () => ({ count: 0 }) },
    });
    let state = skills.activate(f.state, f.ref).state;
    state = change(state, (skill) => ({ ...skill, data: { count: 7 } }));
    state = skills.finish(state, currentRef(state));
    state = skills.activate(state, f.ref).state;
    assert.deepEqual(read(state).data, { count: 7 });
    assert.deepEqual(read(state).active.data, { count: 0 });
    assert.equal(read(state).active.id, 1);
});

test("normal activation refusal allocates no identity and preserves the input state", () => {
    const f = fixture({ sp: resource() });
    const rejected = skills.activate(f.state, f.ref);
    assert.equal(rejected.value.type, "REJECTED");
    assert.equal(rejected.state, f.state);
    assert.equal(read(rejected.state).nextActivationId, 0);
    assert.equal(skills.activate(f.state, f.ref, "AUTO").value.type, "REJECTED");
});

test("definition admission rejects before payment and activation allocation", () => {
    const f = fixture({ activation: {
        trigger: "MANUAL", sustain: { type: "INFINITE" }, initialize: () => ({}),
        accepts: () => false, onStart: () => assert.fail("rejected content must not run"),
    } });
    const rejected = skills.activate(f.state, f.ref);
    assert.equal(rejected.value.type, "REJECTED");
    assert.equal(rejected.state, f.state);
    assert.equal(read(rejected.state).sp.value, 2);
    assert.equal(read(rejected.state).nextActivationId, 0);
});

test("dead and leaving hosts cannot activate or recover natural SP", () => {
    const skill = definition({ sp: resource() });
    const initial = initialize({ id: 1, position: [0, 0], definition: { id: "dead", skill, vitality: { maxHp: 100 } } });
    for (const unit of [
        { ...initial, vitality: { ...initial.vitality, hp: 0 } },
        { ...initial, lifecycle: "LEAVING" },
    ]) {
        const state = effectFixtureWork(unit);
        assert.equal(skills.activate(state, ref(unit)).value.type, "REJECTED");
        assert.equal(read(skills.advance(at(state, 300), ref(unit))).sp.value, 0);
    }
});

test("TIME ends at its deadline and INFINITE requires an explicit end", () => {
    const f = fixture();
    let state = skills.activate(f.state, f.ref).state;
    assert.deepEqual(read(state).active.sustain, { type: "TIME", endsAtTick: 30 });
    state = skills.advance(at(state, 29), f.ref);
    assert.ok(read(state).active);
    state = skills.advance(at(state, 30), f.ref);
    assert.equal(read(state).active, null);
    const infinite = fixture({ activation: {
        trigger: "MANUAL", sustain: { type: "INFINITE" }, initialize: () => ({}),
    } });
    state = skills.activate(infinite.state, infinite.ref).state;
    state = skills.advance(at(state, 1000), infinite.ref);
    assert.equal(read(state).active.sustain.type, "INFINITE");
    assert.equal(read(skills.finish(state, currentRef(state))).active, null);
});

test("a deployment passive can have a finite TIME duration without natural reactivation", () => {
    const f = fixture({ sp: null, activation: {
        trigger: "PASSIVE", sustain: { type: "TIME", durationTicks: 3 }, initialize: () => ({}),
    } });
    let state = skills.enter(f.state, f.ref);
    assert.equal(read(state).active.sustain.endsAtTick, 3);
    state = skills.advance(at(state, 3), f.ref);
    assert.equal(read(state).active, null);
    state = skills.advance(at(state, 30), f.ref);
    assert.equal(read(state).active, null);
    assert.equal(read(state).nextActivationId, 1);
});

test("generic Action scheduling does not itself award ACTION SP", () => {
    const action = { id: "reload-like", intervalTicks: 30, speed: 100,
        start: (battle) => ({ state: battle, value: {} }),
        step: (battle) => ({ state: battle, value: true }),
    };
    const unit = initialize({ id: 1, position: [0, 0], definition: {
        id: "actor", skill: definition({ sp: resource({ recovery: { type: "ACTION", amount: 1 } }) }),
        action: { definitions: Definitions.empty().add(action) },
    } });
    const battle = startAction(effectFixtureWork(unit), ref(unit), action).state;
    assert.equal(read(battle).sp.value, 0);
});
