import { ref as actionRef } from "../../dist/core/tactical/unit/action/action.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { battle, unit } from "../helpers/action-fixture.js";
import * as cooldown from "../../dist/core/tactical/unit/action/cooldown.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import {
    resolveInterval,
    resolveSpeed,
    resolveBaseInterval,
} from "../../dist/core/tactical/unit/capability/action/timing.js";
import {
    setSpeedContribution,
    setIntervalContribution,
} from "../../dist/core/tactical/unit/capability/action/capability.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { create as modifier } from "../../dist/core/tactical/unit/contribution/attribute.js";
import { advance } from "../../dist/core/tactical/unit/action/advance.js";

const program = (id = "timed", extra = {}) => ({
    id,
    intervalTicks: 30,
    speed: 100,
    initialize: (state) => ({ state, value: {} }),
    start: (state) => ({ state, value: {} }),
    step: (state) => ({ state, value: false }),
    ...extra,
});
const close = (actual, expected) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
function contribute(state, key, value) {
    const current = getUnit(state, 0);
    const setter = key === "speed" ? setSpeedContribution : setIntervalContribution;
    return updateUnit(state, {
        ...current,
        action: setter(current.action, { id: `timing/${key}`, value: [modifier(value)] }),
    });
}

test("cooldown: initial readiness, resetting and clearing are immutable value operations", () => {
    const initial = cooldown.initialize(30, 5);
    assert.equal(cooldown.remaining(initial, 5), 0);
    const reset = cooldown.reset(initial, 5);
    assert.deepEqual(reset, { periodTicks: 30, readyAtTick: 35 });
    assert.equal(cooldown.remaining(reset, 20), 15);
    const cleared = cooldown.clear(reset, 20);
    assert.equal(cooldown.remaining(cleared, 20), 0);
    assert.equal(reset.readyAtTick, 35);
    assert.equal(initial.readyAtTick, 5);
});

test("cooldown: speed-up and slow-down preserve completed percentage", () => {
    const initial = cooldown.reset(cooldown.initialize(30, 0), 0);
    const faster = cooldown.resizeKeepingProgress(initial, 15, 15);
    close(faster.readyAtTick, 22.5);
    const slower = cooldown.resizeKeepingProgress(faster, 30, 18);
    close(slower.readyAtTick, 27);
    assert.equal(initial.readyAtTick, 30);
});

test("cooldown: retaining elapsed time is distinct from retaining completed percentage", () => {
    const initial = cooldown.reset(cooldown.initialize(30, 0), 0);
    assert.equal(cooldown.resizeKeepingElapsed(initial, 20, 10).readyAtTick, 20);
    close(cooldown.resizeKeepingProgress(initial, 20, 10).readyAtTick, 10 + (20 * 2) / 3);
});

test("action timing: interval contribution algebra and the speed cap have distinct roles", () => {
    const definition = program(),
        initial = battle(unit(0, { action: definition }));
    const source = unitRef(getUnit(initial, 0));
    let state = contribute(initial, "interval", {
        addition: -6,
        multiplier: 0.5,
        finalAddition: 3,
        finalScaler: 0.5,
    });
    state = contribute(state, "speed", { addition: -200 });
    assert.equal(resolveBaseInterval(state, source, definition), 19.5);
    assert.equal(resolveSpeed(state, source, definition), 20);
    assert.equal(resolveInterval(state, source, definition), 97.5);
    state = contribute(state, "speed", { addition: 900 });
    assert.equal(resolveSpeed(state, source, definition), 1000);
    assert.equal(resolveInterval(state, source, definition), 3.25);
    assert.equal(resolveInterval(initial, source, definition), 30);
});

test("action timing: complete cooldown refresh preserves progress at the contribution-change tick", () => {
    const definition = program(),
        initial = battle(unit(0, { action: definition }));
    const source = unitRef(getUnit(initial, 0));
    const started = actions.start(initial, source, definition);
    const changed = actions.refreshCooldowns(
        contribute({ ...started.state, tick: 15 }, "speed", { addition: 100 }),
        source,
    );
    close(getUnit(changed, 0).action.states.get(definition.id).cooldown.readyAtTick, 22.5);
    assert.equal(getUnit(started.state, 0).action.states.get(definition.id).cooldown.readyAtTick, 30);
});

test("action timing: starting uses contributions and cooldowns from the returned battle", () => {
    const sibling = program("sibling");
    const definition = program("changed-on-start", {
        start(state, source) {
            state = contribute(state, "speed", { addition: 100 });
            state = actions.resetCooldown(state, source, sibling.id);
            return { state, value: {} };
        },
    });
    const initial = battle(unit(0, {
        action: { definitions: Definitions.empty().add(definition).add(sibling) },
    }));
    const started = actions.start(initial, unitRef(getUnit(initial, 0)), definition);
    assert.equal(started.value.type, "STARTED");
    const current = getUnit(started.state, 0);
    assert.deepEqual(current.action.states.get(definition.id).cooldown, { periodTicks: 15, readyAtTick: 15 });
    assert.deepEqual(current.action.states.get(sibling.id).cooldown, { periodTicks: 15, readyAtTick: 15 });
    assert.equal(getUnit(initial, 0).action.states.size, 2);
    assert.equal(getUnit(initial, 0).action.states.get(definition.id).cooldown.readyAtTick, 0);
});

