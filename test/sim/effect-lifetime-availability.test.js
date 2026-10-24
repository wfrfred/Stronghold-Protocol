import assert from "node:assert/strict";
import { test } from "node:test";
import { battle, unit } from "../helpers/action-fixture.js";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { ref as actionRef } from "../../dist/core/tactical/unit/action/action.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import * as elemental from "../../dist/core/tactical/unit/capability/elemental/operations.js";
import { ELEMENT_TYPES, createDefinition } from "../../dist/core/tactical/unit/capability/elemental/capability.js";
import { ref as burstRef } from "../../dist/core/tactical/unit/capability/elemental/burst.js";

function verifyAdmission(state, lifetime, retained) {
    const host = unitRef(getUnit(state, 1));
    const independent = effects.install(state, host, { id: "independent", initialize: () => ({}) });
    assert.notEqual(independent.value, undefined);
    const receiver = getUnit(independent.state, 1);
    const rejected = effects.install(independent.state, host, {
        id: "late-dependent",
        initialize: () => assert.fail("an unavailable lifetime cannot initialize new content"),
    }, { scopes: [lifetime] });
    assert.equal(rejected.value, undefined);
    assert.equal(rejected.state, independent.state);
    assert.equal(getUnit(rejected.state, 1).effects.nextId, receiver.effects.nextId);
    const bound = effects.bindLifetime(rejected.state, independent.value, lifetime);
    assert.equal(bound.value, false);
    assert.equal(bound.state, rejected.state);
    assert.deepEqual(effects.get(bound.state, independent.value).scopes, []);
    retained.push(independent.value);
    return bound.state;
}

test("Action ENDING content rejects new lifetime dependencies while independent business remains available", () => {
    const retained = [];
    const definition = {
        id: "ending-action", intervalTicks: 10, speed: 100,
        initialize: state => ({ state, value: {} }),
        start: state => ({ state, value: {} }),
        step: state => ({ state, value: false }),
        onEnd(state, self) {
            assert.equal(actions.get(state, actionRef(self)).status, "ENDING");
            return verifyAdmission(state, { type: "ACTION", ref: actionRef(self) }, retained);
        },
    };
    const initial = battle(unit(0, { action: definition }), unit(1));
    const started = actions.start(initial, unitRef(getUnit(initial, 0)), definition);
    assert.equal(started.value.type, "STARTED");
    const ended = actions.cancel(started.state, started.value.ref, "EXPLICIT");
    assert.equal(retained.length, 1);
    assert.equal(actions.get(ended, started.value.ref), undefined);
    assert.equal(effects.get(ended, retained[0]).status, "ACTIVE");
    assert.equal(getUnit(ended, 0).lifecycle, "PRESENT");
});

test("Burst ENDING content rejects new lifetime dependencies while independent business remains available", () => {
    const retained = [];
    const definition = createDefinition({
        maxEp: 1000,
        bursts: Object.fromEntries(ELEMENT_TYPES.map(type => [type, {
            durationTicks: 300,
            onStart: state => state,
            onEnd(state, self) {
                assert.equal(getUnit(state, self.host.id).elemental.burst.status, "ENDING");
                return verifyAdmission(state, { type: "ELEMENTAL_BURST", ref: burstRef(self) }, retained);
            },
        }])),
    });
    const initial = battle(unit(0, { elemental: definition }), unit(1));
    const started = elemental.damage(initial, unitRef(getUnit(initial, 0)), { type: "BURN", power: 1000, source: null });
    assert.notEqual(started.value.burst, null);
    const ended = elemental.cancel(started.state, started.value.burst, "EXPLICIT");
    assert.equal(retained.length, 1);
    assert.equal(getUnit(ended, 0).elemental.burst, null);
    assert.equal(effects.get(ended, retained[0]).status, "ACTIVE");
    assert.equal(getUnit(ended, 0).lifecycle, "PRESENT");
});
