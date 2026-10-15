import assert from "node:assert/strict";
import { test } from "node:test";
import { setHook, removeHook } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import * as sp from "../../dist/core/tactical/unit/capability/skill/sp.js";
import { ref } from "../../dist/core/tactical/unit/query.js";
import { fixture, change } from "../helpers/skill.js";

const resource = { initial: 0, capacity: 10, requirement: 1, recovery: { type: "NONE" } };
const hook = (id, invoke, enabled = () => true) => ({ id, enabled, invoke });

for (const enabled of [true, false]) {
    test(`Skill dispatch uses a replacement's current enabled=${enabled} and program`, () => {
        const seen = [];
        const f = fixture({ sp: resource, activation: null });
        const replacement = hook("B", battle => { seen.push("new B"); return battle; }, (battle, self, event) => {
            seen.push(["new enabled", self.skill.data.ready, self.skill.sp.value, event.current]);
            return enabled;
        });
        const state = change(f.state, skill => ({ ...skill, spRecovered: [
            hook("A", battle => {
                seen.push("A");
                return change(battle, skill => setHook({ ...skill, data: { ready: true } }, "spRecovered", replacement));
            }),
            hook("B", battle => { seen.push("old B"); return battle; }, () => {
                seen.push("old enabled");
                return !enabled;
            }),
        ] }));
        sp.recover(state, f.ref, "EXTERNAL", 1);
        assert.deepEqual(seen, ["A", ["new enabled", true, 1, 1], ...(enabled ? ["new B"] : [])]);
    });
}

test("Skill dispatch skips a removed candidate and continues with surviving IDs", () => {
    const seen = [];
    const f = fixture({ sp: resource, activation: null });
    const state = change(f.state, skill => ({ ...skill, spRecovered: [
        hook("A", battle => { seen.push("A"); return change(battle, skill => removeHook(skill, "spRecovered", "B")); }),
        hook("B", battle => { seen.push("B"); return battle; }),
        hook("C", battle => { seen.push("C"); return battle; }),
    ] }));
    sp.recover(state, f.ref, "EXTERNAL", 1);
    assert.deepEqual(seen, ["A", "C"]);
});

test("Skill dispatch defers a newly registered ID until a later dispatch", () => {
    const seen = [];
    const f = fixture({ sp: resource, activation: null });
    const added = hook("C", battle => { seen.push("C"); return battle; });
    let state = change(f.state, skill => ({ ...skill, spRecovered: [
        hook("A", battle => { seen.push("A"); return change(battle, skill => setHook(skill, "spRecovered", added)); }),
        hook("B", battle => { seen.push("B"); return battle; }),
    ] }));
    state = sp.recover(state, f.ref, "EXTERNAL", 1).state;
    assert.deepEqual(seen, ["A", "B"]);
    state = sp.recover(state, f.ref, "EXTERNAL", 1).state;
    assert.deepEqual(seen, ["A", "B", "A", "B", "C"]);
});

test("nested Skill dispatch independently selects current IDs and retains separate reports", () => {
    const seen = [];
    const f = fixture({ sp: resource, activation: null });
    const added = hook("C", (battle, _self, event) => {
        seen.push(["C", event.previous, event.current]);
        return battle;
    });
    const state = change(f.state, skill => ({ ...skill, spRecovered: [
        hook("A", (battle, self, event) => {
            seen.push(["A", event.previous, event.current]);
            if (event.previous !== 0) return battle;
            battle = change(battle, skill => setHook(skill, "spRecovered", added));
            return sp.recover(battle, ref(self), "EXTERNAL", 1).state;
        }),
        hook("B", (battle, _self, event) => {
            seen.push(["B", event.previous, event.current]);
            return battle;
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
