import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compileBuffStacking, parseBuffStacking } from "../../dist/data/arknights/buff-stacking.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/arknights/buff_stacking.json", import.meta.url), "utf8"));
const native = (key) => fixture.fixtures.find(({ buff }) => buff.buffKey === key).buff;
const compileNative = (key) => compileBuffStacking(parseBuffStacking(native(key)));
const description = (overrideType, patch = {}) => ({
    overrideType, maxStackCnt: 1, maxValidStackCnt: -1,
    refreshRemainingTimeWhenStackMax: false, takeSnapshotWhenExtend: false, ...patch,
});
const application = (stackCount, expiresAtTick) => ({ stackCount, expiresAtTick });
const refresh = (stackCount, expiresAtTick, takeSnapshot = false, reloadModifiers = false) => ({ type: "REFRESH", stackCount, expiresAtTick, takeSnapshot, reloadModifiers });

test("buff stacking: complete native descriptors normalize numeric and named policies", () => {
    for (const raw of fixture.fixtures.map(({ buff }) => buff)) {
        const parsed = parseBuffStacking(raw);
        const numeric = ["DEFAULT", "STACK", "UNIQUE", "EXTEND", "EXTEND_TIME"].indexOf(raw.overrideType);
        assert.deepEqual(parsed, parseBuffStacking({ ...raw, overrideType: numeric }));
        assert.ok(Object.isFrozen(parsed));
        assert.deepEqual(Object.keys(parsed).sort(), ["maxStackCnt", "maxValidStackCnt", "overrideType", "refreshRemainingTimeWhenStackMax", "takeSnapshotWhenExtend"].sort());
    }
    assert.equal(parseBuffStacking({ ...description("STACK"), unrelatedNativeField: { value: "owned elsewhere" } }).overrideType, "STACK");
});

