import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fixtureBattle } from "../helpers/unit.js";
import { contributionEffect, refreshContribution } from "../helpers/effects.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { setData } from "../../dist/core/tactical/unit/effect/effect.js";
import {
    battlefieldView,
    getUnit,
    registerUnit,
    updateUnit,
} from "../../dist/core/tactical/battle/state.js";
import {
    setMoveSpeedContribution,
    removeMoveSpeedContribution,
    setRule,
    removeRule,
    resolveMoveSpeed,
} from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import { advance } from "../../dist/core/tactical/unit/capability/locomotion/step.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { copy } from "../../dist/core/tactical/unit/snapshot.js";
import * as modifier from "../../dist/core/tactical/unit/contribution/attribute.js";

const address = { host: { id: 0 }, id: 0 };
const close = (actual, expected) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

function harness({ speed = 0.25, minimum = 0, steeringParameters } = {}) {
    const initialized = initialize(fixtureBattle(0, { rngState: 17 }), {
        id: 0,
        position: [0, 0],
        definition: {
            id: "dynamic-mover",
            vitality: { maxHp: 100, defense: 0, resistance: 0 },
            spatialPresence: {},
            locomotion: {
                moveSpeedPerTick: speed,
                minimumMoveSpeedPerTick: minimum,
                steeringParameters: steeringParameters ?? {
                    steeringFactor: 1,
                    maxSteeringForce: 100,
                },
            },
        },
    });
    let work = registerUnit(initialized.state, initialized.value);
    return {
        get work() { return work; },
        set work(next) { work = next; },
        get unit() { return getUnit(work, 0); },
        step(tick, target = [20, 0], multiplier = 1) {
            work = advance({ ...work, tick }, unitRef(getUnit(work, 0)), target, multiplier);
            return getUnit(work, 0);
        },
    };
}

const output = {
    capability: "locomotion", set: setMoveSpeedContribution,
    remove: removeMoveSpeedContribution,
    value: (instance) => [instance.data.value],
};
function movementEffect(value = modifier.create({ multiplier: -0.5 })) {
    return contributionEffect("movement-buff", { value }, output);
}
const install = (work, program, expiresAtTick = null) =>
    effects.install(work, unitRef(getUnit(work, 0)), program, {
        scopes: expiresAtTick === null ? [] : [{ type: "TICK", tick: expiresAtTick }],
    });
const changeSpeed = (work, program, next) => {
    work = effects.replaceEffect(work, address, setData(effects.get(work, address), next));
    return refreshContribution(work, address, program, output);
};
function speed(work) {
    const unit = getUnit(work, 0);
    return resolveMoveSpeed(unit.definition.locomotion, unit.locomotion, {
        unit,
        battlefield: battlefieldView(work),
    });
}

test("move speed: minimum, arithmetic and movement permission are separate", () => {
    const h = harness({ speed: 1 / 30, minimum: 0.1 / 30 });
    const program = movementEffect(modifier.create({ multiplier: -2 }));
    h.work = install(h.work, program).state;
    close(speed(h.work), 0.1 / 30);
    assert.deepEqual(h.step(0, [20, 0], 0).position, [0, 0]);
    h.work = updateUnit(h.work, {
        ...h.unit,
        locomotion: setRule(h.unit.locomotion, { id: "stop", allows: () => false }),
    });
    assert.deepEqual(h.step(1).position, [0, 0]);
    h.work = updateUnit(h.work, {
        ...h.unit, locomotion: removeRule(h.unit.locomotion, "stop"),
    });
    close(h.step(2, [20, 0], 0.5).position[0], 0.1 / 60);
    h.work = changeSpeed(h.work, program, state => ({
        ...state,
        value: modifier.create({
            addition: 1 / 30, multiplier: 0.5,
            finalAddition: 1 / 30, finalScaler: 2,
        }),
    }));
    close(speed(h.work), 8 / 30);
});

test("move speed: effect lifecycle preserves shared immutable snapshots", () => {
    const program = movementEffect();
    const h = harness();
    const before = h.unit;
    const copied = copy(before);
    assert.equal(copied.locomotion, before.locomotion);
    h.work = install(h.work, program).state;
    close(speed(h.work), 0.125);
    h.work = effects.setEnabled(h.work, address, false);
    close(speed(h.work), 0.25);
    h.work = effects.setEnabled(h.work, address, true);
    const participating = copy(h.unit);
    h.work = effects.end(h.work, address);
    assert.equal(h.unit.locomotion.moveSpeed.length, 0);
    assert.equal(copied.locomotion.moveSpeed.length, 0);
    assert.equal(participating.locomotion.moveSpeed.length, 1);
    assert.equal(h.work.execution.rngState, 17);
});

