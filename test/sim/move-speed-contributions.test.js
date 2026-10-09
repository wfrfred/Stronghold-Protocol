import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { advanceMovement } from "../../dist/core/tactical/battle/steps/movement.js";
import { changeAlternativeRoutes } from "../../dist/core/tactical/battle/steps/route-control.js";
import { combatWorkView, getCombatUnit, updateCombatUnit } from "../../dist/core/tactical/battle/execution/work.js";
import { initializeRoutedEnemy } from "../../dist/core/tactical/battle/creation/enemy.js";
import { BattlefieldRuntime } from "../../dist/core/tactical/battlefield/runtime.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import { createNavigationMap } from "../../dist/core/tactical/battlefield/navigation/map.js";
import { createNavigationFieldCache } from "../../dist/core/tactical/battlefield/navigation/cache.js";
import { canTraverseNavigationSegment } from "../../dist/core/tactical/battlefield/navigation/segment.js";
import { getNavigationRequest } from "../../dist/core/tactical/battlefield/navigation/state.js";
import { createEnemyDefinition } from "../../dist/core/tactical/unit/archetype/enemy.js";
import { resolveMoveSpeedPerTick } from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import { moveSpeed, computedMoveSpeed } from "../../dist/core/tactical/unit/capability/locomotion/contributions.js";
import { stepRoutedUnit } from "../../dist/core/tactical/unit/capability/locomotion/step.js";
import { createRouteDefinition } from "../../dist/core/tactical/unit/capability/locomotion/route/definition.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { installNewEffect, setEffectEnabled, finishEffect, finalizeEffect } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { updateEffectState } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { copyUnitSnapshot } from "../../dist/core/tactical/unit/snapshot.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";
import * as modifier from "../../dist/core/tactical/modifier/value.js";
import { effectFixtureWork } from "../helpers/effects.js";

