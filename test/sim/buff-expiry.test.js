import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compileBuffStacking, parseBuffStacking } from "../../dist/data/arknights/buff-stacking.js";
import { compileAttributeModifiers, parseAttributeModifiers } from "../../dist/data/arknights/modifier.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { combatWorkView, getCombatUnit } from "../../dist/core/tactical/battle/execution/work.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import {
    expireEffects, installNewEffect, setEffectEnabled, setEffectExpiration, updateEffectState,
} from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { attack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { effectFixtureWork } from "../helpers/effects.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/arknights/buff_stacking.json", import.meta.url), "utf8"));
const native = key => fixture.fixtures.find(({ buff }) => buff.buffKey === key).buff;
const description = (patch = {}) => ({
    overrideType: "STACK", maxStackCnt: 6, maxValidStackCnt: -1,
    refreshRemainingTimeWhenStackMax: false, clearAllStackCntWhenTimeUp: false,
    takeSnapshotWhenExtend: false, ...patch,
});
const application = (stackCount, expiresAtTick = 30) => ({ stackCount, expiresAtTick });
const refresh = (stackCount, expiresAtTick, reloadModifiers) => ({
    type: "REFRESH", stackCount, expiresAtTick, reloadModifiers,
});
const instance = work => getCombatUnit(work, 0).effects.instances[0];
const power = work => resolveAttackPower(0, combatWorkView(work));
const address = { unitId: 0, instanceId: 0 };

test("buff expiry: a native STACK descriptor peels one layer and resets the caller's fixed lifetime", () => {
    const rule = compileBuffStacking(parseBuffStacking(native("sbell2_e_002_trait[interval]")));
    const current = Object.freeze(application(3));
    assert.deepEqual(rule.expire(current, 30, 30), refresh(2, 60, true));
    assert.deepEqual(rule.expire(application(2, 60), 30, 60), refresh(1, 90, true));
    assert.deepEqual(rule.expire(application(1, 90), 30, 90), { type: "FINISH" });
    assert.deepEqual(current, application(3));
    assert.ok(Object.isFrozen(rule.expire(current, 30, 30)));
    assert.deepEqual(rule.expire(application(4), 30, 300), refresh(3, 330, true));
    assert.deepEqual(rule.expire(current, null, 30), refresh(2, null, true));
});

test("buff expiry: native clear-all and every non-STACK policy finish without a refresh plan", () => {
    const clearAll = compileBuffStacking(parseBuffStacking(native("ascln_t_1[debuff]")));
    assert.equal(native("ascln_t_1[debuff]").clearAllStackCntWhenTimeUp, true);
    assert.deepEqual(clearAll.expire(application(10), 30, 30), { type: "FINISH" });
    for (const overrideType of ["DEFAULT", "UNIQUE", "EXTEND", "EXTEND_TIME"]) {
        const rule = compileBuffStacking(description({ overrideType }));
        assert.deepEqual(rule.expire(application(10), 30, 30), { type: "FINISH" });
    }
    const stack = compileBuffStacking(description());
    for (const count of [0, 1]) {
        assert.deepEqual(stack.expire(application(count), 0, 30), { type: "FINISH" });
    }
});

test("buff expiry: raw counts above the effective cap skip reload until they reach the exact cap", () => {
    const rule = compileBuffStacking(description({ maxValidStackCnt: 2 }));
    assert.deepEqual(rule.expire(application(4), 30, 30), refresh(3, 60, false));
    assert.deepEqual(rule.expire(application(3, 60), 30, 60), refresh(2, 90, true));
    assert.deepEqual(rule.expire(application(2, 90), 30, 90), refresh(1, 120, true));
    const zero = compileBuffStacking(description({ maxValidStackCnt: 0 }));
    assert.deepEqual(zero.expire(application(2), 30, 30), refresh(1, 60, false));
    const unlimited = compileBuffStacking(description({ maxValidStackCnt: -7 }));
    assert.deepEqual(unlimited.expire(application(4), 30, 30), refresh(3, 60, true));
});

test("buff expiry: zero lifetime advances one tick, while invalid inputs and overflow fail", () => {
    const rule = compileBuffStacking(description());
    assert.deepEqual(rule.expire(application(3, 0), 0, 0), refresh(2, 1, true));
    for (const value of [-1, 0.5, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => rule.expire(application(3), value, 30), /safe integer/);
    }
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => rule.expire(application(3), 30, value), /safe integer/);
        assert.throws(() => rule.expire(application(value), 30, 30), /safe integer/);
        assert.throws(() => rule.expire(application(3, value), 30, 30), /safe integer/);
    }
    assert.throws(() => rule.expire(application(3), 30, Number.MAX_SAFE_INTEGER), /safe integer/);
    assert.deepEqual(rule.expire(application(3), null, Number.MAX_SAFE_INTEGER), refresh(2, null, true));
});

