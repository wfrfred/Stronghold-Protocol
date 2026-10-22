import assert from "node:assert/strict";
import { test } from "node:test";
import { battle, unit } from "../helpers/action-fixture.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { ref as actionRef } from "../../dist/core/tactical/unit/action/action.js";
import { advance } from "../../dist/core/tactical/unit/action/advance.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import { getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { leave } from "../../dist/core/tactical/battle/execution/unit.js";

import * as effects from "../../dist/core/tactical/unit/effect/operations.js";

const program = (id = "program", overrides = {}) => ({
    id,
    intervalTicks: 10,
    speed: 100,
    initialize: (state) => ({ state, value: {} }),
    start: (state) => ({ state, value: { progress: 0 } }),
    step: (state) => ({ state, value: false }),
    ...overrides,
});
function accepted(definition, state = battle(unit(0, { action: definition }), unit(1))) {
    const result = actions.start(state, unitRef(getUnit(state, 0)), definition);
    assert.equal(result.value.type, "STARTED");
    return result;
}
const ownedEffect = { id: "action-owned", initialize: () => ({}) };

function installOwned(state, self, definition = ownedEffect) {
    return effects.install(state, unitRef(getUnit(state, 1)), definition, {
        scopes: [{ type: "ACTION", ref: actionRef(self) }],
    }).state;
}

test("action: private progress and sampled values survive immutable branches without replay", () => {
    const definition = program("sample", {
        start: (state) => ({
            state,
            value: {
                released: false,
                power: getUnit(state, 1).vitality.hp,
                releaseAtTick: state.tick + 2,
            },
        }),
        step(state, self) {
            if (state.tick < self.state.releaseAtTick) return { state, value: false };
            state = actions.update(state, actionRef(self), currentState => ({ ...currentState, released: true }));
            state = updateUnit(state, {
                ...getUnit(state, 1),
                vitality: { ...getUnit(state, 1).vitality, hp: self.state.power - 7 },
            });
            return { state, value: true };
        },
    });
    const initial = battle(unit(0, { action: definition }), unit(1));
    const started = accepted(definition, initial);
    const retained = actions.get(started.state, started.value.ref);
    const completed = advance({ ...started.state, tick: 2 }, started.value.ref);
    assert.equal(getUnit(completed, 1).vitality.hp, 93);
    assert.equal(actions.get(completed, started.value.ref), undefined);
    assert.equal(retained.state.released, false);
    assert.equal(getUnit(initial, 1).vitality.hp, 100);
    assert.deepEqual(advance({ ...started.state, tick: 2 }, started.value.ref), completed);
});

test("action: cancellation closes its dependencies once and retains preceding business", () => {
    let ended = 0;
    const dependency = {
        ...ownedEffect,
        onEnd: (state) => {
            ended++;
            return state;
        },
    };
    const definition = program("owned", {
        step(state, self) {
            state = installOwned(state, self, dependency);
            state = updateUnit(state, { ...getUnit(state, 1), position: [3, 0] });
            return { state, value: false };
        },
    });
    const started = accepted(definition);
    const cancelled = actions.cancel({ ...started.state, tick: 1 }, started.value.ref, "SCRIPT");
    assert.equal(ended, 1);
    assert.deepEqual(getUnit(cancelled, 1).position, [3, 0]);
    assert.deepEqual(getUnit(cancelled, 1).effects.values().toArray(), []);
    assert.equal(getUnit(started.state, 1).effects.values().toArray().length, 1);
    assert.equal(actions.cancel(cancelled, started.value.ref, "AGAIN"), cancelled);
    assert.equal(ended, 1);
});

test("action: different definitions share a source while their state and effects remain independent", () => {
    const create = (id) =>
        program(id, {
            step(state, self) {
                if (self.state.progress === 0) state = installOwned(state, self);
                state = actions.update(state, actionRef(self), currentState => ({ progress: currentState.progress + 1 }));
                return { state, value: false };
            },
        });
    const first = create("first"),
        second = create("second");
    const initial = battle(
        unit(0, { action: { definitions: Definitions.empty().add(first).add(second) } }),
        unit(1),
    );
    const a = accepted(first, initial),
        b = accepted(second, a.state);
    const cancelled = actions.cancel(b.state, a.value.ref, "SCRIPT");
    assert.equal(actions.get(cancelled, a.value.ref), undefined);
    assert.equal(actions.get(cancelled, b.value.ref).state.progress, 1);
    assert.equal(getUnit(cancelled, 1).effects.values().toArray().length, 1);
    assert.equal(getUnit(b.state, 1).effects.values().toArray().length, 2);
});

