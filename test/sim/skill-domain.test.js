import { fixtureBattle } from "../helpers/unit.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import * as skills from "../../dist/core/tactical/unit/capability/skill/operations.js";
import * as sp from "../../dist/core/tactical/unit/capability/skill/sp.js";
import { initialize as initializeSkill, removeRule, setDurationContribution, removeDurationContribution } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { create as value } from "../../dist/core/tactical/unit/contribution/attribute.js";
import { initialize } from "../helpers/unit.js";
import { ref } from "../../dist/core/tactical/unit/query.js";
import { effectFixtureWork } from "../helpers/effects.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import { start as startAction } from "../../dist/core/tactical/unit/action/operations.js";
import { fixture, definition, at, change, currentRef } from "../helpers/skill.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";

const resource = (overrides = {}) => ({
    initial: 0, capacity: 6, requirement: 3, cost: 3,
    recovery: { type: "TIME", intervalTicks: 30 }, ...overrides,
});
const read = (battle) => getUnit(battle, 1).skill;
const observe = (id, invoke) => ({ id, enabled: () => true, invoke });

function parameterEffect(id, modifiers) {
    return {
        id,
        initialize: () => ({}),
        onEnable: (battle, context) => change(battle, (skill) => ({
            ...skill,
            sp: Object.entries(modifiers).reduce((state, [key, value]) =>
                sp.setContribution(state, key, { id: `${context.self.id}/${key}`, value }), skill.sp),
        })),
        onDisable: (battle, context) => change(battle, (skill) => ({
            ...skill,
            sp: Object.keys(modifiers).reduce((state, key) =>
                sp.removeContribution(state, key, `${context.self.id}/${key}`), skill.sp),
        })),
    };
}

test("SP capacity can be replaced during activation and restored by ending its owning Effect", () => {
    const f = fixture({ sp: resource({ initial: 10, capacity: 10, requirement: 10, cost: 10 }) });
    const effect = parameterEffect("coin-capacity", {
        capacity: { priority: 0, apply: (_battle, self, current) => self.skill.active === null ? current : 20 },
    });
    const installed = effects.install(f.state, f.ref, effect);
    assert.equal(sp.resolveCapacity(installed.state, f.ref), 10);
    let state = skills.activate(installed.state, f.ref).state;
    assert.equal(read(state).sp.value, 0);
    assert.equal(sp.resolveCapacity(state, f.ref), 20);
    state = effects.end(state, installed.value, "REMOVED");
    assert.equal(sp.resolveCapacity(state, f.ref), 10);
    assert.equal(read(state).sp.capacity.length, 0);
});

test("a Fever-style Effect independently removes the SP requirement and payment and restores both", () => {
    const f = fixture({ sp: resource({ initial: 0, capacity: 10, requirement: 10, cost: 10 }) });
    const effect = parameterEffect("fever-permission", {
        requirement: { priority: 0, apply: () => 0 },
        cost: { priority: 0, apply: () => 0 },
    });
    assert.equal(skills.activate(f.state, f.ref).value.type, "REJECTED");
    const installed = effects.install(f.state, f.ref, effect);
    const started = skills.activate(installed.state, f.ref);
    assert.equal(started.value.type, "ACTIVATED");
    assert.equal(read(started.state).sp.value, 0);
    assert.equal(sp.resolveCapacity(started.state, f.ref), 10);
    let state = skills.finish(started.state, started.value.ref);
    state = effects.end(state, installed.value, "REMOVED");
    assert.equal(sp.resolveRequirement(state, f.ref), 10);
    assert.equal(sp.resolveCost(state, f.ref), 10);
    assert.equal(skills.activate(state, f.ref).value.type, "REJECTED");
});

test("SP parameter programs use explicit order and exclusive sources while default payment follows requirement", () => {
    const f = fixture({ sp: resource({ capacity: 10, cost: undefined }) });
    let state = change(f.state, (skill) => ({ ...skill, sp: sp.setContribution(
        sp.setContribution(skill.sp, "capacity", {
            id: "z-add", value: { priority: 0, apply: (_battle, _self, current) => current + 2 },
        }), "capacity", {
            id: "a-scale", value: { priority: 1, apply: (_battle, _self, current) => current * 2 },
        },
    ) }));
    assert.equal(sp.resolveCapacity(state, f.ref), 24);
    state = change(state, (skill) => ({ ...skill, sp: sp.setContribution(
        sp.setContribution(skill.sp, "requirement", {
            id: "weak", group: { id: "requirement", priority: 1 },
            value: { priority: 0, apply: () => 4 },
        }), "requirement", {
            id: "strong", group: { id: "requirement", priority: 2 },
            value: { priority: 0, apply: () => 5 },
        },
    ) }));
    assert.equal(sp.resolveRequirement(state, f.ref), 5);
    assert.equal(sp.resolveCost(state, f.ref), 5);
    state = change(state, (skill) => ({ ...skill, sp: sp.setContribution(skill.sp, "cost", {
        id: "discount", value: { priority: 0, apply: (_battle, _self, current) => current / 2 },
    }) }));
    assert.equal(sp.resolveCost(state, f.ref), 3);
    state = change(state, (skill) => ({ ...skill, sp: sp.removeContribution(skill.sp, "requirement", "strong") }));
    assert.equal(sp.resolveRequirement(state, f.ref), 4);
    assert.equal(sp.resolveCost(state, f.ref), 2);
});

