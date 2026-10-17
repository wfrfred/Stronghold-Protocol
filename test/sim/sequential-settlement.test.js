import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit } from "../helpers/action-fixture.js";
import { getUnit, advanceBattlefield } from "../../dist/core/tactical/battle/state.js";
import { leave } from "../../dist/core/tactical/battle/execution/unit.js";

import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { advance as advanceAction } from "../../dist/core/tactical/unit/action/advance.js";
import { install } from "../../dist/core/tactical/unit/effect/operations.js";
import { advancePredefined } from "../../dist/core/tactical/battle/steps/predefined.js";
import { instantiateUnitPlacement } from "../../dist/core/tactical/battle/creation/placement.js";

for (const nested of ["cancel", "advance", "advance complete", "advance waiting"]) {
    test(`sequential departure: a nested ${nested} cannot produce a second action outcome`, () => {

        let executions = 0;
        let armed = false;
        const first = {
            id: "first", intervalTicks: 10, speed: 100,
            initialize: state => ({ state, value: {} }),
            start: state => ({ state, value: {} }),
            step: state => ({ state, value: false }),
        };
        const second = {
            id: "second", intervalTicks: 10, speed: 100,
            initialize: state => ({ state, value: {} }),
            start: state => ({ state, value: { finishAtTick: 100 } }),
            step(state, self) {
                if (armed) executions++;
                return { state, value: armed && (nested === "advance complete" ||
                    nested === "advance waiting" && state.tick >= self.state.finishAtTick) };
            },
        };
        let state = battle(unit(0, { action: { definitions: Definitions.empty().add(first).add(second) } }), unit(1));
        const acceptedFirst = actions.start(state, unitRef(getUnit(state, 0)), first);
        const firstRef = acceptedFirst.value.ref;
        const acceptedSecond = actions.start(acceptedFirst.state, unitRef(getUnit(state, 0)), second);
        const secondRef = acceptedSecond.value.ref;
        state = acceptedSecond.state;
        armed = true;
        state = install(
            state,
            unitRef(getUnit(state, 1)),
            {
                id: "nested-action-end",
                initialize: () => ({}),
                onEnd(state) {
                    return nested === "cancel"
                        ? actions.cancel(state, secondRef, "CONTENT_CANCELLED")
                        : advanceAction(state, secondRef);
                },
            },
            { scopes: [{ type: "ACTION", ref: firstRef }] },
        ).state;
        const before = state;
        state = leave(state, 0, "RETREAT");
        assert.equal(executions, 0);
        assert.equal(state.actions.size, 0);
        assert.equal(
            state.events.filter(
                event => event.executionId === secondRef.id && event.type === "ACTION_CANCELLED",
            ).length,
            1,
        );
        assert.equal(
            state.events.filter(
                event => event.executionId === secondRef.id && event.type === "ACTION_FINISHED",
            ).length,
            0,
        );
        assert.equal(
            state.events.filter(
                event => event.executionId === firstRef.id && event.type === "ACTION_CANCELLED",
            ).length,
            1,
        );
        assert.equal(getUnit(state, 0), undefined);
        assert.equal(before.actions.size, 2);
        assert.equal(getUnit(before, 0).lifecycle, "PRESENT");
    });
}

test("sequential predefined commands allocate after all earlier callback results", () => {

    let state = battle(unit(0));
    state = { ...state, execution: { ...state.execution, nextUnitId: 1 } };
    state = install(state, unitRef(getUnit(state, 0)), {
        id: "birth-on-end",
        initialize: () => ({}),
        onEnd(state, context) {
            const created = instantiateUnitPlacement(
                state,
                { definition: { id: "callback-child" }, position: [1, 0] },
            );
            return advanceBattlefield(created.state, created.value.changes);
        },
    }).state;
    const before = state;
    const definitions = [
        {
            id: 0,
            alias: null,
            initiallyPresent: true,
            creation: {
                type: "UNIT",
                definition: getUnit(state, 0).definition,
                position: [0, 0],
                navigationModifiers: [],
            },
        },
        {
            id: 1,
            alias: null,
            initiallyPresent: false,
            creation: {
                type: "UNIT",
                definition: { id: "predefined-child" },
                position: [2, 0],
                navigationModifiers: [],
            },
        },
    ];
    const advanced = advancePredefined({ ...state, predefinedPresence: [{ definitionId: 0, source: { type: "UNIT", unitId: 0 } }] }, definitions, [
            { type: "REMOVE_PREDEFINED", definitionId: 0, reason: "SCRIPT" },
            { type: "APPEAR_PREDEFINED", definitionId: 1 },
        ], 0);
    assert.deepEqual([...advanced.battlefield.units.keys()], [1, 2]);
    assert.equal(getUnit(advanced, 1).definition.id, "callback-child");
    assert.equal(getUnit(advanced, 2).definition.id, "predefined-child");
    assert.equal(advanced.execution.nextUnitId, 3);
    assert.deepEqual(advanced.predefinedPresence, [{ definitionId: 1, source: { type: "UNIT", unitId: 2 } }]);
    assert.equal(before.execution.nextUnitId, 1);
    assert.equal(getUnit(before, 0).lifecycle, "PRESENT");
});
