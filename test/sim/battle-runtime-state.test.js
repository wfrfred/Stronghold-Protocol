import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";

import { appendEvents, removeUnit } from "../../dist/core/tactical/battle/state.js";
import { closeLifetime } from "../../dist/core/tactical/battle/execution/lifetime.js";
import { advancePredefined } from "../../dist/core/tactical/battle/steps/predefined.js";

import { createInput as createRouteDefinition } from "../../dist/core/tactical/battle/creation/route.js";
import { map } from "../helpers/action-fixture.js";

const locomotion = {
    halfBodyWidth: 0, minSpeed: 0, speed: 0,
    steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
};
const route = createRouteDefinition({
    pathMotionMode: "WALK", startPosition: [31, 0], endPosition: [31, 0],
    spawnOffset: [0, 0], spawnRandomRange: [0, 0],
    checkpoints: [{ type: "WAIT_FOR_TICKS", durationTicks: 1000 }],
    allowDiagonalMove: false, visitEveryTileCenter: false,
    visitEveryNodeCenter: false, visitEveryCheckPoint: true,
});
const spawn = (definition, tick) => ({
    tick, definition, route, alwaysCheckCurrentPoint: true, notCountInTotal: false,
    timing: { waveStartedAtTick: tick, fragmentStartedAtTick: tick },
});
function input(overrides = {}) {
    return {
        map, initialUnits: [], predefines: [], initialMechanisms: [], schedule: { type: "TIMELINE", spawns: [
            spawn({ spatialPresence: {}, id: "later", vitality: { maxHp: 100, defense: 0, resistance: 0 }, locomotion }, 100),
        ] },
        maxTicks: 10, routeMoveMultiplier: 1, rngState: 123,
        ...overrides,
    };
}
const predefined = (id, definition, initiallyPresent = false) => ({
    id, alias: null, initiallyPresent,
    creation: { type: "UNIT", definition, position: [id, 0], },
});

test("initial entry receives the complete battle state and its returned facts persist", () => {
    const observations = [];
    const onEnter = (state, id) => {
        observations.push(state);
        assert.equal(state.schedule.definition.spawns.length, 1);
        assert.deepEqual(state.predefinedPresence, [{ definitionId: 7, source: { type: "UNIT", unitId: 1 } }]);
        assert.equal(state.result, null);
        assert.equal(state.deployment.cards.length, 0);
        assert.equal(state.battlefield.units.has(id), true);
        return { ...state, completedRouteCount: state.completedRouteCount + 1 };
    };
    const battle = new BattleRuntime(input({
        initialUnits: [{ definition: { id: "initial", onEnter }, position: [0, 0] }],
        predefines: [predefined(7, { id: "predefined", onEnter }, true)],
    }));
    assert.equal(observations.length, 2);
    assert.equal(observations[0].completedRouteCount, 0);
    assert.equal(observations[1].completedRouteCount, 1);
    assert.equal(battle.snapshot().completedRouteCount, 2);
    battle.step();
    assert.equal(battle.snapshot().completedRouteCount, 2);
});

test("spawn entry observes recorded schedule progress before running content", () => {
    let observed;
    const definition = {
        spatialPresence: {},
        id: "spawned", vitality: { maxHp: 100, defense: 0, resistance: 0 }, locomotion,
        onEnter(state, id) {
            observed = state;
            assert.equal(state.schedule.cursor, 1);
            assert.equal(state.schedule.spawnedCount, 1);
            assert.equal(state.schedule.pendingSpawnCount, 0);
            assert.deepEqual(state.schedule.managedFinalUnitIds, [id]);
            return { ...state, completedRouteCount: 4 };
        },
    };
    const battle = new BattleRuntime(input({
        schedule: { type: "TIMELINE", spawns: [spawn(definition, 0)] },
    }));
    battle.step();
    assert.equal(battle.snapshot().completedRouteCount, 4);
    assert.equal(observed.schedule.spawnedCount, 1);
});