function harness({ descriptor = description(), stackCount = 3, lifetimeTicks = 30, expiresAtTick = 30 } = {}) {
    const policy = compileBuffStacking(descriptor);
    const [modifier] = compileAttributeModifiers(parseAttributeModifiers([{
        attributeType: "ATK", formulaItem: "MULTIPLIER", value: 0.5,
        loadFromBlackboard: true, fetchBaseValueFromSourceEntity: true,
    }]));
    const sources = new Map([[10, 100], [20, 1000]]);
    const reads = [];
    const expirations = [];
    let starts = 0;
    const sample = (source, count) => {
        const sourceAttack = sources.get(source);
        reads.push([source, sourceAttack]);
        return { sourceAttack, stackCount: policy.validStackCount(count) };
    };
    const initial = {
        stackCount, lifetimeTicks, priority: 1,
        blackboard: { atk: 0.5 }, sample: sample(10, stackCount),
    };
    const resources = new CombatResources();
    const effect = resources.registerEffect(createEffectProgram({
        id: "buff-expiry-sample", initialize: () => initial,
        ownState: state => ({ ...state, blackboard: { ...state.blackboard }, sample: { ...state.sample } }),
    }), {
        contributions: [attack(current => {
            const value = modifier.sample({
                blackboard: new Map(Object.entries(current.state.blackboard)), stackCount: current.state.sample.stackCount,
                readSourceAttribute: () => current.state.sample.sourceAttack,
            });
            return value === undefined ? [] : [value];
        })],
        lifecycle: {
            start: () => { starts++; },
            competition: current => ({ group: "buff-expiry", priority: current.state.priority }),
            expire: context => {
                const plan = policy.expire({
                    stackCount: context.instance.state.stackCount,
                    expiresAtTick: context.instance.expiresAtTick,
                    maxStackCount: context.instance.state.maxStackCount,
                }, context.instance.state.lifetimeTicks, context.tick);
                expirations.push({ tick: context.tick, plan });
                if (plan.type === "FINISH") {
                    context.effects.finish(context.address);
                } else {
                    const source = context.instance.source;
                    context.effects.setExpiration(context.address, plan.expiresAtTick);
                    context.effects.update(context.address, effect.ref, state => ({
                        ...state, stackCount: plan.stackCount,
                        sample: plan.reloadModifiers ? sample(source, plan.stackCount) : state.sample,
                    }));
                }
            },
        },
    });
    let work = installNewEffect(effectFixtureWork(initializeUnit({
        id: 0, position: [0, 0], definition: { id: "buff-owner", offense: { attack: 100 } },
    })), 0, effect.ref, { source: 10, scope: null, expiresAtTick, initialState: initial }, resources, 0).work;
    return {
        get work() { return work; },
        get starts() { return starts; },
        reads, expirations,
        sourceAttack: (source, value) => { sources.set(source, value); },
        expire: tick => { work = expireEffects(work, tick, resources); },
        disable: tick => { work = setEffectEnabled(work, address, false, resources, tick); },
        setCap: (maxStackCount, tick) => {
            work = updateEffectState(work, 0, 0, effect.ref, state => ({ ...state, maxStackCount }), resources, tick);
        },
        override: tick => {
            const winner = resources.registerEffect(createEffectProgram({
                id: "buff-expiry-winner", initialize: () => ({}), ownState: state => ({ ...state }),
            }), { lifecycle: { competition: () => ({ group: "buff-expiry", priority: 2 }) } });
            work = installNewEffect(work, 0, winner.ref, { source: 20, scope: null, expiresAtTick: null }, resources, tick).work;
        },
        apply: (expiresAtTick, tick, maxStackCount = undefined) => {
            const current = instance(work);
            const incoming = {
                stackCount: 1, expiresAtTick, maxStackCount,
                source: 20, blackboard: { atk: 0.9 },
            };
            const plan = policy.plan({
                stackCount: current.state.stackCount, expiresAtTick: current.expiresAtTick,
                maxStackCount: current.state.maxStackCount,
            }, incoming, tick);
            if (plan.type === "REFRESH") {
                work = setEffectExpiration(work, address, plan.expiresAtTick);
                work = updateEffectState(work, 0, 0, effect.ref, state => ({
                    ...state, stackCount: plan.stackCount,
                    sample: plan.reloadModifiers ? sample(current.source, plan.stackCount) : state.sample,
                }), resources, tick);
            }
            return plan;
        },
    };
}

