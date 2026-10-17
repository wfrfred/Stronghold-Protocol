import assert from "node:assert/strict";
import { test } from "node:test";
import { getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { leave } from "../../dist/core/tactical/battle/execution/unit.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { setState } from "../../dist/core/tactical/unit/action/action.js";
import { advance } from "../../dist/core/tactical/unit/action/advance.js";
import { setBeforeReleaseHook, setReleasedHook } from "../../dist/core/tactical/unit/capability/action/capability.js";
import { released } from "../../dist/core/tactical/unit/capability/action/release.js";
import { createDefinition as createSkillDefinition, setSpRecoveredHook } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { enter } from "../../dist/core/tactical/unit/capability/skill/operations.js";
import { actionDefinition, unit, battle } from "../helpers/action-fixture.js";

const hook = (id, invoke) => ({ id, invoke });

function fixture({ windupTicks = 0, recoveryAmount = 1, action, withSkill = true, targets = 1 } = {}) {
    const definition = action ?? actionDefinition(7, { windupTicks });
    const skill = createSkillDefinition({
        id: "action-recovery", initialize: () => ({}), activation: null,
        sp: { initial: 0, capacity: 10, requirement: 10, recovery: { type: "ACTION", amount: recoveryAmount } },
    });
    const source = unit(0, { action: definition, ...(withSkill ? { skill } : {}) });
    const reference = unitRef(source);
    const initial = battle(source, ...Array.from({ length: targets }, (_, index) => unit(index + 1)));
    return { definition, ref: reference, state: withSkill ? enter(initial, reference) : initial };
}

function changeAction(state, transition) {
    const source = getUnit(state, 0);
    return updateUnit(state, { ...source, action: transition(source.action) });
}

function changeSkill(state, transition) {
    const source = getUnit(state, 0);
    return updateUnit(state, { ...source, skill: transition(source.skill) });
}

test("a successful attack notifies released after its release event, restores ACTION SP and then outputs", () => {
    const seen = [];
    const f = fixture({ recoveryAmount: 2 });
    const state = changeAction(f.state, (action) => setReleasedHook(action, hook("observe", (current, context) => {
        const source = getUnit(current, context.source.id);
        const reference = context.action;
        assert.equal(current.events.at(-1).type, "ACTION_RELEASED");
        assert.equal(current.events.some(({ type }) => type === "DAMAGE"), false);
        assert.equal(source.skill.sp.value, 2);
        assert.equal(actions.get(current, reference).status, "RUNNING");
        seen.push(reference.id);
        return { state: current, value: undefined };
    })));
    const started = actions.start(state, f.ref, f.definition);
    assert.equal(started.value.type, "STARTED");
    assert.deepEqual(seen, [started.value.ref.id]);
    assert.equal(getUnit(started.state, 0).skill.sp.value, 2);
    assert.equal(getUnit(started.state, 1).vitality.hp, 93);
    assert.deepEqual(started.state.events.filter(({ type }) => ["ACTION_RELEASED", "DAMAGE"].includes(type)).map(({ type }) => type), ["ACTION_RELEASED", "DAMAGE"]);
    assert.equal(getUnit(f.state, 0).skill.sp.value, 0);
});

test("cancelling windup produces no release notification or ACTION SP", () => {
    const f = fixture({ windupTicks: 2 });
    const state = changeAction(f.state, (action) => setReleasedHook(action, hook("unreleased", () => assert.fail("cancelled windup did not release"))));
    const started = actions.start(state, f.ref, f.definition);
    let current = actions.cancel(started.state, started.value.ref, "CANCELLED");
    current = advance({ ...current, tick: 2 }, started.value.ref);
    assert.equal(getUnit(current, 0).skill.sp.value, 0);
    assert.equal(getUnit(current, 1).vitality.hp, 100);
    assert.equal(current.events.some(({ type }) => type === "ACTION_RELEASED" || type === "DAMAGE"), false);
});

test("beforeRelease interruption prevents the public release notification and ACTION recovery", () => {
    const f = fixture();
    let state = changeAction(f.state, (action) => setBeforeReleaseHook(action, {
        id: "interrupt", accepts: () => true,
        invoke: (current) => ({ state: current, value: { type: "INTERRUPT", recoveryTicks: 15 } }),
    }));
    state = changeAction(state, (action) => setReleasedHook(action, hook("unreleased", () => assert.fail("intercepted action did not release"))));
    const started = actions.start(state, f.ref, f.definition);
    assert.equal(getUnit(started.state, 0).skill.sp.value, 0);
    assert.equal(getUnit(started.state, 1).vitality.hp, 100);
    assert.equal(started.state.events.some(({ type }) => type === "ACTION_RELEASED" || type === "DAMAGE"), false);
    assert.deepEqual(started.state.events.filter(({ type }) => type === "ACTION_CANCELLED").map(({ reason }) => reason), ["INTERRUPTED"]);
});

test("ACTION recovery can synchronously cancel the released Action before its old output executes", () => {
    const f = fixture();
    const state = changeSkill(f.state, (skill) => setSpRecoveredHook(skill, hook("cancel-release", (current, context) => {
        const source = getUnit(current, context.host.id);
        assert.equal(context.event.source, "ACTION");
        const reference = actions.forUnit(current, unitRef(source))[0];
        return { state: actions.cancel(current, reference, "RECOVERY_CALLBACK"), value: undefined };
    })));
    const started = actions.start(state, f.ref, f.definition);
    assert.equal(getUnit(started.state, 0).skill.sp.value, 1);
    assert.equal(getUnit(started.state, 1).vitality.hp, 100);
    assert.equal(actions.get(started.state, started.value.ref), undefined);
    assert.equal(started.state.events.some(({ type }) => type === "ACTION_RELEASED"), true);
    assert.equal(started.state.events.some(({ type }) => type === "DAMAGE"), false);
    assert.deepEqual(started.state.events.filter(({ type }) => type === "ACTION_CANCELLED").map(({ reason }) => reason), ["RECOVERY_CALLBACK"]);
});

test("ACTION recovery can remove its host without continuing the released Action's old output", () => {
    let recovered;
    const f = fixture();
    const state = changeSkill(f.state, (skill) => setSpRecoveredHook(skill, hook("depart", (current, context) => {
        recovered = context.event;
        return { state: leave(current, context.host.id, "SCRIPT"), value: undefined };
    })));
    const started = actions.start(state, f.ref, f.definition);
    assert.deepEqual(recovered, { source: "ACTION", amount: 1, previous: 0, current: 1 });
    assert.equal(getUnit(started.state, 0), undefined);
    assert.equal(getUnit(started.state, 1).vitality.hp, 100);
    assert.equal(actions.get(started.state, started.value.ref), undefined);
    assert.equal(started.state.events.some(({ type }) => type === "ACTION_RELEASED"), true);
    assert.equal(started.state.events.some(({ type }) => type === "DAMAGE"), false);
});

test("default attack output reads bindings replaced by a released Hook from the latest Action", () => {
    const f = fixture({ targets: 2 });
    const state = changeAction(f.state, (action) => setReleasedHook(action, hook("rebind", (current, context) => {
        const reference = context.action;
        const self = actions.get(current, reference);
        assert.equal(self.state.bindings.primary[0].id, 1);
        return { state: actions.replace(current, setState(self, { ...self.state,
            bindings: { ...self.state.bindings, primary: [unitRef(getUnit(current, 2))] },
        })), value: undefined };
    })));
    const started = actions.start(state, f.ref, f.definition);
    assert.equal(getUnit(started.state, 1).vitality.hp, 100);
    assert.equal(getUnit(started.state, 2).vitality.hp, 93);
    assert.deepEqual(started.state.events.filter(({ type }) => type === "DAMAGE").map(({ targetUnitId }) => targetUnitId), [2]);
});

test("release dispatch reads replacements for selected IDs and defers newly registered IDs", () => {
    const seen = [];
    let registered = false;
    const replacement = hook("version", (current) => { seen.push("new-version"); return { state: current, value: undefined }; });
    const late = hook("late", (current) => { seen.push("late"); return { state: current, value: undefined }; });
    const f = fixture({ windupTicks: 10, withSkill: false });
    let state = changeAction(f.state, (action) => setReleasedHook(action, hook("register", (current) => {
        seen.push("register");
        if (registered) return { state: current, value: undefined };
        registered = true;
        return { state: changeAction(current, (latest) => setReleasedHook(setReleasedHook(latest, replacement), late)), value: undefined };
    })));
    state = changeAction(state, (action) => setReleasedHook(action, hook("stable", (current) => { seen.push("stable"); return { state: current, value: undefined }; })));
    state = changeAction(state, (action) => setReleasedHook(action, hook("version", () => assert.fail("the selected old version was replaced"))));
    const started = actions.start(state, f.ref, f.definition);
    state = released(started.state, started.value.ref);
    assert.deepEqual(seen, ["register", "stable", "new-version"]);
    state = released(state, started.value.ref);
    assert.deepEqual(seen, ["register", "stable", "new-version", "register", "stable", "new-version", "late"]);
    assert.equal(state.events.some(({ type }) => type === "DAMAGE"), false);
});

test("generic Action start and step do not implicitly emit a release or grant ACTION SP", () => {
    const definition = {
        id: "store-energy", intervalTicks: 30, speed: 100,
        initialize: (state) => ({ state, value: {} }),
        start: (state) => ({ state, value: {} }),
        step: (state) => ({ state, value: true }),
    };
    const f = fixture({ action: definition });
    const state = changeAction(f.state, (action) => setReleasedHook(action, hook("unreleased", () => assert.fail("generic scheduling does not emit a release"))));
    const started = actions.start(state, f.ref, f.definition);
    assert.equal(getUnit(started.state, 0).skill.sp.value, 0);
    assert.equal(started.state.events.some(({ type }) => type === "ACTION_RELEASED"), false);
});


test("release observers stop after their Action ends and retain the completed observer's state", () => {
    const f = fixture({ windupTicks: 10, withSkill: false });
    let fixed;
    let state = changeAction(f.state, action => setReleasedHook(action, {
        id: "finish",
        invoke(state, context) {
            fixed = context;
            return { state: actions.cancel(state, context.action, "HOOK_CANCELLED"), value: undefined };
        },
    }));
    state = changeAction(state, action => setReleasedHook(action, {
        id: "later",
        invoke: () => assert.fail("the released Action already ended"),
    }));
    const started = actions.start(state, f.ref, f.definition);
    const next = released(started.state, started.value.ref);
    assert.equal(fixed.action, started.value.ref);
    assert.equal(fixed.source.id, f.ref.id);
    assert.equal(actions.get(next, fixed.action), undefined);
    assert.equal(next.events.at(-1).type, "ACTION_CANCELLED");
    assert.equal(actions.get(started.state, started.value.ref).status, "RUNNING");
});
