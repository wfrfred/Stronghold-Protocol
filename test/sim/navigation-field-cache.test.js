import { test } from "node:test";
import assert from "node:assert/strict";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import {
    advanceBattlefield,
    battlefieldView,
    createBattleState,
} from "../../dist/core/tactical/battle/state.js";
import { create as createBattlefield } from "../../dist/core/tactical/battlefield/state.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createNavigationModifierDefinition } from "../../dist/core/tactical/battlefield/navigation/modifier.js";
import { createDefinition } from "../../dist/core/tactical/unit/archetype/enemy.js";
import { createRouteDefinition } from "../../dist/core/tactical/unit/capability/locomotion/route/definition.js";

function map() {
    return createBattlefieldMap(1, 4, Array.from({ length: 4 }, () => ({
        heightType: "LOWLAND", buildableType: "ALL", passableMask: "ALL",
        playerSideMask: "ALL", terrain: "NORMAL", mechanism: null,
    })));
}

const request = { targetTile: [0, 3], options: { allowDiagonalMove: true } };

function field(state, query = request) {
    const view = battlefieldView(state);
    return view.fieldCache.get(view.navigationMaps.WALK, query);
}

test("functional battlefield views reuse fields after unrelated changes and across Tick state creation", () => {
    const initial = createBattleState(createBattlefield({ map: map() }));
    const before = JSON.stringify(initial);
    const first = field(initial);
    assert.equal(field(initial), first, "new Views reuse the same field");
    assert.equal(JSON.stringify(initial), before, "cache queries do not alter authority state");

    const changed = advanceBattlefield(initial, [{
        type: "REGISTER_MECHANISM",
        mechanism: { id: 0, definition: { id: "unrelated" }, active: true },
    }]);
    assert.notEqual(changed.battlefield, initial.battlefield);
    assert.equal(changed.battlefield.navigationMaps.WALK, initial.battlefield.navigationMaps.WALK);
    assert.equal(field(changed), first);
    const nextTick = createBattleState(changed.battlefield, changed.execution, changed.actions, 1);
    assert.equal(field(nextTick), first, "a new Tick retains geometry memoization");
    assert.equal(JSON.stringify(initial), before);

    assert.notEqual(field(initial, { ...request, targetTile: [0, 2] }), first);
    assert.notEqual(field(initial, { ...request, options: { allowDiagonalMove: false } }), first);
});

test("functional views use changed navigation content while retained Views keep their cached fields", () => {
    const initial = createBattleState(createBattlefield({ map: map() }));
    const originalView = battlefieldView(initial);
    const original = field(initial);
    const before = JSON.stringify(initial);
    const changed = advanceBattlefield(initial, [
        { type: "REGISTER_MECHANISM", mechanism: { id: 0, definition: { id: "cost-source" }, active: true } },
        {
            type: "ADD_NAVIGATION_MODIFIER",
            navigationModifier: {
                id: 0,
                definition: createNavigationModifierDefinition({
                    id: "cost", WALK: { denyPassage: false, deniedDepartures: [], costFloor: 10 }, FLY: null,
                }),
                source: { type: "MECHANISM", mechanismId: 0 },
                active: true, expiresAtTick: null,
                region: { type: "FIXED", position: [0, 1], range: [[0, 0]], direction: "RIGHT" },
            },
        },
    ]);
    const restricted = field(changed);
    assert.notEqual(restricted, original);
    assert.equal(original.nodes[0].distance, 3);
    assert.equal(restricted.nodes[0].distance, 12);
    assert.equal(field(changed), restricted);
    assert.equal(originalView.fieldCache.get(originalView.navigationMaps.WALK, request), original);
    assert.equal(JSON.stringify(initial), before);
    assert.equal(Object.isFrozen(original), true);
    assert.throws(() => { original.nodes[0].distance = 0; }, TypeError);
});

test("BattleRuntime movement reuses the field for a second enemy spawned on a later Tick", () => {
    const definition = createDefinition({
        id: "cache-walker", vitality: { maxHp: 100 },
        locomotion: {
            moveSpeedPerTick: 0.1,
            steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
        },
    });
    const route = createRouteDefinition({
        pathMotionMode: "WALK", startPosition: [0, 0], endPosition: [0, 3],
        spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [],
        allowDiagonalMove: true, visitEveryTileCenter: false,
        visitEveryNodeCenter: false, visitEveryCheckPoint: true,
    });
    const input = {
        map: map(), initialUnits: [], initialMechanisms: [], initialNavigationModifiers: [],
        predefines: [], maxTicks: 10, routeMoveMultiplier: 1, rngState: 1,
        schedule: {
            type: "TIMELINE",
            spawns: [0, 1].map(tick => ({
                tick, definition, route, alwaysCheckCurrentPoint: true, notCountInTotal: false,
                timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
            })),
        },
    };
    const before = JSON.stringify(input);
    const runtime = new BattleRuntime(input);
    runtime.step();
    const firstTick = runtime.snapshot();
    const firstActivity = firstTick.units[0].locomotion.mainRoute.navigation.execution.activity;
    assert.equal(firstActivity.type, "FOLLOWING");
    const firstPath = firstActivity.path;

    runtime.step();
    const secondTick = runtime.snapshot();
    assert.equal(secondTick.units.length, 2);
    const secondActivity = secondTick.units[1].locomotion.mainRoute.navigation.execution.activity;
    assert.equal(secondActivity.type, "FOLLOWING");
    assert.notEqual(secondActivity.path.request.id, firstPath.request.id);
    assert.equal(secondActivity.path.field, firstPath.field, "movement consumes the shared View cache");
    assert.equal(secondTick.units[0].locomotion.mainRoute.navigation.execution.activity.path.field, firstPath.field);
    assert.ok(secondTick.units[0].position[0] > firstTick.units[0].position[0]);
    assert.equal(firstTick.tickIndex, 1);
    assert.equal(JSON.stringify(input), before);
});