test("action: equal local identities on different hosts keep progress and lifetime dependencies independent", () => {
    const definition = program("shared", {
        step(state, self) {
            if (self.state.progress === 0) {
                state = effects.install(state, unitRef(getUnit(state, 2)), ownedEffect, {
                    scopes: [{ type: "ACTION", ref: actionRef(self) }],
                }).state;
            }
            return {
                state: actions.update(state, actionRef(self), currentState => ({ progress: currentState.progress + 1 })),
                value: false,
            };
        },
    });
    const initial = battle(
        unit(0, { action: definition }),
        unit(1, { side: "ALLY", action: definition }),
        unit(2),
    );
    const first = actions.start(initial, unitRef(getUnit(initial, 0)), definition);
    const second = actions.start(first.state, unitRef(getUnit(first.state, 1)), definition);
    assert.deepEqual(first.value.ref, { host: { id: 0 }, id: 0 });
    assert.deepEqual(second.value.ref, { host: { id: 1 }, id: 0 });
    assert.deepEqual(actions.all(second.state), [first.value.ref, second.value.ref]);
    assert.deepEqual(actions.forUnit(second.state, second.value.ref.host), [second.value.ref]);
    const progressed = advance({ ...second.state, tick: 1 }, second.value.ref);
    assert.equal(actions.get(progressed, first.value.ref).state.progress, 1);
    assert.equal(actions.get(progressed, second.value.ref).state.progress, 2);

    const cancelled = actions.cancel(progressed, first.value.ref, "SCRIPT");
    assert.equal(actions.get(cancelled, first.value.ref), undefined);
    assert.equal(actions.get(cancelled, second.value.ref).state.progress, 2);
    assert.deepEqual(getUnit(cancelled, 2).effects.values().toArray().map(effect => effect.id), [1]);
    assert.equal(getUnit(second.state, 2).effects.values().toArray().length, 2);
    assert.equal(getUnit(initial, 0).action.instances.nextId, 0);
    assert.equal(getUnit(cancelled, 0).action.instances.nextId, 1);
    assert.equal(getUnit(cancelled, 1).action.instances.nextId, 1);

    const ended = actions.cancel(cancelled, second.value.ref, "SCRIPT");
    assert.deepEqual(getUnit(ended, 2).effects.values().toArray(), []);
    assert.deepEqual(ended.events.filter(event => event.type === "ACTION_CANCELLED")
        .map(event => [event.sourceUnitId, event.executionId]), [[0, 0], [1, 0]]);
});

test("action: dependency cleanup may remove its ending host before one terminal callback without resurrection", () => {
    const trace = [];
    const definition = program("ending-host", {
        step(state, self) {
            if (self.state.progress > 0) return { state, value: true };
            state = installOwned(state, self, {
                ...ownedEffect,
                onEnd(state) {
                    trace.push("dependency");
                    return leave(state, self.host.id, "SCRIPT");
                },
            });
            return { state: actions.update(state, actionRef(self), () => ({ progress: 1 })), value: false };
        },
        onEnd(state, self, outcome) {
            trace.push(outcome.type);
            assert.equal(getUnit(state, self.host.id), undefined);
            assert.equal(actions.get(state, actionRef(self)), undefined);
            return actions.update(state, actionRef(self), () => ({ progress: 9 }));
        },
    });
    const started = accepted(definition);
    const completed = advance({ ...started.state, tick: 1 }, started.value.ref);
    assert.deepEqual(trace, ["dependency", "FINISHED"]);
    assert.equal(getUnit(completed, 0), undefined);
    assert.deepEqual(getUnit(completed, 1).effects.values().toArray(), []);
    assert.equal(actions.get(completed, started.value.ref), undefined);
    assert.equal(completed.events.filter(event => event.type === "ACTION_FINISHED").length, 1);
    assert.equal(completed.events.some(event => event.type === "ACTION_CANCELLED"), false);
    assert.equal(getUnit(started.state, 0).action.instances.size, 1);
});

