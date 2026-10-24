import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import {
    createBattleState, getUnit, registerUnit, removeUnit, updateUnit,
} from "../../dist/core/tactical/battle/state.js";
import { advance } from "../../dist/core/tactical/battle/execution/unit.js";
import { initialize } from "../helpers/unit.js";
import { createInput as createRouteDefinition } from "../../dist/core/tactical/battle/creation/route.js";
import { install } from "../../dist/core/tactical/unit/effect/operations.js";
import { fixtureBattlefieldState } from "../helpers/battlefield.js";
import { map, unit as combatUnit } from "../helpers/action-fixture.js";

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

function unit(id, definition = {}) {
    return {
        ...initialize({ id, position: [id, 0], definition: {
            id: `tick-unit-${id}`, vitality: { maxHp: 100, defense: 0, resistance: 0 }, ...definition,
        } }),
        state: { phase: 0 },
    };
}

function runtime(definitions, spawns = []) {
    return new BattleRuntime({
        map,
        schedule: { type: "TIMELINE", spawns: [
            ...spawns,
            spawn({ spatialPresence: {}, id: "later", vitality: { maxHp: 100, defense: 0, resistance: 0 }, locomotion }, 100),
        ] },
        initialUnits: definitions.map((definition, id) => ({ definition, position: [id, 0] })),
        predefines: [], initialMechanisms: [], maxTicks: 10, routeMoveMultiplier: 1, rngState: 123,
    });
}

test("Unit ticks pass the latest returned battle and preserve previous private state", () => {
    const trace = [];
    const first = unit(0, { onTick(state, self) {
        assert.strictEqual(self, getUnit(state, self.id));
        state = updateUnit(state, { ...self, state: { phase: self.state.phase + 1 } });
        const other = getUnit(state, 1);
        return updateUnit(state, { ...other, state: { phase: 7 } });
    } });
    const second = unit(1, { onTick(state, self) {
        assert.strictEqual(self, getUnit(state, self.id));
        trace.push([self.id, self.state.phase, getUnit(state, 0).state.phase]);
        return updateUnit(state, { ...self, state: { phase: self.state.phase + 1 } });
    } });
    const before = createBattleState(fixtureBattlefieldState([first, second]));
    const after = advance(before);

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
    const created = unit(3, { onTick(state, self) { trace.push(self.id); return state; } });
    const first = unit(0, { onTick(state, self) {
        trace.push(self.id);
        if (getUnit(state, 1) === undefined) return state;
        state = removeUnit(state, 1, "SCRIPT");
        state = updateUnit(state, { ...getUnit(state, 2), lifecycle: "LEAVING" });
        return registerUnit(state, created);
    } });
    const removed = unit(1, { onTick() { assert.fail("removed Unit tick"); } });
    const departing = unit(2, { onTick() { assert.fail("newly departing Unit tick"); } });
    const leaving = { ...unit(4, { onTick() { assert.fail("departing Unit tick"); } }), lifecycle: "LEAVING" };
    let state = createBattleState(fixtureBattlefieldState([first, removed, departing, leaving, unit(5)]));

    state = advance(state);
    assert.deepEqual(trace, [0]);
    assert.equal(getUnit(state, 3), created);
    state = advance({ ...state, tick: 1 });
    assert.deepEqual(trace, [0, 0, 3]);
});

test("Runtime advances Unit content once per Tick before Effect callbacks", () => {
    const trace = [];
    let original;
    const observer = { id: "phase-observer", initialize: () => ({}), onTick(state, self) {
        trace.push(["effect", state.tick, getUnit(state, self.host.id).state.phase]);
        return state;
    } };
    const battle = runtime([{
        id: "boss", vitality: { maxHp: 100, defense: 0, resistance: 0 },
        onEnter(state, id) {
            state = updateUnit(state, { ...getUnit(state, id), state: { phase: 0 } });
            original = getUnit(state, id);
            return install(state, unitRef(original), observer).state;
        },
        onTick(state, self) {
            assert.strictEqual(self, getUnit(state, self.id));
            const phase = self.state.phase + 1;
            trace.push(["unit", state.tick, phase]);
            return updateUnit(state, {
                ...self, state: { phase },
                vitality: { ...self.vitality, hp: self.vitality.hp - 5 },
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

test("Scheduled Units tick after entering without mandatory combat or movement capabilities", () => {
    const trace = [];
    const definition = {
        id: "scripted-spawn",
        onEnter(state, id) { trace.push(["enter", state.tick, id]); return state; },
        onTick(state, self) { trace.push(["tick", state.tick, self.id]); return state; },
    };
    const battle = runtime([], [spawn(definition, 0)]);
    battle.step();
    battle.step();

    assert.deepEqual(trace, [["enter", 0, 0], ["tick", 0, 0], ["tick", 1, 0]]);
    const [spawned] = battle.snapshot().units;
    assert.equal(spawned.definition.onEnter, definition.onEnter);
    assert.equal(spawned.definition.onTick, definition.onTick);
    assert.equal("vitality" in spawned, false);
    assert.equal("locomotion" in spawned, false);
    assert.equal("spatialPresence" in spawned, false);
});

test("Unit initialization preserves tick callbacks across independent capability combinations", () => {
    const trace = [];
    const onTick = (state, self) => {
        trace.push(self.id);
        return state;
    };
    const base = combatUnit(0, { action: true }).definition;
    const definitions = [
        { ...base, onTick, blocker: { capacity: 1, geometry: { radius: 0.5 } } },
        { spatialPresence: {}, ...base, onTick, locomotion, blockable: { volume: 1 } },
        { id: "scripted", onTick },
    ];
    const units = definitions.map((definition, id) => initialize({ id, position: [id, 0], definition }));
    const before = createBattleState(fixtureBattlefieldState(units));

    assert.equal(advance(before), before);
    assert.deepEqual(trace, [0, 1, 2]);
    for (const [id, definition] of definitions.entries()) {
        assert.equal(getUnit(before, id).definition, definition);
    }
});

test("Unit tick errors propagate without publishing an incomplete Tick", () => {
    const failure = new Error("boss phase failed");
    const battle = runtime([
        { id: "first", vitality: { maxHp: 100, defense: 0, resistance: 0 }, onTick(state, self) {
            return updateUnit(state, { ...self, vitality: { ...self.vitality, hp: 50 } });
        } },
        { id: "failed", onTick() { throw failure; } },
    ]);
    const before = battle.snapshot();

    assert.throws(() => battle.step(), error => error === failure);
    assert.deepEqual(battle.snapshot(), before);
});
