import { setRule } from "../../dist/core/tactical/unit/capability/action/capability.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { battle, unit } from "../helpers/action-fixture.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { setState } from "../../dist/core/tactical/unit/action/action.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { advance } from "../../dist/core/tactical/unit/action/advance.js";

const program = (id, extra = {}) => ({
    id,
    intervalTicks: 10,
    speed: 100,
    start: (state) => ({ state, value: { count: 0 } }),
    step: (state) => ({ state, value: false }),
    ...extra,
});

test("action storage: heterogeneous definitions retain their private state and callback pairing", () => {
    const first = program("number", { start: (state) => ({ state, value: { count: 3 } }) });
    const second = program("text", { start: (state) => ({ state, value: { message: "ready" } }) });
    const initial = battle(
        unit(0, { action: { definitions: Definitions.empty().add(first).add(second) } }),
    );
    const source = unitRef(getUnit(initial, 0));
    const a = actions.start(initial, source, first),
        b = actions.start(a.state, source, second);
    assert.equal(actions.get(b.state, a.value.ref).definition, first);
    assert.deepEqual(actions.get(b.state, a.value.ref).state, { count: 3 });
    assert.equal(actions.get(b.state, b.value.ref).definition, second);
    assert.deepEqual(actions.get(b.state, b.value.ref).state, { message: "ready" });
    assert.equal(actions.forUnit(b.state, source).length, 2);
    assert.equal(actions.all(initial).length, 0);
});

test("action storage: same-definition reentry is rejected while another definition may start", () => {
    const first = program("first"),
        second = program("second");
    const initial = battle(
        unit(0, { action: { definitions: Definitions.empty().add(first).add(second) } }),
    );
    const source = unitRef(getUnit(initial, 0));
    const a = actions.start(initial, source, first);
    const retry = actions.start({ ...a.state, tick: 20 }, source, first);
    assert.deepEqual(retry.value, { type: "REJECTED", reason: "CASTING" });
    assert.equal(actions.start(retry.state, source, second).value.type, "STARTED");
});

test("action storage: replacements preserve earlier instances and never recreate an ended identity", () => {
    const definition = program("branch");
    const initial = battle(unit(0, { action: definition })),
        source = unitRef(getUnit(initial, 0));
    const started = actions.start(initial, source, definition),
        self = actions.get(started.state, started.value.ref);
    const changed = actions.replace(started.state, setState(self, { count: 1 }));
    assert.equal(actions.get(changed, started.value.ref).state.count, 1);
    assert.equal(actions.get(started.state, started.value.ref).state.count, 0);
    const cancelled = actions.cancel(changed, started.value.ref, "SCRIPT");
    assert.equal(actions.replace(cancelled, self), cancelled);
    const restarted = actions.start({ ...cancelled, tick: 10 }, source, definition);
    assert.equal(restarted.value.type, "STARTED");
    assert.notEqual(restarted.value.ref.id, started.value.ref.id);
    assert.equal(actions.get(restarted.state, started.value.ref), undefined);
});

test("action storage: replacing state cannot change its fixed definition association", () => {
    const definition = program("fixed"),
        other = program("fixed");
    const initial = battle(unit(0, { action: definition }));
    const started = actions.start(initial, unitRef(getUnit(initial, 0)), definition);
    const self = actions.get(started.state, started.value.ref);
    assert.throws(() => actions.replace(started.state, { ...self, definition: other }), TypeError);
    assert.equal(actions.get(started.state, started.value.ref), self);
});

test("action storage: a throwing later instance cannot mutate earlier published progress", () => {
    const advanceCount = (state, self) => ({
        state: actions.replace(state, setState(self, { count: self.state.count + 1 })),
        value: false,
    });
    const first = program("first", { step: advanceCount });
    const second = program("second", {
        step(state, self) {
            if (state.tick > 0) throw new Error("later failure");
            return advanceCount(state, self);
        },
    });
    const initial = battle(
        unit(0, { action: { definitions: Definitions.empty().add(first).add(second) } }),
    );
    const source = unitRef(getUnit(initial, 0)),
        a = actions.start(initial, source, first),
        b = actions.start(a.state, source, second);
    const before = b.state;
    assert.throws(() => {
        const next = advance({ ...before, tick: 1 }, a.value.ref);
        advance(next, b.value.ref);
    }, /later failure/);
    assert.equal(actions.get(before, a.value.ref).state.count, 1);
    assert.equal(actions.get(before, b.value.ref).state.count, 1);
});

test("action: startup rules prohibit new instances while an accepted program keeps its own continuation", () => {
    const first = program("running", {
        step(state, self) {
            return {
                state: actions.replace(state, setState(self, { count: self.state.count + 1 })),
                value: state.tick >= 1,
            };
        },
    });
    const second = program("blocked");
    const initial = battle(
        unit(0, { action: { definitions: Definitions.empty().add(first).add(second) } }),
    );
    const source = unitRef(getUnit(initial, 0)),
        started = actions.start(initial, source, first);
    const current = getUnit(started.state, 0);
    const prohibited = updateUnit(
        { ...started.state, tick: 1 },
        {
            ...current,
            action: setRule(current.action, { id: "prohibit-start", allows: () => false }),
        },
    );
    assert.deepEqual(actions.start(prohibited, source, second).value, {
        type: "REJECTED",
        reason: "RULE",
    });
    const finished = advance(prohibited, started.value.ref);
    assert.equal(actions.get(finished, started.value.ref), undefined);
    assert.equal(
        finished.events.some((event) => event.type === "ACTION_FINISHED"),
        true,
    );
    assert.equal(
        finished.events.some((event) => event.type === "ACTION_CANCELLED"),
        false,
    );
});

test("action: cancellation preserves the accepted cooldown instead of resetting or clearing it", () => {
    const definition = program("cooldown"),
        initial = battle(unit(0, { action: definition }));
    const source = unitRef(getUnit(initial, 0)),
        started = actions.start(initial, source, definition);
    const cancelled = actions.cancel({ ...started.state, tick: 1 }, started.value.ref, "SCRIPT");
    assert.equal(getUnit(cancelled, 0).action.cooldowns.get(definition.id).readyAtTick, 10);
    assert.deepEqual(actions.start(cancelled, source, definition).value, {
        type: "REJECTED",
        reason: "COOLDOWN",
    });
    assert.equal(
        actions.start({ ...cancelled, tick: 10 }, source, definition).value.type,
        "STARTED",
    );
});