test("action: private progress is visible to nested callbacks before their business executes", () => {
    let observed;
    const dependency = {
        ...ownedEffect,
        onInstall(state, context) {
            observed = actions.get(state, currentRef).state.progress;
            return state;
        },
    };
    let currentRef;
    const definition = program("visible", {
        step(state, self) {
            currentRef = actionRef(self);
            state = actions.update(state, actionRef(self), () => ({ progress: 1 }));
            return { state: installOwned(state, self, dependency), value: true };
        },
    });
    accepted(definition);
    assert.equal(observed, 1);
});

test("action: normal finish and cancellation close dependencies before one terminal callback", () => {
    for (const finish of [false, true]) {
        const trace = [];
        const dependency = {
            ...ownedEffect,
            onEnd: (state) => {
                trace.push("effect");
                return state;
            },
        };
        const definition = program(`terminal-${finish}`, {
            step: (state, self) => ({
                state: installOwned(state, self, dependency),
                value: finish,
            }),
            onEnd(state, self, end) {
                trace.push(end.type);
                return state;
            },
        });
        const started = accepted(definition);
        const state = finish
            ? started.state
            : actions.cancel(started.state, started.value.ref, "SCRIPT");
        assert.deepEqual(trace, ["effect", finish ? "FINISHED" : "CANCELLED"]);
        assert.equal(actions.get(state, started.value.ref), undefined);
        assert.equal(
            state.events.filter(
                (event) => event.type === (finish ? "ACTION_FINISHED" : "ACTION_CANCELLED"),
            ).length,
            1,
        );
    }
});

test("action: ENDING occupies the definition and repeated cancellation cannot reenter onEnd", () => {
    let count = 0;
    const definition = program("ending", {
        onEnd(state, self) {
            count++;
            assert.equal(actions.get(state, actionRef(self)).status, "ENDING");
            state = actions.cancel(state, actionRef(self), "REENTER");
            const attempted = actions.start(state, self.host, definition);
            assert.deepEqual(attempted.value, { type: "REJECTED", reason: "CASTING" });
            return attempted.state;
        },
    });
    const started = accepted(definition);
    const state = actions.cancel(started.state, started.value.ref, "SCRIPT");
    assert.equal(count, 1);
    assert.equal(actions.get(state, started.value.ref), undefined);
});

test("action: source departure completes nested cleanup while entered content continues", () => {
    const trace = [];
    const definition = program("depart", {
        step(state, self) {
            state = installOwned(state, self, {
                ...ownedEffect,
                onEnd: (state) => {
                    trace.push("dependency");
                    return state;
                },
            });
            state = leave(state, self.host.id, "SCRIPT");
            assert.equal(actions.get(state, actionRef(self)), undefined);
            trace.push("returned");
            state = updateUnit(state, { ...getUnit(state, 1), position: [4, 0] });
            state = actions.update(state, actionRef(self), () => ({ progress: 9 }));
            return { state, value: true };
        },
        onEnd: (state) => {
            trace.push("end");
            return state;
        },
    });
    const started = accepted(definition);
    assert.deepEqual(trace, ["dependency", "end", "returned"]);
    assert.equal(actions.get(started.state, started.value.ref), undefined);
    assert.equal(getUnit(started.state, 0), undefined);
    assert.deepEqual(getUnit(started.state, 1).position, [4, 0]);
    assert.equal(
        started.state.events.filter((event) => event.type === "ACTION_CANCELLED").length,
        1,
    );
    assert.equal(
        started.state.events.some((event) => event.type === "ACTION_FINISHED"),
        false,
    );
});

test("action: a throwing program leaves its input progress, instances and target untouched", () => {
    const failure = new Error("program failed");
    const definition = program("failure", {
        step(state, self) {
            if (state.tick === 0) return { state, value: false };
            state = actions.update(state, actionRef(self), () => ({ progress: 7 }));
            state = updateUnit(state, { ...getUnit(state, 1), position: [4, 0] });
            throw failure;
        },
    });
    const started = accepted(definition),
        before = started.state;
    assert.throws(
        () => advance({ ...before, tick: 1 }, started.value.ref),
        (error) => error === failure,
    );
    assert.equal(actions.get(before, started.value.ref).state.progress, 0);
    assert.deepEqual(getUnit(before, 1).position, [1, 0]);
});
