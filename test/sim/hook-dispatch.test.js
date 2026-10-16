import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureBattle } from "../helpers/unit.js";
import { dispatch } from "../../dist/core/tactical/unit/hook/hook.js";

const withDp = (battle, dp) => ({ ...battle, deployment: { ...battle.deployment, dp } });
const initial = () => withDp(fixtureBattle(), 0);

test("Hook dispatch fixes context while forwarding the latest battle and operation value", () => {
    const context = { activation: { id: 7, status: "ACTIVE" } };
    const battle = initial();
    const ids = ["first", "second"];
    const hooks = [
        {
            id: "first",
            invoke(state, event, current) {
                assert.equal(event, context);
                ids.pop();
                return { state: withDp(state, 3), value: current + 2 };
            },
        },
        {
            id: "second",
            accepts(state, event, current) {
                assert.equal(event, context);
                assert.equal(event.activation.id, 7);
                assert.equal(state.deployment.dp, 3);
                assert.equal(current, 7);
                return true;
            },
            invoke(state, event, current) {
                assert.equal(event, context);
                return { state: withDp(state, 8), value: current * 2 };
            },
        },
    ];
    let selections = 0;
    const result = dispatch(battle, context, 5, {
        candidates: () => { selections++; return ids; },
        find: (_state, id) => hooks.find(hook => hook.id === id),
    });
    assert.equal(selections, 1);
    assert.equal(result.value, 14);
    assert.equal(result.state.deployment.dp, 8);
    assert.equal(battle.deployment.dp, 0);
    assert.deepEqual(context, { activation: { id: 7, status: "ACTIVE" } });
});

test("Hook dispatch rereads replacements, skips removals and does not append new identities", () => {
    const seen = [];
    const first = {
        id: "first",
        invoke(state, _context, value) {
            seen.push("first");
            return { state: withDp(state, 1), value: value + 1 };
        },
    };
    const versions = [
        [first,
            { id: "second", accepts: () => false, invoke: () => assert.fail("stale Hook") },
            { id: "removed", invoke: () => assert.fail("removed Hook") },
        ],
        [first,
            { id: "added", invoke: () => assert.fail("new ID in outer dispatch") },
            { id: "second", invoke: (state, _context, value) => {
                seen.push("replacement"); return { state, value: value * 2 };
            } },
        ],
    ];
    const result = dispatch(initial(), {}, 5, {
        candidates: state => versions[state.deployment.dp].map(hook => hook.id),
        find: (state, id) => versions[state.deployment.dp].find(hook => hook.id === id),
    });
    assert.deepEqual(seen, ["first", "replacement"]);
    assert.equal(result.value, 12);
    assert.equal(result.state.deployment.dp, 1);
});

test("nested dispatch has independent context, current and candidates and forwards only its returned state", () => {
    const seen = [];
    const first = {
        id: "first",
        invoke(state, context, value) {
            seen.push([context.event, "first", value]);
            if (context.event === "outer") {
                const nested = dispatch(withDp(state, 1), { event: "inner" }, 100, options);
                assert.equal(nested.value, 203);
                state = nested.state;
            }
            return { state, value: value + 1 };
        },
    };
    const versions = [
        [first, { id: "second", invoke: () => assert.fail("stale Hook") }],
        [first,
            { id: "second", invoke: (state, context, value) => {
                seen.push([context.event, "second", value]); return { state, value: value * 2 };
            } },
            { id: "third", invoke: (state, context, value) => {
                seen.push([context.event, "third", value]); return { state, value: value + 1 };
            } },
        ],
    ];
    const options = {
        candidates: state => versions[state.deployment.dp].map(hook => hook.id),
        find: (state, id) => versions[state.deployment.dp].find(hook => hook.id === id),
    };
    const result = dispatch(initial(), { event: "outer" }, 5, options);
    assert.deepEqual(seen, [
        ["outer", "first", 5], ["inner", "first", 100],
        ["inner", "second", 101], ["inner", "third", 202],
        ["outer", "second", 6],
    ]);
    assert.equal(result.value, 12);
    assert.equal(result.state.deployment.dp, 1);
});

test("accepts=false and missing registrations leave the state and current value intact", () => {
    const battle = initial();
    let calls = 0;
    const result = dispatch(battle, {}, 5, {
        candidates: () => ["missing", "rejected"],
        find: (_state, id) => id === "missing" ? undefined : {
            id,
            accepts(state, _context, value) {
                calls++;
                assert.equal(state, battle);
                assert.equal(value, 5);
                return false;
            },
            invoke: () => assert.fail("rejected Hook"),
        },
    });
    assert.equal(calls, 1);
    assert.equal(result.state, battle);
    assert.equal(result.value, 5);
});

for (const stop of [
    state => state.deployment.dp === 1,
    (_state, value) => value === 9,
]) {
    test(`dispatch stops on ${stop.length === 1 ? "battle facts" : "the operation value"} and retains completed work`, () => {
        const result = dispatch(initial(), {}, 5, {
            candidates: () => ["first", "unreachable"],
            find: (_state, id) => {
                assert.equal(id, "first");
                return { id, invoke: state => ({ state: withDp(state, 1), value: 9 }) };
            },
            stop,
        });
        assert.equal(result.state.deployment.dp, 1);
        assert.equal(result.value, 9);
    });
}

test("void context and void current do not suppress notification Hooks", () => {
    const result = dispatch(initial(), undefined, undefined, {
        candidates: () => ["notification"],
        find: (_state, id) => ({
            id,
            invoke(state, context, current) {
                assert.equal(context, undefined);
                assert.equal(current, undefined);
                return { state: withDp(state, 1), value: undefined };
            },
        }),
    });
    assert.equal(result.state.deployment.dp, 1);
    assert.equal(result.value, undefined);
});
