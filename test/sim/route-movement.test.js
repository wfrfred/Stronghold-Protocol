import assert from "node:assert/strict";
import { test } from "node:test";
import {
    advanceBattlefield, battlefieldView, createBattleState, getUnit, registerUnit,
} from "../../dist/core/tactical/battle/state.js";
import { advanceMovement } from "../../dist/core/tactical/battle/steps/movement.js";
import { leave } from "../../dist/core/tactical/battle/execution/unit.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import { create } from "../../dist/core/tactical/battlefield/state.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import { Map as NavigationMap } from "../../dist/core/tactical/battlefield/navigation/map.js";
import { create as createNavigation, nextPoint as nextNavigationPoint } from "../../dist/core/tactical/battlefield/navigation/state.js";
import * as routeOperations from "../../dist/core/tactical/unit/capability/route/operations.js";

const step = battle => advanceMovement(battle, { routeMoveMultiplier: 1 });
const cell = overrides => ({
    passable: true, cost: 1, departures: { UP: true, RIGHT: true, DOWN: true, LEFT: true }, ...overrides,
});
const route = overrides => ({
    pathMotionMode: "WALK", startPosition: [0, 0], endPosition: [4, 0], offset: [0, 0],
    checkpoints: [], requireAllCheckpoints: true, alwaysCheckCurrentPoint: true, ...overrides,
});

function battle(rows = 5, columns = 3, cells = Array.from({ length: rows * columns }, () => cell())) {
    const tile = createTile({
        heightType: "LOWLAND", buildableType: "ALL", passableMask: "ALL",
        playerSideMask: "ALL", terrain: "NORMAL", mechanism: null,
    });
    const state = createBattleState(create({ map: createBattlefieldMap(rows, columns, Array(rows * columns).fill(tile)) }));
    const navigation = createNavigation({
        WALK: new NavigationMap(rows, columns, cells),
        FLY: new NavigationMap(rows, columns, cells.map(entry => ({ ...entry, cost: 1 }))),
    });
    return { ...state, battlefield: { ...state.battlefield, navigation } };
}

function unit(battle, id, definition, position = [0, 0]) {
    return initialize(battle, {
        id, position,
        definition: {
            id: `route-movement-${id}`, spatialPresence: {},
            locomotion: { speed: 2, minSpeed: 0, halfBodyWidth: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } },
            route: route(), ...definition,
        },
    }).value;
}

test("Battle movement applies Locomotion's destination reflection and preserves integrated velocity", () => {
    const cells = Array.from({ length: 15 }, () => cell());
    cells[8] = cell({ passable: false });
    let state = battle(5, 3, cells);
    const initial = unit(state, 1, {
        locomotion: { speed: 1, minSpeed: 0, halfBodyWidth: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 0 } },
    }, [1, 2]);
    const moving = { ...initial, locomotion: { ...initial.locomotion, velocity: [1, 0] } };
    state = registerUnit(state, moving);
    const advanced = step(state);
    assert.deepEqual(getUnit(advanced, 1).position, [0, 2]);
    assert.deepEqual(getUnit(advanced, 1).locomotion.velocity, [1, 0]);
    assert.deepEqual(battlefieldView(advanced).unitsAt([2, 0]).map(entry => entry.id), [1]);
    assert.deepEqual(battlefieldView(advanced).unitsAt([2, 1]), []);
    assert.deepEqual(advanced.events, []);
    assert.deepEqual(advanced.removedUnits, []);
    assert.equal(getUnit(state, 1), moving);
});

test("Main completion stops motion while blocked and produces one event only when departure succeeds", () => {
    let state = battle();
    const blocker = initialize(state, { id: 1, position: [0, 0], definition: {
        id: "route-movement-blocker", spatialPresence: {},
        allegiance: { side: "ALLY" }, layer: { type: "GROUND" },
        blocker: { capacity: 1, geometry: { radius: 1 } },
    } }).value;
    const enemy = unit(state, 2, {
        route: route({ endPosition: [0, 0] }), allegiance: { side: "ENEMY" },
        layer: { type: "GROUND" }, blockable: { volume: 1 },
    });
    state = registerUnit(state, blocker);
    state = registerUnit(state, {
        ...enemy, locomotion: { ...enemy.locomotion, velocity: [1, 0] },
    });
    state = advanceBattlefield(state, [{ type: "SET_BLOCKING_RELATIONS", relations: [{ blockerUnitId: 1, blockedUnitId: 2 }] }]);
    const first = step(state);
    assert.equal(getUnit(first, 2).route.main.phase.type, "COMPLETED");
    assert.deepEqual(getUnit(first, 2).position, [0, 0]);
    assert.deepEqual(getUnit(first, 2).locomotion.velocity, [1, 0]);
    assert.equal(first.events.some(event => event.type === "ROUTE_COMPLETED"), false);
    const blockedAgain = step({ ...first, tick: 1 });
    assert.equal(blockedAgain.events.some(event => event.type === "ROUTE_COMPLETED"), false);
    const departed = step(leave(blockedAgain, 1, "SCRIPT"));
    assert.equal(getUnit(departed, 2), undefined);
    assert.deepEqual(departed.events.filter(event => event.type === "ROUTE_COMPLETED").map(event => event.unitId), [2]);
    assert.equal(step(departed).events.filter(event => event.type === "ROUTE_COMPLETED").length, 1);
});