const address = { unitId: 0, instanceId: 0 };
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/arknights/${name}.json`, import.meta.url), "utf8"));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

function route(overrides = {}) {
    return createRouteDefinition({
        pathMotionMode: "WALK", startPosition: [0, 0], endPosition: [0, 7],
        spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [], allowDiagonalMove: false,
        visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true, ...overrides,
    });
}

function harness({ speed = 0.25, minimum = 0, definition = route(), maps } = {}) {
    const battlefield = BattlefieldRuntime.create({ map: createBattlefieldMap(1, 8, Array.from({ length: 8 }, () => createTile({
        heightType: "LOWLAND", buildableType: "ALL", passableMask: "ALL", playerSideMask: "ALL", terrain: "NORMAL", mechanism: null,
    }))) }, copyUnitSnapshot);
    const initialized = initializeRoutedEnemy({
        id: 0, tick: 0, definition: createEnemyDefinition({ id: "dynamic-mover", vitality: { maxHp: 100 }, locomotion: {
            moveSpeedPerTick: speed, minimumMoveSpeedPerTick: minimum,
            steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
        } }), route: definition, timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
        alwaysCheckCurrentPoint: true, rngState: 17, nextNavigationRequestId: 0,
    });
    let work = effectFixtureWork(initialized.enemy);
    let execution = { rngState: initialized.rngState, nextUnitId: 1, nextNavigationRequestId: initialized.nextNavigationRequestId, nextMechanismId: 0, nextNavigationModifierId: 0, nextProjectileId: 0 };
    const fieldCache = createNavigationFieldCache();
    return {
        battlefield,
        get work() { return work; },
        set work(value) { work = value; },
        get unit() { return getCombatUnit(work, 0); },
        get execution() { return execution; },
        step(resources, tick, controls = {}) {
            const unit = getCombatUnit(work, 0);
            const moved = stepRoutedUnit(unit, {
                tick, maps: maps ?? battlefield.navigationMaps, fieldCache, moveMultiplier: 1,
                movementAllowed: true, routeAdvanceAllowed: true, waitTickAllowed: true,
                rngState: execution.rngState, nextNavigationRequestId: execution.nextNavigationRequestId,
                evaluateContributions: resources.computations.bind({ unit, battlefield: combatWorkView(work) }),
                ...controls,
            });
            execution = { ...execution, rngState: moved.rngState, nextNavigationRequestId: moved.nextNavigationRequestId };
            work = updateCombatUnit(work, moved.unit);
            return moved;
        },
        reroute(command, tick) {
            const changed = changeAlternativeRoutes((id) => getCombatUnit(work, id), [command], execution, tick);
            execution = changed.execution;
            for (const change of changed.changes) { if (change.type === "UPDATE_UNIT") { work = updateCombatUnit(work, change.unit); } }
        },
    };
}

function register(resources, value = modifier.create({ multiplier: -0.5 })) {
    return resources.registerEffect(createEffectProgram({
        id: "movement-buff", initialize: () => ({ value }), ownState: (state) => ({ ...state }),
    }), { contributions: [moveSpeed((instance) => [instance.state.value])] });
}

const install = (work, program, resources, expiresAtTick = null) => installNewEffect(work, 0, program.ref, {
    source: null, scope: null, expiresAtTick,
}, resources, 0).work;

function speed(work, resources) {
    const unit = getCombatUnit(work, 0);
    return resolveMoveSpeedPerTick(unit.definition.locomotion, unit.locomotion, resources.computations.bind({ unit, battlefield: combatWorkView(work) }));
}

test("move speed: normalized minimum, arithmetic and movement permission are separate", () => {
    const resources = new CombatResources();
    const h = harness({ speed: 1 / 30, minimum: 0.1 / 30 });
    const program = register(resources, modifier.create({ multiplier: -2 }));
    h.work = install(h.work, program, resources);
    close(speed(h.work, resources), 0.1 / 30);
    const stopped = h.step(resources, 0, { moveMultiplier: 0 });
    assert.deepEqual(stopped.unit.position, [0, 0]);
    const denied = h.step(resources, 1, { movementAllowed: false });
    assert.deepEqual(denied.unit.position, [0, 0]);
    const moved = h.step(resources, 2, { moveMultiplier: 0.5 });
    close(moved.unit.position[0], 0.1 / 60);
    h.work = updateEffectState(h.work, 0, 0, program.ref, (state) => ({ ...state, value: modifier.create({ addition: 1 / 30, multiplier: 0.5, finalAddition: 1 / 30, finalScaler: 2 }) }), resources, 0);
    close(speed(h.work, resources), 8 / 30);
});

test("move speed: lifecycle and copies retain route samples, identities and visits", () => {
    const resources = new CombatResources();
    const program = register(resources);
    const h = harness({ definition: route({ checkpoints: [{ type: "MOVE", target: {
        position: [0, 6], reachOffset: [0.25, 0], randomizeReachOffset: true, reachDistance: 0,
    } }] }) });
    h.step(resources, 0);
    const before = h.unit;
    const copied = copyUnitSnapshot(before);
    const sample = before.locomotion.mainRoute.route.progress.checkpoint.goal;
    const cursor = before.locomotion.mainRoute.navigation.execution;
    const randomState = h.execution.rngState;
    h.work = install(h.work, program, resources);
    assert.equal(h.unit.locomotion.mainRoute, before.locomotion.mainRoute);
    assert.equal(h.unit.locomotion.mainRoute.route.progress.checkpoint.goal, sample);
    close(speed(h.work, resources), 0.125);
    h.work = setEffectEnabled(h.work, address, false, resources, 1);
    close(speed(h.work, resources), 0.25);
    h.work = setEffectEnabled(h.work, address, true, resources, 2);
    const participating = copyUnitSnapshot(h.unit);
    h.work = finishEffect(h.work, address, resources, 3);
    h.work = finalizeEffect(h.work, address, resources, 3);
    assert.equal(h.unit.locomotion.mainRoute.navigation.execution, cursor);
    assert.equal(h.unit.locomotion.moveSpeed.entries.length, 0);
    assert.equal(h.execution.rngState, randomState);
    assert.equal(copied.locomotion.moveSpeed.entries.length, 0);
    assert.ok(Object.isFrozen(participating.locomotion.moveSpeed.entries));
    assert.equal(participating.locomotion.moveSpeed.entries[0].participating, true);
});

test("move speed: in-flight acceleration, zero budget and restoration do not reset navigation", () => {
    const resources = new CombatResources();
    const program = register(resources);
    const h = harness();
    h.step(resources, 0);
    close(h.unit.position[0], 0.25);
    const request = getNavigationRequest(h.unit.locomotion.mainRoute.navigation);
    const randomState = h.execution.rngState;
    h.work = install(h.work, program, resources);
    h.step(resources, 1);
    close(h.unit.position[0], 0.375);
    h.work = updateEffectState(h.work, 0, 0, program.ref, (state) => ({ ...state, value: modifier.create({ multiplier: 1 }) }), resources, 0);
    h.step(resources, 2);
    close(h.unit.position[0], 0.875);
    h.work = updateEffectState(h.work, 0, 0, program.ref, (state) => ({ ...state, value: modifier.create({ multiplier: -1 }) }), resources, 0);
    h.step(resources, 3);
    close(h.unit.position[0], 0.875);
    h.work = setEffectEnabled(h.work, address, false, resources, 4);
    h.step(resources, 4);
    close(h.unit.position[0], 1.125);
    assert.equal(getNavigationRequest(h.unit.locomotion.mainRoute.navigation).id, request.id);
    assert.equal(h.execution.rngState, randomState);
});

test("move speed: main and alternative route share current contributions and one movement budget", () => {
    const resources = new CombatResources();
    const program = register(resources);
    const h = harness({ speed: 0.5 });
    h.work = install(h.work, program, resources);
    h.step(resources, 0);
    close(h.unit.position[0], 0.25);
    const main = h.unit.locomotion.mainRoute;
    h.reroute({ type: "SET_ALTERNATIVE_ROUTE", unitId: 0, route: route({ endPosition: [0, 4] }), alwaysCheckCurrentPoint: true }, 1);
    h.step(resources, 1);
    close(h.unit.position[0], 0.5);
    assert.equal(h.unit.locomotion.mainRoute, main);
    h.reroute({ type: "CLEAR_ALTERNATIVE_ROUTE", unitId: 0 }, 2);
    h.work = setEffectEnabled(h.work, address, false, resources, 2);
    h.step(resources, 2);
    close(h.unit.position[0], 1);
    assert.equal(getNavigationRequest(h.unit.locomotion.mainRoute.navigation).id, getNavigationRequest(main.navigation).id);
    assert.equal(h.unit.locomotion.alternativeRoute, null);
});

test("move speed: route WAIT consumes ticks independently of a speed contribution", () => {
    const resources = new CombatResources();
    const program = register(resources);
    const h = harness({ definition: route({ checkpoints: [{ type: "WAIT_FOR_TICKS", durationTicks: 3 }] }) });
    h.work = install(h.work, program, resources);
    h.step(resources, 0);
    assert.equal(h.unit.locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 2);
    h.work = setEffectEnabled(h.work, address, false, resources, 1);
    h.step(resources, 1);
    assert.equal(h.unit.locomotion.mainRoute.route.progress.checkpoint.remainingTicks, 1);
    h.work = setEffectEnabled(h.work, address, true, resources, 2);
    h.step(resources, 2);
    assert.equal(h.unit.locomotion.mainRoute.route.progress.phase, "END");
    assert.deepEqual(h.unit.position, [0, 0]);
    h.step(resources, 3);
    close(h.unit.position[0], 0.125);
});

test("move speed: computed providers read phase facts without becoming stored final speed", () => {
    const resources = new CombatResources();
    const program = resources.registerEffect(createEffectProgram({ id: "live-move", initialize: () => ({}), ownState: (state) => state }), {
        contributions: [computedMoveSpeed(({ unit, battlefield }) => {
            assert.equal(battlefield.getUnit(unit.id).vitality.hp, unit.vitality.hp);
            return [modifier.create({ finalScaler: unit.vitality.hp / 100 })];
        })],
    });
    const h = harness({ speed: 0.5 });
    h.work = install(h.work, program, resources);
    const fullHp = h.unit;
    h.work = updateCombatUnit(h.work, { ...fullHp, vitality: { ...fullHp.vitality, hp: 50 } });
    h.battlefield.apply([{ type: "REGISTER_UNIT", unit: h.unit }]);
    const moved = advanceMovement({
        battlefield: h.battlefield.view, tick: 0, execution: h.execution,
    }, { routeMoveMultiplier: 0.5 }, resources);
    h.battlefield.apply(moved.changes);
    close(h.battlefield.getUnit(0).position[0], 0.125);
    assert.equal(h.battlefield.getUnit(0).definition.locomotion.moveSpeedPerTick, 0.5);
    assert.equal(fullHp.vitality.hp, 100);
});

test("move speed: acceleration still follows the low-cost corridor and cannot cross unreachable barriers", () => {
    const resources = new CombatResources();
    const program = register(resources, modifier.create({ multiplier: 1 }));
    function maps(rows, expensive, blocked = []) {
        const cells = Array.from({ length: rows * 8 }, (_, index) => ({
            passable: !blocked.includes(index), moveCost: expensive.includes(index) ? 1000 : 1,
            departures: { UP: true, RIGHT: true, DOWN: true, LEFT: true },
        }));
        return {
            WALK: createNavigationMap({ rows, columns: 8, pathMotionMode: "WALK", revision: 0, cells }),
            FLY: createNavigationMap({ rows, columns: 8, pathMotionMode: "FLY", revision: 0, cells: cells.map((cell) => ({ ...cell, moveCost: 1 })) }),
        };
    }
    const navigation = maps(3, [10, 11, 12, 13]);
    const h = harness({ speed: 0.3, maps: navigation, definition: route({ startPosition: [1, 0], endPosition: [1, 7] }) });
    h.work = install(h.work, program, resources);
    const visited = [];
    for (let tick = 0; tick < 60 && h.unit.locomotion.mainRoute.route.progress.phase !== "COMPLETED"; tick++) {
        if (tick === 4) { h.work = setEffectEnabled(h.work, address, false, resources, tick); }
        const previous = h.unit.position;
        h.step(resources, tick);
        assert.ok(canTraverseNavigationSegment(navigation.WALK, previous, h.unit.position));
        visited.push(h.unit.position);
    }
    assert.equal(h.unit.locomotion.mainRoute.route.progress.phase, "COMPLETED");
    assert.ok(visited.some((position) => Math.abs(position[1] - 1) > 0.5));
    const unreachable = harness({ speed: 10, maps: maps(1, [], [3]) });
    unreachable.work = install(unreachable.work, program, resources);
    for (let tick = 0; tick < 3; tick++) {
        unreachable.step(resources, tick);
        assert.deepEqual(unreachable.unit.position, [0, 0]);
        assert.equal(unreachable.unit.locomotion.mainRoute.navigation.execution.activity.type, "UNREACHABLE");
    }
});

test("move speed: the native Mire modifier slows actual movement and expiry restores it", () => {
    const raw = fixture("buff_mire_attr");
    const skill = fixture("skill_sktok_mire").levels[0];
    const description = raw.node._buff.attributes.attributeModifiers.find((entry) => entry.attributeType === "MOVE_SPEED");
    assert.equal(description.formulaItem, "MULTIPLIER");
    assert.equal(description.loadFromBlackboard, true);
    assert.equal(description.fetchBaseValueFromSourceEntity, false);
    assert.equal(raw.node._stackCnt, 1);
    const ratio = skill.blackboard.find((entry) => entry.key === "move_speed").value;
    assert.equal(ratio, -0.05);
    const resources = new CombatResources();
    const program = register(resources, modifier.create({ multiplier: ratio }));
    const h = harness({ speed: 0.2 });
    h.work = install(h.work, program, resources, 2);
    const initial = h.unit;
    const future = { definition: initial.definition, tick: 50, route: route(),
        timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true, notCountInTotal: false };
    const spec = {
        ...createLegacyCombatSpec({ rows: 1, columns: 8, operators: [], enemies: [], maxTicks: 4, seed: 17 }),
        initialUnits: [{ definition: initial.definition, position: initial.position, states: {
            locomotion: initial.locomotion, spatialPresence: initial.spatialPresence, effects: initial.effects,
        } }],
        schedule: { type: "TIMELINE", spawns: [future] },
    };
    const runtime = new BattleRuntime(spec, { combat: resources });
    const reference = new BattleRuntime(spec, { combat: resources });
    const before = runtime.snapshot();
    const positions = [];
    for (let tick = 0; tick < 4; tick++) {
        assert.deepEqual(runtime.step(), reference.step());
        positions.push(runtime.snapshot().units[0].position[0]);
    }
    positions.forEach((position, index) => close(position, [0.19, 0.38, 0.58, 0.78][index]));
    assert.deepEqual(runtime.snapshot(), reference.snapshot());
    assert.deepEqual(before.units[0].position, [0, 0]);
    assert.equal(runtime.snapshot().units[0].locomotion.moveSpeed.entries.length, 0);
    assert.equal(runtime.snapshot().execution.rngState, before.execution.rngState);
});