test("buff expiry integration: 30 tick renewals preserve identity, retain terminal history, and isolate old snapshots", () => {
    const buff = harness();
    const original = buff.work;
    const first = instance(original);
    assert.equal(power(original), 250);
    buff.expire(29);
    assert.equal(buff.work, original);
    buff.expire(30);
    const renewed = buff.work;
    assert.equal(instance(renewed).state.stackCount, 2);
    assert.equal(instance(renewed).expiresAtTick, 60);
    assert.equal(power(renewed), 200);
    for (const key of ["id", "source", "programRef", "acquiredSequence", "scope", "parent"]) {
        assert.deepEqual(instance(renewed)[key], first[key]);
    }
    assert.notEqual(instance(renewed).state.blackboard, first.state.blackboard);
    assert.notEqual(instance(renewed).state.sample, first.state.sample);
    buff.expire(60);
    assert.equal(instance(buff.work).state.stackCount, 1);
    assert.equal(power(buff.work), 150);
    const last = instance(buff.work);
    buff.expire(90);
    assert.equal(instance(buff.work).finished, true);
    assert.equal(instance(buff.work).participating, false);
    assert.equal(instance(buff.work).state.stackCount, 1);
    assert.deepEqual(instance(buff.work).state.sample, last.state.sample);
    assert.equal(power(buff.work), 100);
    const finished = buff.work;
    buff.expire(120);
    assert.equal(buff.work, finished);
    assert.equal(buff.expirations.length, 3);
    assert.equal(buff.starts, 1);
    assert.equal(instance(original).state.stackCount, 3);
    assert.equal(power(original), 250);
    assert.equal(power(renewed), 200);
});

test("buff expiry integration: disabled and overridden buffs still peel and finish on schedule", () => {
    for (const inactive of ["disabled", "overridden"]) {
        const buff = harness({ stackCount: 2 });
        if (inactive === "disabled") buff.disable(1);
        else buff.override(1);
        assert.equal(instance(buff.work).participating, false);
        assert.equal(power(buff.work), 100);
        buff.expire(30);
        assert.equal(instance(buff.work).state.stackCount, 1);
        assert.equal(instance(buff.work).expiresAtTick, 60);
        assert.equal(instance(buff.work).enabled, inactive !== "disabled");
        assert.equal(instance(buff.work).participating, false);
        buff.expire(60);
        assert.equal(instance(buff.work).finished, true);
        assert.equal(power(buff.work), 100);
        assert.equal(buff.expirations.length, 2);
    }
});

test("buff expiry integration: extended remaining time does not replace the original lifetime", () => {
    const buff = harness({ stackCount: 1 });
    assert.equal(buff.apply(75, 15, 0).type, "REFRESH");
    assert.equal(instance(buff.work).expiresAtTick, 75);
    assert.equal(instance(buff.work).state.lifetimeTicks, 30);
    buff.expire(74);
    assert.equal(buff.expirations.length, 0);
    buff.expire(75);
    assert.equal(instance(buff.work).state.stackCount, 1);
    assert.equal(instance(buff.work).expiresAtTick, 105);
    buff.expire(105);
    assert.equal(instance(buff.work).finished, true);
});

test("buff expiry integration: exact effective cap reloads only the retained source and preserves previous projections", () => {
    const buff = harness({ descriptor: description({ maxValidStackCnt: 2 }), stackCount: 4 });
    const original = buff.work;
    buff.sourceAttack(10, 200);
    buff.expire(30);
    const aboveCap = buff.work;
    assert.equal(instance(aboveCap).state.stackCount, 3);
    assert.deepEqual(buff.reads, [[10, 100]]);
    assert.equal(power(aboveCap), 200);
    buff.sourceAttack(10, 400);
    buff.sourceAttack(20, 9000);
    buff.expire(60);
    assert.equal(instance(buff.work).state.stackCount, 2);
    assert.equal(instance(buff.work).source, 10);
    assert.equal(instance(buff.work).state.priority, 1);
    assert.deepEqual(buff.reads, [[10, 100], [10, 400]]);
    assert.equal(power(buff.work), 500);
    assert.equal(power(original), 200);
    assert.equal(power(aboveCap), 200);
    assert.equal(instance(aboveCap).state.sample.sourceAttack, 100);
    assert.equal(getCombatUnit(buff.work, 0).effects.instances.length, 1);
});

