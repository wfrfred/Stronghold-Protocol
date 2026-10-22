import assert from "node:assert/strict";
import { test } from "node:test";
import { createRng } from "../../dist/core/common/rng.js";
import { initializeRoutedEnemy } from "../../dist/core/tactical/battle/creation/enemy.js";
import { createInput, normalize } from "../../dist/core/tactical/battle/creation/route.js";

import { parseRouteDefinition } from "../../dist/data/arknights/route.js";
import { fixtureBattle } from "../helpers/unit.js";

const move = (column, type = "MOVE") => ({
    type,
    target: { position: [0, column], reachOffset: [0.1, -0.2] },
});
const input = (overrides = {}) => createInput({
    pathMotionMode: "WALK",
    startPosition: [0, 1],
    endPosition: [0, 8],
    spawnOffset: [0.2, -0.3],
    spawnRandomRange: [0.4, 0.5],
    checkpoints: [],
    visitEveryCheckPoint: true,
    ...overrides,
});
const timing = { waveStartedAtTick: 20, fragmentStartedAtTick: 45 };
const enemyDefinition = {
    spatialPresence: {},
    id: "route-spawn-test",
    vitality: { maxHp: 100, defense: 0, resistance: 0 },
    locomotion: {
        speed: 0.1,
        minSpeed: 0,
        halfBodyWidth: 0,
        steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
    },
};

test("Spawn binds wave and fragment waits while keeping relative waits relative", () => {
    const raw = input({ checkpoints: [
        { type: "WAIT_FOR_TICKS", durationTicks: 5 },
        { type: "WAIT_FOR_PLAY_TICK", targetPlayTick: 7 },
        { type: "WAIT_CURRENT_WAVE_TICKS", targetElapsedTicks: 12 },
        { type: "WAIT_CURRENT_FRAGMENT_TICKS", targetElapsedTicks: 8 },
    ] });
    const first = normalize(raw, timing, [0.25, -0.4], true);
    const second = normalize(raw, { waveStartedAtTick: 100, fragmentStartedAtTick: 120 }, [0, 0], false);

    assert.deepEqual(first.checkpoints, [
        { type: "WAIT", tick: 5 },
        { type: "WAIT_UNTIL", tick: 7 },
        { type: "WAIT_UNTIL", tick: 32 },
        { type: "WAIT_UNTIL", tick: 53 },
    ]);
    assert.deepEqual(second.checkpoints.map(checkpoint => checkpoint.tick), [5, 7, 112, 128]);
    assert.deepEqual(first.offset, [0.25, -0.4]);
    assert.equal(first.alwaysCheckCurrentPoint, true);
    assert.equal(first.requireAllCheckpoints, true);
    assert.equal("timing" in first, false);
    assert.equal("spawnRandomRange" in first, false);
});

test("Patrol normalization retains group loops and remaps later jump indices", () => {
    const raw = input({ checkpoints: [
        move(1),
        { type: "WAIT_FOR_TICKS", durationTicks: 3 },
        move(2, "PATROL_MOVE"),
        move(3, "PATROL_MOVE"),
        move(4),
        move(5, "PATROL_MOVE"),
        move(6, "PATROL_MOVE"),
    ] });
    const route = normalize(raw, timing, [0, 0], true);

    assert.deepEqual(route.checkpoints.map(checkpoint => checkpoint.type), [
        "MOVE", "WAIT", "MOVE", "MOVE", "GOTO", "MOVE", "MOVE", "MOVE", "GOTO",
    ]);
    assert.deepEqual(route.checkpoints[4], { type: "GOTO", index: 1 });
    assert.deepEqual(route.checkpoints[8], { type: "GOTO", index: 6 });
    assert.deepEqual(route.checkpoints[2], { type: "MOVE", position: [0, 2], offset: [0.1, -0.2] });
    const single = normalize(input({ checkpoints: [move(1, "PATROL_MOVE")] }), timing, [0, 0], true);
    assert.deepEqual(single.checkpoints.map(checkpoint => checkpoint.type), ["MOVE"]);
});

