import assert from "node:assert/strict";
import { test } from "node:test";
import { actionDefinition, battle, unit } from "../helpers/action-fixture.js";
import { getUnit, transitionUnit } from "../../dist/core/tactical/battle/state.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { setData } from "../../dist/core/tactical/unit/effect/effect.js";
import {
    setBeforeReleaseHook,
    removeBeforeReleaseHook,
} from "../../dist/core/tactical/unit/capability/action/capability.js";
import { beforeRelease } from "../../dist/core/tactical/unit/capability/action/release.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";

const CONTINUE = { type: "CONTINUE" };
const program = {
    id: "release",
    intervalTicks: 10,
    speed: 100,
    start: (state) => ({ state, value: {} }),
    step: (state) => ({ state, value: false }),
};
function initial() {
    const state = battle(unit(0, { action: program }));
    return actions.start(state, unitRef(getUnit(state, 0)), program);
}
function releaseEffect(id, data, invoke) {
    const definition = {
        id,
        initialize: () => data,
        onInstall(state, context) {
            const ref = context.ref;
            return transitionUnit(state, ref.host.id, (current) => ({
                ...current,
                action: setBeforeReleaseHook(current.action, {
                    id: `release/${ref.id}`,
                    enabled: (battle, unit) =>
                        unit.effects.get(ref.id, definition)?.status === "ACTIVE",
                    invoke: (battle, unit, action) =>
                        invoke(battle, { unit, action }, effects.get(battle, ref), ref),
                }),
            }));
        },
        onEnd: (state, context) =>
            transitionUnit(state, context.ref.host.id, (current) => ({
                ...current,
                action: removeBeforeReleaseHook(current.action, `release/${context.ref.id}`),
            })),
    };
    return definition;
}
const attach = (state, definition) =>
    effects.install(state, unitRef(getUnit(state, 0)), definition);
const change = (state, ref, data) =>
    effects.replaceEffect(state, ref, setData(effects.get(state, ref), data));

test("action release: ordinary and disabled effects continue without executing disabled hooks", () => {
    const started = initial();
    assert.deepEqual(beforeRelease(started.state, started.value.ref).value, CONTINUE);
    const installed = attach(
        started.state,
        releaseEffect("disabled", {}, () => assert.fail("disabled hook ran")),
    );
    const disabled = effects.setEnabled(installed.state, installed.value, false);
    assert.deepEqual(beforeRelease(disabled, started.value.ref).value, CONTINUE);
});

test("action release: hiding the source in a continuing hook cancels before release or damage", () => {
    const attack = actionDefinition();
    const initial = battle(
        { ...unit(0, { action: attack }), spatialPresence: { present: true } },
        unit(1),
    );
    const installed = attach(initial, releaseEffect("hide-source", {}, (state, { unit }) => ({
        state: transitionUnit(state, unit.id, (current) => ({
            ...current, spatialPresence: { present: false },
        })),
        value: CONTINUE,
    })));
    const started = actions.start(installed.state, unitRef(getUnit(installed.state, 0)), attack);

    assert.equal(started.value.type, "STARTED");
    assert.equal(getUnit(started.state, 0).spatialPresence.present, false);
    assert.equal(getUnit(started.state, 1).vitality.hp, 100);
    assert.equal(started.state.actions.size, 0);
    assert.equal(started.state.events.some(event => event.type === "ACTION_RELEASED" || event.type === "DAMAGE"), false);
    assert.deepEqual(started.state.events.filter(event => event.type === "ACTION_CANCELLED").map(event => event.reason), ["SOURCE_ABSENT"]);
    assert.equal(getUnit(installed.state, 0).spatialPresence.present, true);
});