test("a charged duration program samples all prepayment charges when the activation begins", () => {
    const f = fixture({
        sp: resource({ initial: 10, capacity: 10, requirement: 2, cost: undefined }),
        activation: {
            trigger: "MANUAL", sustain: { type: "TIME", durationTicks: 120 }, initialize: () => ({}),
            onStart: (battle, self) => sp.modify(battle, self.host, -getUnit(battle, self.host.id).skill.sp.value).state,
        },
    });
    const entry = {
        id: "charged-duration",
        value: { priority: 0, apply: (_battle, self, current) =>
            current * (1 + Math.floor(self.skill.sp.value / self.definition.skill.sp.requirement) * 0.4) },
    };
    let state = change(at(f.state, 7), (skill) => setDurationContribution(skill, entry));
    const started = skills.activate(state, f.ref);
    assert.equal(started.value.type, "ACTIVATED");
    assert.equal(read(started.state).sp.value, 0);
    assert.equal(read(started.state).active.sustain.endsAtTick, 367);
    state = change(started.state, (skill) => removeDurationContribution(skill, entry.id));
    assert.equal(read(state).active.sustain.endsAtTick, 367);
    state = skills.finish(state, started.value.ref);
    state = sp.modify(state, f.ref, 10).state;
    state = skills.activate(state, f.ref).state;
    assert.equal(read(state).active.sustain.endsAtTick, 127);
});

test("skill definitions are shared and deployments initialize independent private state", () => {
    const f = fixture({ initialize: () => ({ count: 0 }), sp: resource({ initial: 1 }) });
    assert.equal(f.unit.definition.skill, f.definition);
    const another = initializeSkill(fixtureBattle(90), f.definition).value;
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

test("a zero-HP host preserves its natural remainder while advancing the paused clock", () => {
    const unit = initialize({ id: 1, position: [0, 0], definition: {
        id: "reviving-host", vitality: { maxHp: 100 }, skill: definition({ sp: resource() }),
    } });
    const reference = ref(unit);
    let state = sp.advance(at(effectFixtureWork(unit), 12), reference);
    const before = state;
    let current = getUnit(state, 1);
    state = updateUnit(state, { ...current, vitality: { ...current.vitality, hp: 0 } });
    state = sp.advance(at(state, 200), reference);
    assert.equal(read(state).sp.value, 0);
    assert.equal(read(state).sp.lastTick, 200);
    assert.equal(read(state).sp.recovery.remainingTicks, 18);
    assert.throws(() => sp.advance(at(state, 199), reference), /earlier tick/);
    current = getUnit(state, 1);
    state = updateUnit(state, { ...current, vitality: { ...current.vitality, hp: 100 } });
    state = sp.advance(at(state, 217), reference);
    assert.equal(read(state).sp.value, 0);
    assert.equal(read(state).sp.recovery.remainingTicks, 1);
    state = sp.advance(at(state, 218), reference);
    assert.equal(read(state).sp.value, 1);
    assert.equal(read(before).sp.lastTick, 12);
    assert.equal(read(before).sp.recovery.remainingTicks, 18);
});

test("a paused zero-HP host still applies natural speed changes and zero-rate invalidation", () => {
    const unit = initialize({ id: 1, position: [0, 0], definition: {
        id: "paused-speed-host", vitality: { maxHp: 100 }, skill: definition({ sp: resource() }),
    } });
    const reference = ref(unit);
    let state = sp.advance(at(effectFixtureWork(unit), 12), reference);
    const current = getUnit(state, 1);
    state = updateUnit(state, { ...current, vitality: { ...current.vitality, hp: 0 } });
    state = change(state, skill => ({ ...skill, sp: sp.setContribution(skill.sp, "recoverySpeed", {
        id: "double", value: [value({ finalScaler: 2 })],
    }) }));
    state = sp.advance(at(state, 100), reference);
    assert.deepEqual(read(state).sp.recovery, { periodTicks: 15, remainingTicks: 3 });
    assert.equal(read(state).sp.lastTick, 100);
    state = change(state, skill => ({ ...skill, sp: sp.setContribution(skill.sp, "recoveryMultiplier", {
        id: "zero", value: [value({ finalScaler: 0 })],
    }) }));
    state = sp.advance(at(state, 200), reference);
    assert.equal(read(state).sp.recovery, null);
    assert.equal(read(state).sp.lastTick, 200);
    state = change(state, skill => ({ ...skill, sp: sp.removeContribution(skill.sp, "recoveryMultiplier", "zero") }));
    state = sp.advance(at(state, 300), reference);
    assert.deepEqual(read(state).sp.recovery, { periodTicks: 15, remainingTicks: 15 });
    assert.equal(read(state).sp.value, 0);
    assert.equal(read(state).sp.lastTick, 300);
});

test("natural advancement supports a host without Vitality and leaves a LEAVING host unchanged", () => {
    const f = fixture({ sp: resource() });
    const state = sp.advance(at(f.state, 30), f.ref);
    assert.equal(read(state).sp.value, 1);
    assert.equal(read(state).sp.lastTick, 30);
    const current = getUnit(state, 1);
    const leaving = at(updateUnit(state, { ...current, lifecycle: "LEAVING" }), 200);
    assert.equal(sp.advance(leaving, f.ref), leaving);
    assert.equal(read(leaving).sp.lastTick, 30);
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
        initialize: battle => ({ state: battle, value: {} }),
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