test("Main departure callbacks can remove a later candidate before its route executes", () => {
    let state = battle();
    state = registerUnit(state, unit(state, 1, {
        route: route({ endPosition: [0, 0] }),
        onLeave: current => leave(current, 2, "SCRIPT"),
    }));
    state = registerUnit(state, unit(state, 2, {
        route: route({ checkpoints: [{ type: "ALERT" }] }),
    }));
    const advanced = step(state);
    assert.equal(getUnit(advanced, 1), undefined);
    assert.equal(getUnit(advanced, 2), undefined);
    assert.deepEqual(advanced.events.filter(event => event.type === "ROUTE_COMPLETED").map(event => event.unitId), [1]);
    assert.equal(advanced.events.some(event => event.type === "ROUTE"), false);
});

test("a route wait skips Locomotion without clearing its history velocity", () => {
    let state = battle();
    const initial = unit(state, 1, {
        route: route({ checkpoints: [{ type: "WAIT", tick: 3 }] }),
    });
    state = registerUnit(state, {
        ...initial,
        locomotion: { ...initial.locomotion, velocity: [0.3, 0.4] },
    });
    const waiting = step(state);
    assert.deepEqual(getUnit(waiting, 1).position, [0, 0]);
    assert.deepEqual(getUnit(waiting, 1).locomotion.velocity, [0.3, 0.4]);
    const resumed = step({ ...waiting, tick: 3 });
    assert.notDeepEqual(getUnit(resumed, 1).position, [0, 0]);
});

test("Route keeps the navigation tracking point when its full body ray is blocked but this Tick can move", () => {
    const cells = Array.from({ length: 10 }, () => cell());
    cells[6] = cell({ passable: false });
    let state = battle(2, 5, cells);
    const initial = unit(state, 1, {
        locomotion: { speed: 0.01, minSpeed: 0, halfBodyWidth: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } },
        route: route({
            endPosition: [1, 4], offset: [0, 0.4],
            checkpoints: [{ type: "MOVE", position: [0, 4], offset: [0, 0] }],
        }),
    }, [0, 0.8]);
    state = registerUnit(state, initial);
    state = routeOperations.advance(state, { id: 1 });
    const target = nextNavigationPoint(state.battlefield.navigation, "WALK", [0, 0.4], [4, 0]);
    assert.deepEqual(target, [4, 0]);
    assert.deepEqual(routeOperations.movementTarget(state, { id: 1 }), { nextPoint: [4, 0.4], goal: [4, 0.4] });
    const moved = getUnit(step(state), 1);
    assert.ok(moved.position[0] > initial.position[0]);
    assert.ok(moved.locomotion.velocity[0] > 0);
    assert.equal(moved.position[0] < 0.1, true);
});

test("Route returns the final MOVE goal separately from the next navigation node", () => {
    const cells = Array.from({ length: 15 }, () => cell());
    cells[7] = cell({ passable: false });
    let state = battle(3, 5, cells);
    state = registerUnit(state, unit(state, 1, {
        route: route({
            endPosition: [2, 4], offset: [0, 0.1],
            checkpoints: [{ type: "MOVE", position: [1, 4], offset: [0, 0.2] }],
        }),
    }, [0, 1.1]));
    state = routeOperations.advance(state, { id: 1 });
    const target = routeOperations.movementTarget(state, { id: 1 });
    assert.deepEqual(target.goal, [4, 1.3]);
    assert.notDeepEqual(target.nextPoint, target.goal);
    const next = nextNavigationPoint(state.battlefield.navigation, "WALK", [0, 1], [4, 1.2]);
    assert.deepEqual(target.nextPoint, [next[0], next[1] + 0.1]);
});

test("Runtime consumes the current path mode without changing the unit's ground identity", () => {
    const cells = Array.from({ length: 10 }, () => cell());
    cells[9] = cell({ passable: false });
    let state = battle(2, 5, cells);
    const flyCells = Array.from({ length: 10 }, () => cell());
    state = {
        ...state,
        battlefield: {
            ...state.battlefield,
            navigation: createNavigation({
                WALK: state.battlefield.navigation.baseline.WALK,
                FLY: new NavigationMap(2, 5, flyCells),
            }),
        },
    };
    state = registerUnit(state, unit(state, 1, {
        layer: { type: "GROUND" },
        route: route({ endPosition: [1, 4] }),
        locomotion: { speed: 0.1, minSpeed: 0, halfBodyWidth: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } },
    }, [0, 1]));
    assert.equal(step(state), state);
    const changed = routeOperations.setPathMotionMode(state, { id: 1 }, "FLY");
    const moved = getUnit(step(changed), 1);
    assert.ok(moved.position[0] > 0);
    assert.equal(moved.layer.type, "GROUND");
    assert.equal(moved.route.main.definition.pathMotionMode, "WALK");
    assert.equal(moved.route.main.pathMotionMode, "FLY");
});

test("Alternative takeover preserves Main checkpoint progress while its endpoint can still trigger departure", () => {
    for (const requireAllCheckpoints of [false, true]) {
        let state = battle(1, 6);
        const initial = unit(state, 1, {
            route: route({
                endPosition: [0, 2], requireAllCheckpoints,
                checkpoints: [{ type: "WAIT", tick: 100 }],
            }),
        }, [2, 0]);
        state = registerUnit(state, initial);
        state = routeOperations.setAlternative(state, { id: 1 }, route({ endPosition: [0, 5] }));
        const advanced = step(state);
        const remaining = getUnit(advanced, 1);
        assert.equal(remaining === undefined, !requireAllCheckpoints);
        assert.equal(advanced.events.filter(event => event.type === "ROUTE_COMPLETED").length, requireAllCheckpoints ? 0 : 1);
        if (remaining !== undefined) {
            assert.equal(remaining.route.main, initial.route.main);
            assert.notEqual(remaining.route.alternative, null);
        }
    }
});