test("action release: a hook publishes charge changes and returns its recovery directive", () => {
    const started = initial();
    const definition = releaseEffect("charges", { remaining: 3 }, (state, context, self, ref) => {
        state = change(state, ref, { remaining: self.data.remaining - 1 });
        assert.equal(effects.get(state, ref).data.remaining, self.data.remaining - 1);
        if (self.data.remaining === 1) state = effects.end(state, ref);
        return { state, value: { type: "INTERRUPT", recoveryTicks: 15 } };
    });
    const installed = attach(started.state, definition);
    let state = installed.state;
    for (const tick of [1, 2, 3]) {
        const result = beforeRelease({ ...state, tick }, started.value.ref);
        assert.deepEqual(result.value, { type: "INTERRUPT", recoveryTicks: 15 });
        state = result.state;
    }
    assert.equal(effects.get(state, installed.value), undefined);
    assert.deepEqual(beforeRelease(state, started.value.ref).value, CONTINUE);
    assert.equal(effects.get(installed.state, installed.value).data.remaining, 3);
    assert.equal("recoveryUntilTick" in getUnit(state, 0).action, false);
});

test("action release: the first interruption stops later registered hooks", () => {
    const started = initial(),
        calls = [];
    let state = started.state;
    for (const [id, directive] of [
        ["first", CONTINUE],
        ["second", { type: "INTERRUPT", recoveryTicks: 4 }],
        ["third", CONTINUE],
    ]) {
        state = attach(
            state,
            releaseEffect(id, {}, (state) => {
                calls.push(id);
                return { state, value: directive };
            }),
        ).state;
    }
    assert.deepEqual(beforeRelease(state, started.value.ref).value, {
        type: "INTERRUPT",
        recoveryTicks: 4,
    });
    assert.deepEqual(calls, ["first", "second"]);
});

for (const operation of ["enable", "end"]) {
    test(`action release: ${operation} changes later eligibility while new candidates wait for the next dispatch`, () => {
        const started = initial(),
            calls = [];
        let state = started.state,
            secondRef;
        const third = releaseEffect("third", {}, (state) => {
            calls.push("C");
            return { state, value: CONTINUE };
        });
        const first = releaseEffect("first", { entered: false }, (state, context, self, ref) => {
            calls.push("A");
            if (!self.data.entered) {
                state = change(state, ref, { entered: true });
                state =
                    operation === "enable"
                        ? effects.setEnabled(state, secondRef, true)
                        : effects.end(state, secondRef);
                state = attach(state, third).state;
            }
            return { state, value: CONTINUE };
        });
        state = attach(state, first).state;
        const second = attach(
            state,
            releaseEffect("second", {}, (state) => {
                calls.push("B");
                return { state, value: CONTINUE };
            }),
        );
        state = second.state;
        secondRef = second.value;
        if (operation === "enable") state = effects.setEnabled(state, secondRef, false);
        state = beforeRelease(state, started.value.ref).state;
        assert.deepEqual(calls, operation === "enable" ? ["A", "B"] : ["A"]);
        calls.length = 0;
        beforeRelease({ ...state, tick: 1 }, started.value.ref);
        assert.deepEqual(calls, operation === "enable" ? ["A", "B", "C"] : ["A", "C"]);
    });
}

test("action release: a nested dispatch takes new candidates from its own current battle", () => {
    const started = initial(),
        calls = [];
    const later = releaseEffect("later", {}, (state) => {
        calls.push("B");
        return { state, value: CONTINUE };
    });
    const first = releaseEffect("first", { nested: false }, (state, context, self, ref) => {
        calls.push("A");
        if (!self.data.nested) {
            state = change(state, ref, { nested: true });
            state = attach(state, later).state;
            state = beforeRelease(state, started.value.ref).state;
        }
        return { state, value: CONTINUE };
    });
    beforeRelease(attach(started.state, first).state, started.value.ref);
    assert.deepEqual(calls, ["A", "A", "B"]);
});

test("action release: a thrown hook preserves the caller's private state", () => {
    const started = initial();
    const installed = attach(
        started.state,
        releaseEffect("failure", { attempts: 0 }, (state, context, self, ref) => {
            state = change(state, ref, { attempts: self.data.attempts + 1 });
            throw new Error("release failed");
        }),
    );
    assert.throws(() => beforeRelease(installed.state, started.value.ref), /release failed/);
    assert.equal(effects.get(installed.state, installed.value).data.attempts, 0);
});