test("nested predefined entry and departure keep the latest presence bindings", () => {

    const observations = [];
    let definitions;
    definitions = [
        predefined(1, {
            id: "parent",
            onEnter(state) {
                observations.push(state.predefinedPresence.map(binding => binding.definitionId));
                return advancePredefined(state, definitions, [{ type: "APPEAR_PREDEFINED", definitionId: 2 }], state.tick);
            },
            onLeave(state) {
                observations.push(state.predefinedPresence.map(binding => binding.definitionId));
                return advancePredefined(state, definitions, [{ type: "APPEAR_PREDEFINED", definitionId: 3 }], state.tick);
            },
        }),
        predefined(2, { id: "entry-child" }),
        predefined(3, { id: "departure-child" }),
    ];
    const battle = new BattleRuntime(input({ predefines: definitions }));
    battle.step([{ type: "APPEAR_PREDEFINED", definitionId: 1 }]);
    const first = battle.snapshot();
    assert.deepEqual(first.predefinedPresence.map(binding => binding.definitionId), [1, 2]);
    battle.step([{ type: "REMOVE_PREDEFINED", definitionId: 1, reason: "SCRIPT" }]);
    assert.deepEqual(battle.snapshot().predefinedPresence.map(binding => binding.definitionId), [2, 3]);
    assert.deepEqual(observations, [[1], [2]]);
    assert.deepEqual(first.predefinedPresence.map(binding => binding.definitionId), [1, 2]);
});

test("starting a new tick clears temporary facts without changing retained state versions", () => {
    const received = [], returned = [];
    const battle = new BattleRuntime(input({
        initialUnits: [
            { position: [0, 0], definition: { id: "observer", onTick(state) {
                received.push(state);
                assert.deepEqual(state.events, []);
                assert.deepEqual(state.removedUnits, []);
                assert.equal(state.closedLifetimes.size, 0);
                if (state.tick === 0) {
                    state = removeUnit(state, 1, "SCRIPT");
                    state = closeLifetime(state, { type: "SKILL", ref: { host: { id: 0 }, id: 99 } });
                    state = appendEvents(state, [{ type: "ROUTE_COMPLETED", unitId: 1, tick: 0 }]);
                }
                returned.push(state);
                return state;
            } } },
            { position: [1, 0], definition: { id: "removed" } },
        ],
    }));
    const first = battle.step();
    const second = battle.step();
    assert.deepEqual(first.events.map(event => event.type), ["ROUTE_COMPLETED", "UNIT_REMOVED"]);
    assert.deepEqual(second.events, []);
    assert.equal(battle.snapshot().completedRouteCount, 1);
    assert.equal(returned[0].events.length, 1);
    assert.equal(returned[0].removedUnits.length, 1);
    assert.equal(returned[0].closedLifetimes.size, 1);
    assert.notEqual(received[1].events, returned[0].events);
    assert.notEqual(received[1].removedUnits, returned[0].removedUnits);
    assert.notEqual(received[1].closedLifetimes, returned[0].closedLifetimes);
});

test("a failed tick publishes neither schedule nor predefined or statistics changes", () => {
    const failure = new Error("late state failure");
    let fail = true;
    let failedState;
    const definition = {
        spatialPresence: {},
        id: "spawned", vitality: { maxHp: 100, defense: 0, resistance: 0 }, locomotion,
        onTick(state) {
            failedState = state;
            if (fail) throw failure;
            return state;
        },
    };
    const battle = new BattleRuntime(input({
        predefines: [predefined(5, { id: "appearing", onEnter: state => ({ ...state, completedRouteCount: 3 }) })],
        schedule: { type: "TIMELINE", spawns: [spawn(definition, 0)] },
    }));
    const before = battle.snapshot();
    const commands = [{ type: "APPEAR_PREDEFINED", definitionId: 5 }];
    assert.throws(() => battle.step(commands), error => error === failure);
    assert.deepEqual(battle.snapshot(), before);
    assert.equal(failedState.schedule.spawnedCount, 1);
    assert.equal(failedState.completedRouteCount, 3);
    assert.equal(failedState.predefinedPresence.length, 1);
    fail = false;
    battle.step(commands);
    assert.deepEqual(battle.snapshot().units.map(unit => unit.id), [0, 1]);
    assert.equal(battle.snapshot().completedRouteCount, 3);
    assert.equal(before.execution.nextUnitId, 0);
    assert.deepEqual(before.predefinedPresence, []);
});
