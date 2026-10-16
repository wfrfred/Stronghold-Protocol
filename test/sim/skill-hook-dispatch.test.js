import assert from "node:assert/strict";
import { test } from "node:test";
import { setHook, removeHook } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import * as sp from "../../dist/core/tactical/unit/capability/skill/sp.js";
import { get as getHookHost, ref } from "../../dist/core/tactical/unit/query.js";
import { fixture, change } from "../helpers/skill.js";

const resource = { initial: 0, capacity: 10, requirement: 1, recovery: { type: "NONE" } };
const hook = (id, invoke, accepts = () => true) => ({ id, accepts, invoke });

for (const accepts of [true, false]) {
    test(`Skill dispatch uses a replacement's current accepts=${accepts} and program`, () => {
        const seen = [];
        const f = fixture({ sp: resource, activation: null });
        const replacement = hook("B", (battle) => { seen.push("new B"); return { state: battle, value: undefined }; }, (battle, { host, event }) => {
            const self = getHookHost(battle, host);

            seen.push(["new accepts", self.skill.data.ready, self.skill.sp.value, event.current]);
            return accepts;
        });
        const state = change(f.state, skill => ({ ...skill, spRecovered: [
            hook("A", (battle) => {
                seen.push("A");
                return { state: change(battle, skill => setHook({ ...skill, data: { ready: true } }, "spRecovered", replacement)), value: undefined };
            }),
            hook("B", (battle) => { seen.push("old B"); return { state: battle, value: undefined }; }, () => {
                seen.push("old accepts");
                return !accepts;
            }),
        ] }));
        sp.recover(state, f.ref, "EXTERNAL", 1);
        assert.deepEqual(seen, ["A", ["new accepts", true, 1, 1], ...(accepts ? ["new B"] : [])]);
    });
}

test("Skill dispatch skips a removed candidate and continues with surviving IDs", () => {
    const seen = [];
    const f = fixture({ sp: resource, activation: null });
    const state = change(f.state, skill => ({ ...skill, spRecovered: [
        hook("A", (battle) => { seen.push("A"); return { state: change(battle, skill => removeHook(skill, "spRecovered", "B")), value: undefined }; }),
        hook("B", (battle) => { seen.push("B"); return { state: battle, value: undefined }; }),
        hook("C", (battle) => { seen.push("C"); return { state: battle, value: undefined }; }),
    ] }));
    sp.recover(state, f.ref, "EXTERNAL", 1);
    assert.deepEqual(seen, ["A", "C"]);
});

test("Skill dispatch defers a newly registered ID until a later dispatch", () => {
    const seen = [];
    const f = fixture({ sp: resource, activation: null });
    const added = hook("C", (battle) => { seen.push("C"); return { state: battle, value: undefined }; });
    let state = change(f.state, skill => ({ ...skill, spRecovered: [
        hook("A", (battle) => { seen.push("A"); return { state: change(battle, skill => setHook(skill, "spRecovered", added)), value: undefined }; }),
        hook("B", (battle) => { seen.push("B"); return { state: battle, value: undefined }; }),
    ] }));
    state = sp.recover(state, f.ref, "EXTERNAL", 1).state;
    assert.deepEqual(seen, ["A", "B"]);
    state = sp.recover(state, f.ref, "EXTERNAL", 1).state;
    assert.deepEqual(seen, ["A", "B", "A", "B", "C"]);
});

test("nested Skill dispatch independently selects current IDs and retains separate reports", () => {
    const seen = [];
    const f = fixture({ sp: resource, activation: null });
    const added = hook("C", (battle, { event }) => {
        seen.push(["C", event.previous, event.current]);
        return { state: battle, value: undefined };
    });
    const state = change(f.state, skill => ({ ...skill, spRecovered: [
        hook("A", (battle, { host, event }) => {
            const self = getHookHost(battle, host);

            seen.push(["A", event.previous, event.current]);
            if (event.previous !== 0) return { state: battle, value: undefined };
            battle = change(battle, skill => setHook(skill, "spRecovered", added));
            return { state: sp.recover(battle, ref(self), "EXTERNAL", 1).state, value: undefined };
        }),
        hook("B", (battle, { event }) => {
            seen.push(["B", event.previous, event.current]);
            return { state: battle, value: undefined };
        }),
    ] }));
    sp.recover(state, f.ref, "EXTERNAL", 1);
    assert.deepEqual(seen, [
        ["A", 0, 1],
        ["A", 1, 2],
        ["B", 1, 2],
        ["C", 1, 2],
        ["B", 0, 1],
    ]);
});
