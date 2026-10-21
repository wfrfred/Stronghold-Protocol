import assert from "node:assert/strict";
import { test } from "node:test";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { registerUnit, getUnit } from "../../dist/core/tactical/battle/state.js";
import { fixtureBattle } from "../helpers/unit.js";

const program = (id, configuration = {}) => ({
    id, intervalTicks: 10, speed: 100,
    initialize: state => ({ state, value: { count: 0 } }),
    start: (state, source, self) => ({ state, value: { sampledCount: self.data.count } }),
    step: state => ({ state, value: false }),
    ...configuration,
});

function create(battle, definitions, id = 0) {
    const initialized = initialize(battle, {
        id, position: [id, 0], definition: { id: "persistent", action: { definitions } },
    });
    return {
        state: registerUnit(initialized.state, initialized.value),
        source: unitRef(initialized.value),
        unit: initialized.value,
    };
}

test("Action initializes every configured persistent state before any start and threads battle results", () => {
    const calls = [];
    const make = id => program(id, {
        initialize(state) {
            calls.push([id, state.execution.rngState]);
            return {
                state: { ...state, execution: { ...state.execution, rngState: state.execution.rngState + 1 } },
                value: { count: state.execution.rngState },
            };
        },
    });
    const first = make("first"), second = make("second");
    const definitions = Definitions.empty().add(first).add(second);
    const initial = fixtureBattle(37, { rngState: 12 });
    const a = create(initial, definitions);
    const b = create(a.state, definitions, 1);

    assert.deepEqual(calls, [["first", 12], ["second", 13], ["first", 14], ["second", 15]]);
    assert.equal(b.state.execution.rngState, 16);
    assert.equal(initial.execution.rngState, 12);
    assert.equal(getUnit(b.state, 0).action.instances.size, 0);
    for (const [definition, count] of [[first, 12], [second, 13]]) {
        const stored = actions.getState(b.state, a.source, definition);
        assert.equal(stored.definition, definition);
        assert.deepEqual(stored.data, { count });
        assert.deepEqual(stored.cooldown, { periodTicks: 10, readyAtTick: 37 });
        assert.notEqual(stored, actions.getState(b.state, b.source, definition));
        assert.notEqual(stored.data, actions.getState(b.state, b.source, definition).data);
    }
});

test("Action completion and cancellation discard execution state while preserving persistent history", () => {
    let initialized = 0;
    const definition = program("history", {
        initialize(state) {
            initialized++;
            return { state, value: { count: 0 } };
        },
        step(state, self) {
            const current = actions.getState(state, self.host, self.definition);
            state = actions.replaceState(state, self.host, {
                ...current, data: { count: current.data.count + 1 },
            });
            return { state, value: current.data.count === 0 };
        },
    });
    const fixture = create(fixtureBattle(), Definitions.empty().add(definition));
    const first = actions.start(fixture.state, fixture.source, definition);
    assert.equal(first.value.type, "STARTED");
    assert.equal(actions.get(first.state, first.value.ref), undefined);
    assert.deepEqual(actions.getState(first.state, fixture.source, definition).data, { count: 1 });

    const second = actions.start({ ...first.state, tick: 10 }, fixture.source, definition);
    assert.equal(second.value.type, "STARTED");
    assert.equal(actions.get(second.state, second.value.ref).state.sampledCount, 1);
    const cancelled = actions.cancel(second.state, second.value.ref);
    assert.equal(actions.get(cancelled, second.value.ref), undefined);
    assert.deepEqual(actions.getState(cancelled, fixture.source, definition).data, { count: 2 });
    assert.deepEqual(actions.getState(fixture.state, fixture.source, definition).data, { count: 0 });
    assert.deepEqual(actions.start(cancelled, fixture.source, definition).value, {
        type: "REJECTED", reason: "COOLDOWN",
    });
    assert.equal(initialized, 1);
});

test("Action startup commits its cooldown using the latest persistent state after callbacks", () => {
    const sibling = program("sibling");
    const definition = program("nested", {
        start(state, source, self) {
            state = actions.replaceState(state, source, { ...self, data: { count: 7 } });
            const other = actions.getState(state, source, sibling);
            state = actions.replaceState(state, source, { ...other, data: { count: 9 } });
            state = actions.resetCooldown(state, source, sibling.id);
            return { state, value: { sampledCount: self.data.count } };
        },
    });
    const fixture = create(fixtureBattle(), Definitions.empty().add(definition).add(sibling));
    const started = actions.start(fixture.state, fixture.source, definition);
    assert.equal(started.value.type, "STARTED");
    assert.deepEqual(actions.getState(started.state, fixture.source, definition).data, { count: 7 });
    assert.deepEqual(actions.getState(started.state, fixture.source, sibling).data, { count: 9 });
    assert.equal(actions.getState(started.state, fixture.source, definition).cooldown.readyAtTick, 10);
    assert.equal(actions.getState(started.state, fixture.source, sibling).cooldown.readyAtTick, 10);
    assert.equal(actions.get(started.state, started.value.ref).state.sampledCount, 0);
    assert.equal(getUnit(fixture.state, fixture.source.id).action.states.get(definition.id).data.count, 0);
});
