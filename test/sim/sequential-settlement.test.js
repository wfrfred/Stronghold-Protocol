import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, actionDefinition } from "../helpers/action-fixture.js";
import { getUnit, advanceBattlefield } from "../../dist/core/tactical/battle/state.js";
import { removeUnitWithEffects } from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import {
    acceptActionExecution,
    cancelActionExecution,
    resumeActionExecution,
} from "../../dist/core/tactical/unit/capability/action/process.js";
import { install } from "../../dist/core/tactical/unit/effect/operations.js";
import { advancePredefined } from "../../dist/core/tactical/battle/steps/predefined.js";
import { instantiateUnitPlacement } from "../../dist/core/tactical/battle/creation/placement.js";

for (const nested of ["cancel", "resume", "resume empty", "resume wait"]) {
    test(`sequential departure: a nested ${nested} cannot produce a second action outcome`, () => {
        const resources = new CombatResources();
        let state = battle(unit(0), unit(1));
        for (let index = 0; index < 2; index++) {
            const accepted = acceptActionExecution(state.actionExecutions, {
                sourceUnitId: 0,
                definition: actionDefinition(),
                inputTargetUnitId: 1,
                bindings: new Map([["primary", [1]]]),
                tick: 0,
            });
            state = { ...state, actionExecutions: accepted.state };
        }
        let executions = 0;
        state = install(
            state,
            getUnit(state, 1),
            {
                id: "nested-action-end",
                initialize: () => ({}),
                onEnd(state, context) {
                    if (nested === "cancel") {
                        return cancelActionExecution(
                            state,
                            { executionId: 1, tick: 0, reason: "CONTENT_CANCELLED" },
                            context.call,
                        ).state;
                    }
                    return resumeActionExecution(
                        state,
                        {
                            executionId: 1,
                            tick: 0,
                            segments:
                                nested === "resume"
                                    ? [
                                          {
                                              type: "EXECUTE",
                                              run(state) {
                                                  executions++;
                                                  return { state, value: undefined };
                                              },
                                          },
                                      ]
                                    : nested === "resume wait"
                                      ? [
                                            {
                                                type: "WAIT",
                                                resolve() {
                                                    executions++;
                                                    return { type: "FOR_TICKS", ticks: 100 };
                                                },
                                            },
                                        ]
                                      : [],
                        },
                        resources,
                        context.call,
                    ).state;
                },
            },
            { scopes: [{ type: "ACTION", executionId: 0 }] },
        ).state;
        const before = state;
        state = removeUnitWithEffects(state, 0, "RETREAT", resources, 0);
        assert.equal(executions, 0);
        assert.deepEqual(state.actionExecutions.executions, []);
        assert.equal(
            state.events.filter(
                (event) => event.executionId === 1 && event.type === "ACTION_CANCELLED",
            ).length,
            1,
        );
        assert.equal(
            state.events.filter(
                (event) => event.executionId === 1 && event.type === "ACTION_FINISHED",
            ).length,
            0,
        );
        assert.equal(
            state.events.filter(
                (event) => event.executionId === 0 && event.type === "ACTION_CANCELLED",
            ).length,
            1,
        );
        assert.equal(getUnit(state, 0), undefined);
        assert.equal(before.actionExecutions.executions.length, 2);
        assert.equal(getUnit(before, 0).lifecycle, "PRESENT");
    });
}

test("sequential predefined commands allocate after all earlier callback results", () => {
    const resources = new CombatResources();
    let state = battle(unit(0));
    state = { ...state, execution: { ...state.execution, nextUnitId: 1 } };
    state = install(state, getUnit(state, 0), {
        id: "birth-on-end",
        initialize: () => ({}),
        onEnd(state, context) {
            const created = instantiateUnitPlacement(
                { definition: { id: "callback-child" }, position: [1, 0] },
                state.execution,
                context.tick,
            );
            return advanceBattlefield({ ...state, execution: created.execution }, created.changes);
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
    const advanced = advancePredefined(
        state,
        definitions,
        [{ definitionId: 0, source: { type: "UNIT", unitId: 0 } }],
        [
            { type: "REMOVE_PREDEFINED", definitionId: 0, reason: "SCRIPT" },
            { type: "APPEAR_PREDEFINED", definitionId: 1 },
        ],
        0,
        resources,
    );
    assert.deepEqual(advanced.state.registeredUnitIds, [1, 2]);
    assert.equal(getUnit(advanced.state, 1).definition.id, "callback-child");
    assert.equal(getUnit(advanced.state, 2).definition.id, "predefined-child");
    assert.equal(advanced.state.execution.nextUnitId, 3);
    assert.deepEqual(advanced.value, [{ definitionId: 1, source: { type: "UNIT", unitId: 2 } }]);
    assert.equal(before.execution.nextUnitId, 1);
    assert.equal(getUnit(before, 0).lifecycle, "PRESENT");
});
