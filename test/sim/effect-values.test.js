import assert from "node:assert/strict";
import { test } from "node:test";
import { setData, setDeadline, deadline } from "../../dist/core/tactical/unit/effect/effect.js";
import {
    get,
    replaceEffect,
    validateScopes,
} from "../../dist/core/tactical/unit/effect/operations.js";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import { definition, effectFixtureWork, install } from "../helpers/effects.js";

const host = () => initialize({ id: 0, position: [0, 0], definition: { id: "values" } });

test("effect values: local no-ops and replacements retain the input version", () => {
    const value = definition("identity", { charges: 2 });
    const installed = install(effectFixtureWork(host()), value);
    const { state, value: ref } = installed;
    const self = get(state, ref);
    assert.equal(getUnit(state, ref.host.id).effects.get(ref.id, definition("identity")), undefined);
    assert.equal(setData(self, self.data), self);
    assert.equal(setDeadline(self, null), self);
    assert.equal(replaceEffect(state, ref, self), state);
    const unit = getUnit(state, 0);
    const changed = replaceEffect(state, ref, setData(self, { charges: 1 }));
    assert.equal(get(state, ref).data.charges, 2);
    assert.equal(get(changed, ref).data.charges, 1);
    assert.equal(getUnit(state, 0), unit);
    assert.throws(() => replaceEffect(state, { ...ref, id: 9 }, self), TypeError);
    assert.equal(replaceEffect(state, { ...ref, id: 9 }, { ...self, id: 9 }), state);
});

test("effect values: deadline updates preserve lifetime constraints and reject invalid time", () => {
    const lifetime = { type: "UNIT", unitId: 0 };
    const { state, value: ref } = install(effectFixtureWork(host()), definition("deadline"), 0, {
        scopes: [lifetime, { type: "TICK", tick: 3 }],
    });
    const self = get(state, ref);
    assert.equal(setDeadline(self, 3), self);
    const renewed = setDeadline(self, 8);
    assert.equal(deadline(renewed), 8);
    assert.equal(renewed.scopes[0], lifetime);
    assert.deepEqual(setDeadline(renewed, null).scopes, [lifetime]);
    assert.equal(deadline(self), 3);
    for (const tick of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => setDeadline(self, tick), RangeError);
    }
});

test("effect deadlines: invalid initial time is rejected before initialization or callbacks", () => {
    const state = effectFixtureWork(host());
    const trace = [];
    const value = {
        id: "invalid-deadline",
        initialize: () => {
            trace.push("initialize");
            return {};
        },
        onInstall: (state) => {
            trace.push("install");
            return state;
        },
    };
    for (const tick of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(
            () => install(state, value, 0, { scopes: [{ type: "TICK", tick }] }),
            RangeError,
        );
    }
    assert.deepEqual(trace, []);
    assert.equal(getUnit(state, 0).effects.values().length, 0);
    const installed = install(state, definition("initial"));
    const self = get(installed.state, installed.value);
    const invalid = replaceEffect(installed.state, installed.value, {
        ...self,
        scopes: [{ type: "TICK", tick: -1 }],
    });
    assert.throws(() => validateScopes(invalid), RangeError);
});