test("buff stacking: parsing requires only the policy subset with strict values", () => {
    for (const value of [null, [], 1, "STACK"]) {
        assert.throws(() => parseBuffStacking(value), /object/);
    }
    for (const overrideType of ["UNKNOWN", 5, true, null]) {
        assert.throws(() => parseBuffStacking(description(overrideType)), /overrideType/);
    }
    for (const field of ["maxStackCnt", "maxValidStackCnt"]) {
        for (const value of [undefined, null, "5", 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(() => parseBuffStacking(description("STACK", { [field]: value })), /safe integer/);
        }
    }
    for (const field of ["refreshRemainingTimeWhenStackMax", "takeSnapshotWhenExtend"]) {
        assert.throws(() => parseBuffStacking(description("STACK", { [field]: undefined })), /flags/);
        assert.throws(() => parseBuffStacking(description("STACK", { [field]: 1 })), /flags/);
    }
});

test("buff stacking: new applications install without clipping counts and DEFAULT keeps independent instances", () => {
    const incoming = application(1, 30);
    for (const overrideType of ["DEFAULT", "STACK", "UNIQUE", "EXTEND", "EXTEND_TIME"]) {
        const rule = compileBuffStacking(description(overrideType, { maxStackCnt: 0, maxValidStackCnt: 0 }));
        assert.deepEqual(rule.plan(undefined, incoming, 10), { type: "INSTALL" });
        assert.equal(incoming.stackCount, 1);
        assert.equal(rule.validStackCount(1), 0);
    }
    const rule = compileNative("skadi2_t_2[atk][2]");
    assert.deepEqual(rule.plan(application(1, 100), incoming, 10), { type: "INSTALL" });
});

test("buff stacking: actual native layers grow independently of the effective contribution cap", () => {
    const unlimited = compileNative("sbell2_e_002_trait[interval]");
    assert.deepEqual(unlimited.plan(application(5, 20), application(100, 30), 10), refresh(6, 30));
    assert.equal(unlimited.validStackCount(6), 5);
    const bounded = compileNative("enemy_shushu_support");
    assert.deepEqual(bounded.plan(application(19, 40), application(1, 30), 10), refresh(20, 40));
    assert.equal(bounded.validStackCount(20), 1);
    assert.deepEqual(bounded.plan(application(20, 40), application(1, 100), 10), { type: "REJECT" });
});

test("buff stacking: native capped STACK rejects without modifying the original application", () => {
    const rule = compileNative("astesi_t_1[Stack]");
    const current = Object.freeze(application(5, 20));
    const incoming = Object.freeze(application(1, 30));
    assert.deepEqual(rule.plan(current, incoming, 10), { type: "REJECT" });
    assert.deepEqual(current, application(5, 20));
    assert.deepEqual(incoming, application(1, 30));
    assert.deepEqual(rule.plan(application(4, 20), incoming, 10), refresh(5, 30, false, true));
});

test("buff stacking: native refresh at the actual cap extends time without a new layer or snapshot", () => {
    const rule = compileNative("ascln_t_1[debuff]");
    assert.deepEqual(rule.plan(application(1, 20), application(99, 30), 10), refresh(1, 30));
    assert.deepEqual(rule.plan(application(1, 40), application(1, 30), 10), refresh(1, 40));
    assert.deepEqual(rule.plan(application(2, 20), application(1, 30), 10), { type: "REJECT" });
});

test("buff stacking: every negative cap is unlimited, while zero effective layers remain valid", () => {
    const rule = compileBuffStacking(description("STACK", { maxStackCnt: -7, maxValidStackCnt: -2 }));
    assert.deepEqual(rule.plan(application(100, 20), application(1, 30), 10), refresh(101, 30, false, true));
    assert.equal(rule.validStackCount(101), 101);
    assert.equal(rule.validStackCount(0), 0);
    const zero = compileBuffStacking(description("STACK", { maxStackCnt: 0, maxValidStackCnt: 0, refreshRemainingTimeWhenStackMax: true }));
    assert.deepEqual(zero.plan(application(1, 20), application(1, 30), 10), { type: "REJECT" });
    assert.equal(zero.validStackCount(10), 0);
});

test("buff stacking: native UNIQUE rejects repeated applications including a snapshot flag", () => {
    for (const key of ["blower_s[atk]", "sophia_e_shield_physical_kxml"]) {
        const raw = native(key);
        const rule = compileBuffStacking(parseBuffStacking(raw));
        const current = Object.freeze(application(1, 20));
        assert.deepEqual(rule.plan(current, application(1, 100), 10), { type: "REJECT" });
        assert.deepEqual(current, application(1, 20));
    }
    assert.equal(native("sophia_e_shield_physical_kxml").takeSnapshotWhenExtend, true);
});

test("buff stacking: native EXTEND fills the longest deadline and EXTEND_TIME adds remaining time", () => {
    const current = application(3, 20);
    const incoming = application(7, 30);
    const fill = compileNative("nothin_s_2[a][attack_speed_down]");
    const extend = compileNative("enemu_nstmom[weak_attr]");
    assert.deepEqual(fill.plan(current, incoming, 10), refresh(3, 30));
    assert.deepEqual(fill.plan(application(3, 40), incoming, 10), refresh(3, 40));
    assert.deepEqual(extend.plan(current, incoming, 10), refresh(3, 40));
});

test("buff stacking: only EXTEND requests the explicit snapshot and incoming blackboard copy", () => {
    for (const overrideType of ["STACK", "EXTEND", "EXTEND_TIME"]) {
        const rule = compileBuffStacking(description(overrideType, { maxStackCnt: 5, takeSnapshotWhenExtend: true }));
        const result = rule.plan(application(1, 20), application(10, 30), 10);
        assert.equal(result.type, "REFRESH");
        assert.equal(result.takeSnapshot, overrideType === "EXTEND");
        assert.equal(result.reloadModifiers, overrideType !== "EXTEND_TIME");
    }
});

test("buff stacking: growing effective layers reload retained-source samples without an EXTEND snapshot request", () => {
    const rule = compileNative("sbell2_e_002_trait[interval]");
    assert.deepEqual(rule.plan(application(4, 20), application(1, 30), 10), refresh(5, 30, false, true));
    assert.deepEqual(rule.plan(application(5, 20), application(1, 30), 10), refresh(6, 30));
    const zero = compileBuffStacking(description("STACK", { maxStackCnt: -1, maxValidStackCnt: 0 }));
    assert.deepEqual(zero.plan(application(0, 20), application(1, 30), 10), refresh(1, 30));
    const snapshot = compileBuffStacking(description("EXTEND", { takeSnapshotWhenExtend: true }));
    assert.deepEqual(snapshot.plan(application(1, 20), application(1, 30), 10), refresh(1, 30, true, true));
});

test("buff stacking: project policy treats null deadlines as infinite for both fill and additive extension", () => {
    for (const overrideType of ["STACK", "EXTEND", "EXTEND_TIME"]) {
        const rule = compileBuffStacking(description(overrideType, { maxStackCnt: -1 }));
        for (const [current, incoming] of [[application(1, null), application(1, 20)], [application(1, 20), application(1, null)], [application(1, null), application(1, null)]]) {
            const result = rule.plan(current, incoming, 10);
            assert.equal(result.type, "REFRESH");
            assert.equal(result.expiresAtTick, null);
        }
    }
});

test("buff stacking: zero remaining time receives no extra tick and cleanup belongs to the caller", () => {
    const extend = compileBuffStacking(description("EXTEND_TIME"));
    assert.deepEqual(extend.plan(application(1, 10), application(1, 10), 10), refresh(1, 10));
    assert.deepEqual(extend.plan(application(1, 9), application(1, 10), 10), refresh(1, 10));
    assert.deepEqual(extend.plan(application(1, 10), application(1, 20), 10), refresh(1, 20));
    const unique = compileBuffStacking(description("UNIQUE"));
    assert.deepEqual(unique.plan(application(1, 10), application(1, 20), 10), { type: "REJECT" });
});

test("buff stacking: compiled rules own their definition and planning leaves all inputs unchanged", () => {
    const raw = description("STACK", { maxStackCnt: 5 });
    const rule = compileBuffStacking(raw);
    raw.maxStackCnt = 1;
    raw.overrideType = "UNIQUE";
    const current = Object.freeze(application(1, 20));
    const incoming = Object.freeze(application(8, 30));
    const result = rule.plan(current, incoming, 10);
    assert.deepEqual(result, refresh(2, 30, false, true));
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(rule));
    assert.deepEqual(current, application(1, 20));
    assert.deepEqual(incoming, application(8, 30));
});

test("buff stacking: unsafe counts, tick values and extension arithmetic fail before returning a plan", () => {
    const stack = compileBuffStacking(description("STACK", { maxStackCnt: -1 }));
    for (const count of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => stack.validStackCount(count), /safe integer/);
        assert.throws(() => stack.plan(application(count, 20), application(1, 30), 10), /safe integer/);
        assert.throws(() => stack.plan(undefined, application(count, 30), 10), /safe integer/);
    }
    for (const value of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => stack.plan(undefined, application(1, 20), value), /safe integer/);
        assert.throws(() => stack.plan(undefined, application(1, value), 0), /safe integer/);
    }
    assert.throws(() => stack.plan(application(Number.MAX_SAFE_INTEGER, 20), application(1, 30), 10), /safe integer/);
    const extend = compileBuffStacking(description("EXTEND_TIME"));
    const maximum = Number.MAX_SAFE_INTEGER;
    assert.throws(() => extend.plan(application(1, maximum), application(1, maximum), 0), /remaining ticks/);
    assert.throws(() => extend.plan(application(1, maximum), application(1, maximum), maximum - 1), /expiration tick/);
    assert.deepEqual(extend.plan(application(1, maximum), application(1, maximum), maximum), refresh(1, maximum));
});