test("Route parser keeps source construction facts and drops removed runtime policies", () => {
    const raw = {
        motionMode: "WALK",
        startPosition: { row: 0, col: 1 },
        endPosition: { row: 0, col: 5 },
        spawnOffset: { x: 0.25, y: -0.1 },
        spawnRandomRange: { x: 0.2, y: 0.3 },
        checkpoints: [{
            type: "MOVE", position: { row: 0, col: 3 }, reachOffset: { x: 0.1, y: 0.2 },
            randomizeReachOffset: false, reachDistance: 0,
        }],
        allowDiagonalMove: false,
        visitEveryTileCenter: false,
        visitEveryNodeCenter: false,
        visitEveryCheckPoint: true,
    };
    const route = parseRouteDefinition(raw);

    assert.deepEqual(route.spawnRandomRange, [0.2, 0.3]);
    assert.deepEqual(route.checkpoints[0], {
        type: "MOVE", target: { position: [0, 3], reachOffset: [0.1, 0.2] },
    });
    assert.equal("allowDiagonalMove" in route, false);
    assert.equal("visitEveryNodeCenter" in route, false);
    assert.equal("visitEveryTileCenter" in route, false);
    for (const type of ["MAP_OFFSET_MOVE", "WAIT_BOSSRUSH_WAVE"]) {
        assert.throws(() => parseRouteDefinition({
            ...raw, checkpoints: [{ ...raw.checkpoints[0], type }],
        }), RangeError);
    }
});

test("Enemy initialization uses one sampled offset for its Route Definition and body position", () => {
    const raw = input();
    const seed = 831;
    const rng = createRng(seed);
    const expected = [
        raw.spawnOffset[0] + (-raw.spawnRandomRange[0] + rng.next() * (2 * raw.spawnRandomRange[0])),
        raw.spawnOffset[1] + (-raw.spawnRandomRange[1] + rng.next() * (2 * raw.spawnRandomRange[1])),
    ];
    const before = fixtureBattle(9, { rngState: seed });
    const result = initializeRoutedEnemy(before, {
        id: 3, definition: enemyDefinition, route: raw, timing, alwaysCheckCurrentPoint: true,
    });
    const enemy = result.value.enemy;

    assert.equal(result.state.execution.rngState, rng.state());
    assert.equal(before.execution.rngState, seed);
    assert.deepEqual(enemy.definition.route.offset, expected);
    assert.deepEqual(enemy.position, [1 + expected[0], expected[1]]);
    assert.strictEqual(enemy.route.main.definition, enemy.definition.route);
    assert.equal(enemy.route.alternative, null);
    assert.equal("route" in enemyDefinition, false);
    assert.equal(result.state.battlefield.units.has(enemy.id), false);
    assert.equal("mainRoute" in enemy.locomotion, false);
});

test("Repeated enemy births share the Enemy Definition without sharing per-birth route context", () => {
    const raw = input({ checkpoints: [{ type: "WAIT_CURRENT_WAVE_TICKS", targetElapsedTicks: 2 }] });
    const before = fixtureBattle(0, { rngState: 42 });
    const first = initializeRoutedEnemy(before, {
        id: 0, definition: enemyDefinition, route: raw, timing, alwaysCheckCurrentPoint: true,
    });
    const second = initializeRoutedEnemy(first.state, {
        id: 1, definition: enemyDefinition, route: raw,
        timing: { waveStartedAtTick: 100, fragmentStartedAtTick: 120 }, alwaysCheckCurrentPoint: false,
    });

    assert.equal(first.value.enemy.definition.route.checkpoints[0].tick, 22);
    assert.equal(second.value.enemy.definition.route.checkpoints[0].tick, 102);
    assert.notDeepEqual(first.value.enemy.definition.route.offset, second.value.enemy.definition.route.offset);
    assert.equal("route" in enemyDefinition, false);
    assert.equal("alwaysCheckCurrentPoint" in raw, false);
});

test("Spawn rejects unrepresentable absolute deadlines and spawn bounds before publishing state", () => {
    assert.throws(() => normalize(input({ checkpoints: [
        { type: "WAIT_CURRENT_WAVE_TICKS", targetElapsedTicks: 1 },
    ] }), { waveStartedAtTick: Number.MAX_SAFE_INTEGER, fragmentStartedAtTick: 0 }, [0, 0], true), RangeError);
    const before = fixtureBattle(0, { rngState: 42 });
    assert.throws(() => initializeRoutedEnemy(before, {
        id: 0, definition: enemyDefinition, route: input({ spawnRandomRange: [Number.MAX_VALUE, 0] }),
        timing, alwaysCheckCurrentPoint: true,
    }), RangeError);
    assert.equal(before.execution.rngState, 42);
});
