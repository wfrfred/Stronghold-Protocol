import assert from "node:assert/strict";
import { test } from "node:test";
import {
    advanceBattlefield, battlefieldView, createBattleState, getUnit, registerUnit, updateUnit,
} from "../../dist/core/tactical/battle/state.js";
import { advanceMovement } from "../../dist/core/tactical/battle/steps/movement.js";
import { leave } from "../../dist/core/tactical/battle/execution/unit.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import { create } from "../../dist/core/tactical/battlefield/state.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import { Map as NavigationMap } from "../../dist/core/tactical/battlefield/navigation/map.js";
import { create as createNavigation } from "../../dist/core/tactical/battlefield/navigation/state.js";

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
            locomotion: { moveSpeedPerTick: 2, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } },
            route: route(), ...definition,
        },
    }).value;
}

test("Battle movement rejects an inertial wall crossing without publishing invalid spatial state", () => {
    const cells = Array.from({ length: 15 }, () => cell());
    cells[1] = cell({ passable: false });
    let state = battle(5, 3, cells);
    const initial = unit(state, 1, {
        locomotion: { moveSpeedPerTick: 2, steeringParameters: { steeringFactor: 1, maxSteeringForce: 0 } },
    });
    const moving = { ...initial, locomotion: { ...initial.locomotion, moving: true, steering: { lastVelocity: [2, 0] } } };
    state = registerUnit(state, moving);
    const advanced = step(state);
    assert.deepEqual(getUnit(advanced, 1).position, [0, 0]);
    assert.equal(getUnit(advanced, 1).locomotion.moving, false);
    assert.deepEqual(getUnit(advanced, 1).locomotion.steering.lastVelocity, [2, 0]);
    assert.deepEqual(battlefieldView(advanced).unitsAt([0, 0]).map(entry => entry.id), [1]);
    assert.deepEqual(battlefieldView(advanced).unitsAt([0, 2]), []);
    assert.deepEqual(advanced.events, []);
    assert.deepEqual(advanced.removedUnits, []);
    assert.equal(getUnit(state, 1), moving);
});

test("Main completion stops motion while blocked and produces one event only when departure succeeds", () => {
    let state = battle();
    const blocker = initialize(state, { id: 1, position: [0, 0], definition: {
        id: "route-movement-blocker", spatialPresence: {},
        allegiance: { side: "ALLY" }, spatial: { layer: "GROUND" },
        blocker: { capacity: 1, geometry: { radius: 1 } },
    } }).value;
    const enemy = unit(state, 2, {
        route: route({ endPosition: [0, 0] }), allegiance: { side: "ENEMY" },
        spatial: { layer: "GROUND" }, blockable: { volume: 1 },
    });
    state = registerUnit(state, blocker);
    state = registerUnit(state, {
        ...enemy, locomotion: { ...enemy.locomotion, moving: true, steering: { lastVelocity: [1, 0] } },
    });
    state = advanceBattlefield(state, [{ type: "SET_BLOCKING_RELATIONS", relations: [{ blockerUnitId: 1, blockedUnitId: 2 }] }]);
    const first = step(state);
    assert.equal(getUnit(first, 2).route.main.phase.type, "COMPLETED");
    assert.deepEqual(getUnit(first, 2).position, [0, 0]);
    assert.equal(getUnit(first, 2).locomotion.moving, false);
    assert.deepEqual(getUnit(first, 2).locomotion.steering.lastVelocity, [0, 0]);
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