test("action timing: startup rejects a cooldown introduced by its callback and retains its settled changes", () => {
    const definition = program("blocked-on-start", {
        initialize: state => ({ state, value: { attempts: 0 } }),
        start(state, source, self) {
            state = actions.replaceState(state, source, {
                ...self,
                data: { attempts: self.data.attempts + 1 },
                cooldown: { ...self.cooldown, readyAtTick: 100 },
            });
            return { state, value: {} };
        },
        step: () => assert.fail("a rejected startup cannot advance"),
    });
    const initial = battle(unit(0, { action: definition }));
    const source = unitRef(getUnit(initial, 0));
    const rejected = actions.start(initial, source, definition);
    assert.deepEqual(rejected.value, { type: "REJECTED", reason: "COOLDOWN" });
    assert.equal(getUnit(rejected.state, 0).action.instances.size, 0);
    assert.equal(getUnit(rejected.state, 0).action.instances.nextId, getUnit(initial, 0).action.instances.nextId);
    assert.equal(actions.getState(rejected.state, source, definition).cooldown.readyAtTick, 100);
    assert.deepEqual(actions.getState(rejected.state, source, definition).data, { attempts: 1 });
    assert.equal(actions.getState(initial, source, definition).cooldown.readyAtTick, 0);
    assert.deepEqual(actions.getState(initial, source, definition).data, { attempts: 0 });
});

test("action timing: a period change does not rescale an accepted private casting budget", () => {
    const definition = program("casting", {
        start: (state) => ({ state, value: { finishAtTick: state.tick + 20, observed: 0 } }),
        step(state, self) {
            if (state.tick >= self.state.finishAtTick) return { state, value: true };
            return {
                state: actions.update(state, actionRef(self), currentState => ({ ...currentState, observed: currentState.observed + 1 })),
                value: false,
            };
        },
    });
    const initial = battle(unit(0, { action: definition })),
        source = unitRef(getUnit(initial, 0));
    const started = actions.start(initial, source, definition);
    const changed = actions.refreshCooldowns(
        contribute({ ...started.state, tick: 10 }, "interval", { finalScaler: 0.5 }),
        source,
    );
    assert.equal(getUnit(changed, 0).action.states.get(definition.id).cooldown.readyAtTick, 20);
    assert.equal(actions.get(changed, started.value.ref).state.finishAtTick, 20);
    assert.equal(
        actions.get(advance({ ...changed, tick: 19 }, started.value.ref), started.value.ref).state
            .finishAtTick,
        20,
    );
    assert.equal(
        actions.get(advance({ ...changed, tick: 20 }, started.value.ref), started.value.ref),
        undefined,
    );
});

test("action timing: each configured definition retains its own cooldown", () => {
    const first = program("short", { intervalTicks: 10 }),
        second = program("long", { intervalTicks: 30 });
    const initial = battle(
        unit(0, { action: { definitions: Definitions.empty().add(first).add(second) } }),
    );
    const source = unitRef(getUnit(initial, 0));
    const a = actions.start(initial, source, first),
        b = actions.start(a.state, source, second);
    assert.equal(getUnit(b.state, 0).action.states.get(first.id).cooldown.readyAtTick, 10);
    assert.equal(getUnit(b.state, 0).action.states.get(second.id).cooldown.readyAtTick, 30);
    const cleared = actions.clearCooldown(b.state, source, first.id);
    assert.equal(getUnit(cleared, 0).action.states.get(first.id).cooldown.readyAtTick, 0);
    assert.equal(getUnit(cleared, 0).action.states.get(second.id).cooldown.readyAtTick, 30);
});

test("action timing: live contributions read the battle version provided by the caller", () => {
    const definition = program(),
        initial = battle(unit(0, { action: definition }));
    const current = getUnit(initial, 0),
        source = unitRef(current);
    const installed = updateUnit(initial, {
        ...current,
        action: setSpeedContribution(current.action, {
            id: "live",
            value: ({ unit }) => [modifier({ addition: unit.vitality.hp })],
        }),
    });
    const next = updateUnit(installed, {
        ...getUnit(installed, 0),
        vitality: { ...current.vitality, hp: 50 },
    });
    assert.equal(resolveInterval(installed, source, definition), 15);
    assert.equal(resolveInterval(next, source, definition), 20);
    assert.equal(resolveInterval(initial, source, definition), 30);
});