test("move speed: acceleration, zero budget and restoration use current contributions", () => {
    const program = movementEffect();
    const h = harness();
    close(h.step(0).position[0], 0.25);
    h.work = install(h.work, program).state;
    close(h.step(1).position[0], 0.375);
    h.work = changeSpeed(h.work, program, state => ({
        ...state, value: modifier.create({ multiplier: 1 }),
    }));
    close(h.step(2).position[0], 0.875);
    h.work = changeSpeed(h.work, program, state => ({
        ...state, value: modifier.create({ multiplier: -1 }),
    }));
    close(h.step(3).position[0], 0.875);
    h.work = effects.setEnabled(h.work, address, false);
    close(h.step(4).position[0], 1.125);
    assert.equal(h.work.execution.rngState, 17);
});

test("move speed: live contributions read latest battle and unit facts", () => {
    const program = contributionEffect("live-move", {}, {
        capability: "locomotion", set: setMoveSpeedContribution,
        remove: removeMoveSpeedContribution, dynamic: true,
        value: (_, { unit, battlefield }) => {
            assert.equal(battlefield.getUnit(unit.id).vitality.hp, unit.vitality.hp);
            return [modifier.create({ finalScaler: unit.vitality.hp / 100 })];
        },
    });
    const h = harness({ speed: 0.5 });
    h.work = install(h.work, program).state;
    const fullHp = h.unit;
    h.work = updateUnit(h.work, {
        ...fullHp, vitality: { ...fullHp.vitality, hp: 50 },
    });
    close(h.step(0, [20, 0], 0.5).position[0], 0.125);
    assert.equal(h.unit.definition.locomotion.moveSpeedPerTick, 0.5);
    assert.equal(fullHp.vitality.hp, 100);
});

test("locomotion: one target consumes at most one movement budget without overshoot", () => {
    const h = harness({ speed: 10 });
    assert.deepEqual(h.step(0, [0.2, 0]).position, [0.2, 0]);
    assert.equal(h.unit.locomotion.moving, true);
    assert.deepEqual(h.step(1, [0.2, 0]).position, [0.2, 0]);
    assert.equal(h.unit.locomotion.moving, false);
    const far = harness({ speed: 0.25 });
    close(far.step(0, [20, 0]).position[0], 0.25);
    close(far.step(1, [20, 0]).position[0], 0.5);
    assert.equal("route" in far.unit, false);
    assert.equal("mainRoute" in far.unit.locomotion, false);
});

test("locomotion: null tracking target stops inertia without drifting", () => {
    const h = harness({
        speed: 0.5,
        steeringParameters: { steeringFactor: 0.2, maxSteeringForce: 0.1 },
    });
    close(h.step(0).position[0], 0.1);
    const position = h.unit.position;
    assert.equal(h.step(1, null).position, position);
    assert.equal(h.unit.locomotion.moving, false);
    assert.deepEqual(h.unit.locomotion.steering.lastVelocity, [0, 0]);
    assert.equal(advance(h.work, unitRef(h.unit), null), h.work);
});

test("locomotion: lifecycle, presence and blocking gate movement", () => {
    const h = harness();
    h.work = updateUnit(h.work, { ...h.unit, spatialPresence: { present: false } });
    assert.deepEqual(h.step(0).position, [0, 0]);
    h.work = updateUnit(h.work, { ...h.unit, spatialPresence: { present: true } });
    h.work = {
        ...h.work,
        battlefield: {
            ...h.work.battlefield,
            blockingRelations: [{ blockerUnitId: 1, blockedUnitId: 0 }],
        },
    };
    assert.deepEqual(h.step(1).position, [0, 0]);
    h.work = updateUnit(h.work, { ...h.unit, lifecycle: "LEAVING" });
    assert.equal(advance(h.work, unitRef(h.unit), [20, 0]), h.work);
    assert.equal(advance(h.work, { id: 99 }, [20, 0]), h.work);
});

test("move speed: native Mire modifier slows movement and expiry restores it", () => {
    const fixture = name => JSON.parse(readFileSync(
        new URL(`../fixtures/arknights/${name}.json`, import.meta.url), "utf8",
    ));
    const raw = fixture("buff_mire_attr");
    const skill = fixture("skill_sktok_mire").levels[0];
    const description = raw.node._buff.attributes.attributeModifiers.find(
        entry => entry.attributeType === "MOVE_SPEED",
    );
    assert.equal(description.formulaItem, "MULTIPLIER");
    const ratio = skill.blackboard.find(entry => entry.key === "move_speed").value;
    assert.equal(ratio, -0.05);
    const h = harness({ speed: 0.2 });
    h.work = install(h.work, movementEffect(modifier.create({ multiplier: ratio })), 2).state;
    const positions = [];
    for (let tick = 0; tick < 4; tick++) {
        h.work = effects.advance({ ...h.work, tick });
        positions.push(h.step(tick).position[0]);
    }
    positions.forEach((position, index) => close(position, [0.19, 0.38, 0.58, 0.78][index]));
    assert.equal(h.unit.locomotion.moveSpeed.length, 0);
    assert.equal(h.work.execution.rngState, 17);
});
