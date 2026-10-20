import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureBattle } from "../helpers/unit.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import { getUnit, registerUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { Map } from "../../dist/core/tactical/battlefield/navigation/map.js";
import * as navigation from "../../dist/core/tactical/battlefield/navigation/state.js";
import * as locomotion from "../../dist/core/tactical/unit/capability/locomotion/operations.js";

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≈ ${expected}`);
const cell = extra => ({ passable: true, cost: 1, departures: { UP: true, RIGHT: true, DOWN: true, LEFT: true }, ...extra });
const context = { mode: "WALK", speedMultiplier: 1 };
const ref = { id: 1 };
const target = { nextPoint: [6, 2], goal: [6, 2] };

function fixture({ position = [2, 2], velocity = [0, 0], definition = {}, cells } = {}) {
    let battle = fixtureBattle();
    const base = cells ?? Array.from({ length: 64 }, () => cell());
    battle = { ...battle, battlefield: { ...battle.battlefield, navigation: navigation.create({
        WALK: new Map(8, 8, base),
        FLY: new Map(8, 8, base.map(entry => ({ ...entry, cost: 1 }))),
    }) } };
    const initialized = initialize(battle, {
        id: 1, position,
        definition: { id: "movement", spatialPresence: {}, locomotion: {
            speed: 0.2, minSpeed: 0, halfBodyWidth: 0.2,
            steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 }, ...definition,
        } },
    });
    const self = { ...initialized.value, locomotion: { ...initialized.value.locomotion, velocity } };
    return registerUnit(initialized.state, self);
}

test("Locomotion integrates the saved velocity with acceleration and speed limits", () => {
    const battle = fixture({ velocity: [0, 0.1], definition: {
        steeringParameters: { steeringFactor: 0.5, maxSteeringForce: 0.1 },
    } });
    const next = locomotion.advance(battle, ref, target, context);
    const self = getUnit(next, 1);
    const scale = 0.1 / Math.hypot(0.1, -0.05);
    near(self.locomotion.velocity[0], 0.1 * scale);
    near(self.locomotion.velocity[1], 0.1 - 0.05 * scale);
    near(self.position[0], 2 + self.locomotion.velocity[0]);
    near(self.position[1], 2 + self.locomotion.velocity[1]);
    assert.deepEqual(getUnit(battle, 1).position, [2, 2]);
    assert.deepEqual(Object.keys(self.locomotion).sort(), ["rules", "speed", "velocity"]);
});

test("Locomotion predicts arrival at goal, preserves velocity, and does not snap to an intermediate point", () => {
    const battle = fixture({ velocity: [0, 0.1] });
    const original = getUnit(battle, 1);
    const arrived = getUnit(locomotion.advance(battle, ref, {
        nextPoint: [1, 2], goal: [2.1, 2],
    }, context), 1);
    assert.deepEqual(arrived.position, [2.1, 2]);
    assert.equal(arrived.locomotion, original.locomotion);
    const passed = getUnit(locomotion.advance(battle, ref, {
        nextPoint: [2.05, 2], goal: [6, 2],
    }, context), 1);
    near(passed.position[0], 2.2);
    near(passed.position[1], 2);
    assert.deepEqual(passed.locomotion.velocity, [0.2, 0]);
});

test("Locomotion preserves velocity and state identity when permission or effective speed prevents movement", () => {
    const battle = fixture({ velocity: [0.1, -0.1] });
    const self = getUnit(battle, 1);
    const denied = updateUnit(battle, { ...self, locomotion: locomotion.setRule(self.locomotion, {
        id: "immobile", allows: () => false,
    }) });
    assert.equal(locomotion.advance(denied, ref, target, context), denied);
    assert.equal(locomotion.advance(battle, ref, target, { ...context, speedMultiplier: 0 }), battle);
    const hidden = updateUnit(battle, { ...self, spatialPresence: { present: false } });
    assert.equal(locomotion.advance(hidden, ref, target, context), hidden);
    const stopped = fixture({ velocity: [0.1, 0], definition: { speed: 0 } });
    assert.equal(locomotion.advance(stopped, ref, target, context), stopped);
    assert.equal(locomotion.advance(battle, { id: 99 }, target, context), battle);
});

test("Locomotion reflects about the destination-cell center while retaining controller velocity", () => {
    const cells = Array.from({ length: 64 }, () => cell());
    cells[2 * 8 + 3] = cell({ passable: false });
    const battle = fixture({ cells, position: [2.4, 2], velocity: [0.3, 0.1], definition: {
        speed: 0.5, steeringParameters: { steeringFactor: 1, maxSteeringForce: 0 },
    } });
    const self = getUnit(locomotion.advance(battle, ref, target, context), 1);
    near(self.position[0], 2.1);
    near(self.position[1], 2.1);
    assert.equal(self.locomotion, getUnit(battle, 1).locomotion);
});

test("Locomotion checks only a changed destination cell, without sweeping or rechecking a reflection", () => {
    const cells = Array.from({ length: 64 }, () => cell());
    cells[2 * 8 + 3] = cell({ passable: false });
    const fast = fixture({ cells, velocity: [2, 0], definition: {
        speed: 2, steeringParameters: { steeringFactor: 1, maxSteeringForce: 0 },
    } });
    assert.deepEqual(getUnit(locomotion.advance(fast, ref, target, context), 1).position, [4, 2]);
    cells[2 * 8 + 1] = cell({ passable: false });
    const reflected = fixture({ cells, velocity: [1, 0], definition: {
        speed: 1, steeringParameters: { steeringFactor: 1, maxSteeringForce: 0 },
    } });
    assert.deepEqual(getUnit(locomotion.advance(reflected, ref, target, context), 1).position, [1, 2]);
});

test("Locomotion reads the effective map each integration and uses WALK or FLY avoidance", () => {
    const initial = fixture({ position: [2, 2.4], velocity: [0.2, 0] });
    const straight = { nextPoint: [6, 2.4], goal: [6, 2.4] };
    const overlay = { id: 0, cells: [[3, 2]], denyPassage: false, denyDepartures: [], cost: 1000 };
    const battle = { ...initial, battlefield: { ...initial.battlefield,
        navigation: navigation.setOverlay(initial.battlefield.navigation, "WALK", overlay),
    } };
    const walking = getUnit(locomotion.advance(battle, ref, straight, context), 1);
    const flying = getUnit(locomotion.advance(battle, ref, straight, { ...context, mode: "FLY" }), 1);
    assert.ok(walking.position[1] < 2.4);
    assert.equal(flying.position[1], 2.4);
    assert.equal(getUnit(locomotion.advance(initial, ref, straight, context), 1).position[1], 2.4);
    assert.ok(walking.locomotion.velocity[1] < 0);
});

test("Locomotion initialization validates static numbers and permits zero-width and zero-speed definitions", () => {
    for (const [key, value] of [["speed", -1], ["minSpeed", NaN], ["halfBodyWidth", -0.1]]) {
        assert.throws(() => fixture({ definition: { [key]: value } }), RangeError);
    }
    const unit = getUnit(fixture({ definition: { speed: 0, minSpeed: 0, halfBodyWidth: 0 } }), 1);
    assert.deepEqual(unit.locomotion.velocity, [0, 0]);
});
