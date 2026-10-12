import { deadline } from "../../dist/core/tactical/unit/effect/effect.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compileBuffStacking, parseBuffStacking } from "../../dist/data/arknights/buff-stacking.js";
import {
    compileAttributeModifiers,
    parseAttributeModifiers,
} from "../../dist/data/arknights/modifier.js";

import { battlefieldView, getUnit } from "../../dist/core/tactical/battle/execution/context.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import {
    setAttackContribution,
    removeAttackContribution,
} from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import {
    contributionEffect,
    refreshContribution,
    at,
    effectFixtureWork,
} from "../helpers/effects.js";

const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/arknights/buff_stacking.json", import.meta.url), "utf8"),
);
const native = (key) => fixture.fixtures.find(({ buff }) => buff.buffKey === key).buff;
const description = (patch = {}) => ({
    overrideType: "STACK",
    maxStackCnt: 6,
    maxValidStackCnt: -1,
    refreshRemainingTimeWhenStackMax: false,
    clearAllStackCntWhenTimeUp: false,
    takeSnapshotWhenExtend: false,
    ...patch,
});
const application = (stackCount, expiresAtTick = 30) => ({ stackCount, expiresAtTick });
const refresh = (stackCount, expiresAtTick, reloadModifiers) => ({
    type: "REFRESH",
    stackCount,
    expiresAtTick,
    reloadModifiers,
});
const instance = (view) => view.getUnit(0).effects.instances[0];
const power = (view) => resolveAttackPower(0, view);
const address = { type: "EFFECT", unitId: 0, effectId: 0 };

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
    assert.deepEqual(
        rule.expire(application(3), null, Number.MAX_SAFE_INTEGER),
        refresh(2, null, true),
    );
});

function harness({ stackCount = 3, maxValidStackCnt = -1 } = {}) {
    const policy = compileBuffStacking(description({ maxValidStackCnt }));
    const [compiled] = compileAttributeModifiers(
        parseAttributeModifiers([
            {
                attributeType: "ATK",
                formulaItem: "MULTIPLIER",
                value: 0.5,
                loadFromBlackboard: false,
                fetchBaseValueFromSourceEntity: true,
            },
        ]),
    );
    let sourceAttack = 100;
    const samples = [];
    const sample = (count) => {
        samples.push(sourceAttack);
        return { sourceAttack, stackCount: policy.validStackCount(count) };
    };
    const output = {
        set: setAttackContribution,
        remove: removeAttackContribution,
        value: (current) => [
            compiled.sample({
                blackboard: new Map(),
                stackCount: current.state.sample.stackCount,
                readSourceAttribute: () => current.state.sample.sourceAttack,
            }),
        ],
    };
    let content;
    content = contributionEffect(
        "layered-buff",
        { stackCount, lifetimeTicks: 30, sample: sample(stackCount) },
        output,
        {
            onTick(ctx) {
                if (ctx.tick < deadline(ctx.self)) return;
                const plan = policy.expire(
                    { stackCount: ctx.self.state.stackCount, expiresAtTick: deadline(ctx.self) },
                    ctx.self.state.lifetimeTicks,
                    ctx.tick,
                );
                if (plan.type === "FINISH") ctx.end("EXPIRED");
                else {
                    effects.setDeadline(ctx.battle, ctx.ref, plan.expiresAtTick);
                    ctx.setState((state) => ({
                        ...state,
                        stackCount: plan.stackCount,
                        sample: plan.reloadModifiers ? sample(plan.stackCount) : state.sample,
                    }));
                    refreshContribution(ctx.battle, ctx.ref, content, output);
                }
            },
        },
    );
    const work = effectFixtureWork(
        initializeUnit({
            id: 0,
            position: [0, 0],
            definition: { id: "receiver", offense: { attack: 100 } },
        }),
    );
    const ref = effects.install(work, getUnit(work, 0), content, {
        source: 10,
        scopes: [{ type: "TICK", tick: 30 }],
    });
    return {
        work,
        ref,
        content,
        samples,
        source: (value) => {
            sourceAttack = value;
        },
        tick: (tick) => effects.advance(at(work, tick)),
    };
}

test("buff expiry content renews private layers and refreshes static contribution at its tick callback", () => {
    const buff = harness();
    const before = battlefieldView(buff.work);
    const id = instance(before).id;
    assert.equal(power(before), 250);
    buff.tick(29);
    assert.equal(power(battlefieldView(buff.work)), 250);
    buff.tick(30);
    assert.equal(instance(battlefieldView(buff.work)).id, id);
    assert.equal(deadline(instance(battlefieldView(buff.work))), 60);
    assert.equal(power(battlefieldView(buff.work)), 200);
    buff.tick(60);
    assert.equal(power(battlefieldView(buff.work)), 150);
    buff.tick(90);
    assert.equal(instance(battlefieldView(buff.work)), undefined);
    assert.equal(power(battlefieldView(buff.work)), 100);
    assert.equal(power(before), 250);
    assert.equal(instance(before).state.stackCount, 3);
});
test("inactive layered buffs reach deadline without executing their active tick behavior", () => {
    const buff = harness({ stackCount: 2 });
    effects.setEnabled(buff.work, buff.ref, false);
    buff.tick(30);
    assert.equal(instance(battlefieldView(buff.work)), undefined);
    assert.equal(power(battlefieldView(buff.work)), 100);
    assert.deepEqual(buff.samples, [100]);
});
test("native effective cap preserves sampled input until a renewal requires resampling", () => {
    const buff = harness({ stackCount: 4, maxValidStackCnt: 2 });
    const original = battlefieldView(buff.work);
    buff.source(200);
    buff.tick(30);
    assert.equal(instance(battlefieldView(buff.work)).state.stackCount, 3);
    assert.deepEqual(buff.samples, [100]);
    assert.equal(power(battlefieldView(buff.work)), 200);
    buff.source(400);
    buff.tick(60);
    assert.equal(instance(battlefieldView(buff.work)).state.stackCount, 2);
    assert.deepEqual(buff.samples, [100, 400]);
    assert.equal(power(battlefieldView(buff.work)), 500);
    assert.equal(power(original), 200);
});
