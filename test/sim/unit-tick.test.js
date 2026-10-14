import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import {
    createBattleState, getUnit, registerUnit, removeUnit, updateUnit,
} from "../../dist/core/tactical/battle/state.js";
import { advanceUnits } from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import {
    createDefinition as createEnemy, createCombatDefinition,
} from "../../dist/core/tactical/unit/archetype/enemy.js";
import { createDefinition as createOperator } from "../../dist/core/tactical/unit/archetype/operator.js";
import { createRouteDefinition } from "../../dist/core/tactical/unit/capability/locomotion/route/definition.js";
import { install } from "../../dist/core/tactical/unit/effect/operations.js";
import { fixtureBattlefieldState } from "../helpers/battlefield.js";
import { map, unit as combatUnit } from "../helpers/action-fixture.js";

const locomotion = {
    moveSpeedPerTick: 0,
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

function unit(id, definition = {}) {
    return {
        ...initialize({ id, position: [id, 0], definition: {
            id: `tick-unit-${id}`, vitality: { maxHp: 100 }, ...definition,
        } }),
        state: { phase: 0 },
    };
}

function runtime(definitions, spawns = []) {
    return new BattleRuntime({
        map,
        schedule: { type: "TIMELINE", spawns: [
            ...spawns,
            spawn(createEnemy({ id: "later", vitality: { maxHp: 100 }, locomotion }), 100),
        ] },
        initialUnits: definitions.map((definition, id) => ({ definition, position: [id, 0] })),
        predefines: [], initialMechanisms: [], initialNavigationModifiers: [],
        maxTicks: 10, routeMoveMultiplier: 1, rngState: 123,
    });
}

test("Unit ticks pass the latest returned battle and preserve previous private state", () => {
    const trace = [];
    const first = unit(0, { onTick(state, id) {
        const current = getUnit(state, id);
        state = updateUnit(state, { ...current, state: { phase: current.state.phase + 1 } });
        const other = getUnit(state, 1);
        return updateUnit(state, { ...other, state: { phase: 7 } });
    } });
    const second = unit(1, { onTick(state, id) {
        const current = getUnit(state, id);
        trace.push([id, current.state.phase, getUnit(state, 0).state.phase]);
        return updateUnit(state, { ...current, state: { phase: current.state.phase + 1 } });
    } });
    const before = createBattleState(fixtureBattlefieldState([first, second]));
    const after = advanceUnits(before);

    assert.deepEqual(trace, [[1, 7, 1]]);
    assert.equal(getUnit(after, 0).state.phase, 1);
    assert.equal(getUnit(after, 1).state.phase, 8);
    assert.equal(getUnit(before, 0), first);
    assert.equal(getUnit(before, 1), second);
    assert.deepEqual(first.state, { phase: 0 });
    assert.deepEqual(second.state, { phase: 0 });
});

test("Unit ticks skip departing or removed units and defer units created by a tick callback", () => {
    const trace = [];
    const created = unit(3, { onTick(state, id) { trace.push(id); return state; } });
    const first = unit(0, { onTick(state, id) {
        trace.push(id);
        if (getUnit(state, 1) === undefined) return state;
        state = removeUnit(state, 1, "SCRIPT");
        return registerUnit(state, created);
    } });
    const removed = unit(1, { onTick() { assert.fail("removed Unit tick"); } });
    const leaving = { ...unit(2, { onTick() { assert.fail("departing Unit tick"); } }), lifecycle: "LEAVING" };
    let state = createBattleState(fixtureBattlefieldState([first, removed, leaving]));

    state = advanceUnits(state);
    assert.deepEqual(trace, [0]);
    assert.equal(getUnit(state, 3), created);
    state = advanceUnits({ ...state, tick: 1 });
    assert.deepEqual(trace, [0, 0, 3]);
});

test("Runtime advances Unit content once per Tick before Effect callbacks", () => {
    const trace = [];
    let original;
    const observer = { id: "phase-observer", initialize: () => ({}), onTick(state, context) {
        trace.push(["effect", state.tick, getUnit(state, context.unit.id).state.phase]);
        return state;
    } };
    const battle = runtime([{
        id: "boss", vitality: { maxHp: 100 },
        onEnter(state, id) {
            state = updateUnit(state, { ...getUnit(state, id), state: { phase: 0 } });
            original = getUnit(state, id);
            return install(state, unitRef(original), observer).state;
        },
        onTick(state, id) {
            const current = getUnit(state, id);
            const phase = current.state.phase + 1;
            trace.push(["unit", state.tick, phase]);
            return updateUnit(state, {
                ...current, state: { phase },
                vitality: { ...current.vitality, hp: current.vitality.hp - 5 },
            });
        },
    }]);
    const before = battle.snapshot();
    battle.step();
    const first = battle.snapshot();
    battle.step();

    assert.deepEqual(trace, [["unit", 0, 1], ["effect", 0, 1], ["unit", 1, 2], ["effect", 1, 2]]);
    assert.equal(before.units[0].vitality.hp, 100);
    assert.equal(first.units[0].vitality.hp, 95);
    assert.equal(battle.snapshot().units[0].vitality.hp, 90);
    assert.deepEqual(original.state, { phase: 0 });
});

test("Factory-created enemies tick in their spawning Tick after entering", () => {
    const trace = [];
    const definition = createEnemy({
        id: "spawned", vitality: { maxHp: 100 }, locomotion,
        onEnter(state, id) { trace.push(["enter", state.tick, id]); return state; },
        onTick(state, id) { trace.push(["tick", state.tick, id]); return state; },
    });
    const battle = runtime([], [spawn(definition, 0)]);
    battle.step();
    battle.step();

    assert.deepEqual(trace, [["enter", 0, 0], ["tick", 0, 0], ["tick", 1, 0]]);
});

test("Operator and combat enemy definition factories retain the Unit tick callback", () => {
    const onTick = state => state;
    const base = combatUnit(0, { action: true }).definition;
    const operator = createOperator({ ...base, onTick, blocker: { capacity: 1, geometry: { radius: 0.5 } } });
    const enemy = createCombatDefinition({ ...base, onTick, locomotion, blockable: { weight: 1 } });

    assert.equal(operator.onTick, onTick);
    assert.equal(enemy.onTick, onTick);
});

test("Unit tick errors propagate without publishing an incomplete Tick", () => {
    const failure = new Error("boss phase failed");
    const battle = runtime([
        { id: "first", vitality: { maxHp: 100 }, onTick(state, id) {
            const current = getUnit(state, id);
            return updateUnit(state, { ...current, vitality: { ...current.vitality, hp: 50 } });
        } },
        { id: "failed", onTick() { throw failure; } },
    ]);
    const before = battle.snapshot();

    assert.throws(() => battle.step(), error => error === failure);
    assert.deepEqual(battle.snapshot(), before);
});