test("buff expiry integration: merging and expiration resample the first source without replacing its blackboard", () => {
    const buff = harness({ descriptor: description({ maxValidStackCnt: 2 }), stackCount: 1 });
    const original = buff.work;
    buff.sourceAttack(10, 200);
    assert.equal(buff.apply(60, 1).reloadModifiers, true);
    const merged = buff.work;
    assert.equal(instance(merged).source, 10);
    assert.equal(instance(merged).state.blackboard.atk, 0.5);
    assert.deepEqual(buff.reads, [[10, 100], [10, 200]]);
    assert.equal(power(merged), 300);
    buff.sourceAttack(10, 400);
    buff.expire(60);
    assert.equal(instance(buff.work).source, 10);
    assert.equal(instance(buff.work).state.blackboard.atk, 0.5);
    assert.deepEqual(buff.reads, [[10, 100], [10, 200], [10, 400]]);
    assert.equal(power(buff.work), 300);
    assert.equal(instance(original).state.sample.sourceAttack, 100);
    assert.equal(instance(merged).state.sample.sourceAttack, 200);
    assert.equal(instance(merged).state.stackCount, 2);
});

test("buff expiry integration: dynamic caps preserve raw count and samples until a raised cap permits a merge", () => {
    const buff = harness({ descriptor: description({ maxValidStackCnt: 2 }), stackCount: 4 });
    const original = buff.work;
    buff.sourceAttack(10, 800);
    buff.setCap(2, 1);
    assert.equal(instance(buff.work).state.stackCount, 4);
    assert.equal(instance(buff.work).state.sample.sourceAttack, 100);
    assert.equal(instance(buff.work).state.priority, 1);
    assert.deepEqual(buff.reads, [[10, 100]]);
    assert.equal(power(buff.work), 200);
    const capped = buff.work;
    assert.equal(buff.apply(90, 2, null).type, "REJECT");
    assert.equal(buff.work, capped);
    buff.setCap(5, 3);
    const raised = buff.work;
    assert.deepEqual(buff.reads, [[10, 100]]);
    assert.equal(buff.apply(90, 4, 0).type, "REFRESH");
    assert.equal(instance(buff.work).state.stackCount, 5);
    assert.equal(instance(buff.work).state.maxStackCount, 5);
    assert.equal(instance(buff.work).expiresAtTick, 90);
    assert.deepEqual(buff.reads, [[10, 100]]);
    assert.equal(power(buff.work), 200);
    assert.equal(instance(original).state.maxStackCount, undefined);
    assert.equal(instance(raised).state.stackCount, 4);
    buff.setCap(null, 5);
    assert.equal(buff.apply(100, 6, 0).type, "REFRESH");
    assert.equal(instance(buff.work).state.stackCount, 6);
    assert.equal(instance(buff.work).source, 10);
});

test("buff expiry integration: zero duration peels once per tick and an overdue deadline never catches up", () => {
    const zero = harness({ lifetimeTicks: 0, expiresAtTick: 0 });
    zero.expire(0);
    assert.equal(instance(zero.work).state.stackCount, 2);
    assert.equal(instance(zero.work).expiresAtTick, 1);
    zero.expire(0);
    assert.equal(zero.expirations.length, 1);
    zero.expire(1);
    assert.equal(instance(zero.work).state.stackCount, 1);
    zero.expire(2);
    assert.equal(instance(zero.work).finished, true);
    const late = harness({ stackCount: 4 });
    late.expire(300);
    assert.equal(instance(late.work).state.stackCount, 3);
    assert.equal(instance(late.work).expiresAtTick, 330);
    assert.equal(late.expirations.length, 1);
    late.expire(300);
    assert.equal(late.expirations.length, 1);
});

test("buff expiry integration: the native clear-all descriptor immediately stops every layer's contribution", () => {
    const buff = harness({ descriptor: parseBuffStacking(native("ascln_t_1[debuff]")), stackCount: 4 });
    buff.expire(30);
    assert.deepEqual(buff.expirations, [{ tick: 30, plan: { type: "FINISH" } }]);
    assert.equal(instance(buff.work).finished, true);
    assert.equal(instance(buff.work).state.stackCount, 4);
    assert.equal(power(buff.work), 100);
    assert.deepEqual(buff.reads, [[10, 100]]);
});
