import assert from "node:assert/strict";
import { test } from "node:test";
import { getUnit, removeUnit } from "../../dist/core/tactical/battle/state.js";
import { advanceMovement } from "../../dist/core/tactical/battle/steps/movement.js";
import * as blocking from "../../dist/core/tactical/battle/blocking/operations.js";
import * as locomotion from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import * as presence from "../../dist/core/tactical/unit/capability/presence/operations.js";
import { fixture, holder, target, change, acquire, ownerId, blockedIds } from "../helpers/blocking.js";

const route = (checkpoints = []) => ({
    pathMotionMode: "WALK", startPosition: [1, 2], endPosition: [1, 10], offset: [0, 0],
    checkpoints, requireAllCheckpoints: true, alwaysCheckCurrentPoint: true,
});
const mover = (id = 20, { rules = [], checkpoints = [], volume = 1 } = {}) => {
    const unit = target(id, {
        volume,
        definition: {
            route: route(checkpoints),
            locomotion: {
                speed: 0.125, minSpeed: 0, halfBodyWidth: 0,
                steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
            },
        },
    });
    return { ...unit, locomotion: { ...unit.locomotion, rules, velocity: [0.0625, 0] } };
};
const step = battle => advanceMovement(battle, { routeMoveMultiplier: 1 });
function assertMoves(battle, id = 20) {
    const before = getUnit(battle, id);
    const after = getUnit(step(battle), id);
    assert.ok(after.position[0] > before.position[0]);
    assert.deepEqual(getUnit(battle, id).position, before.position);
}
function assertStopped(battle, id = 20) {
    const before = getUnit(battle, id);
    const after = getUnit(step(battle), id);
    assert.deepEqual(after.position, before.position);
    assert.equal(after.locomotion.velocity, before.locomotion.velocity);
}

test("Runtime gates blocked autonomous movement without installing Locomotion rules", () => {
    const original = mover();
    const battle = acquire(fixture([holder(), original]));
    assert.deepEqual(getUnit(battle, 20).locomotion.rules, []);
    assert.equal(getUnit(battle, 20).locomotion, original.locomotion);
    assert.deepEqual(blockedIds(battle), [20]);
    assertStopped(battle);
    assert.deepEqual(original.locomotion.velocity, [0.0625, 0]);
});

test("release restores autonomous movement and preserves the controller velocity", () => {
    const blocked = acquire(fixture([holder(), mover()]));
    const velocity = getUnit(blocked, 20).locomotion.velocity;
    const released = blocking.release(blocked, { id: 20 });
    assert.equal(ownerId(released), undefined);
    assert.equal(getUnit(released, 20).locomotion.velocity, velocity);
    assertMoves(released);
    assertStopped(blocked);
});

test("removing a blocker releases movement until a later blocker search", () => {
    let battle = acquire(fixture([holder(), holder(11, { position: [3, 1] }), mover()]));
    battle = removeUnit(battle, 10, "RETREAT");
    assert.equal(ownerId(battle), undefined);
    assertMoves(battle);
    battle = acquire(battle, 11);
    assert.equal(ownerId(battle), 11);
    assertStopped(battle);
});

test("blocking does not change independently registered Locomotion rules", () => {
    const casting = { id: "casting", allows: () => false };
    const allowed = { id: "permission", allows: () => true };
    let battle = acquire(fixture([holder(), mover(20, { rules: [casting, allowed] })]));
    const rules = getUnit(battle, 20).locomotion.rules;
    assert.deepEqual(rules, [casting, allowed]);
    battle = blocking.release(battle, { id: 20 });
    assert.equal(getUnit(battle, 20).locomotion.rules, rules);
    assertStopped(battle);
    battle = change(battle, 20, unit => ({
        ...unit, locomotion: locomotion.removeRule(unit.locomotion, casting.id),
    }));
    assert.deepEqual(getUnit(battle, 20).locomotion.rules, [allowed]);
    assertMoves(battle);
});

test("Route wait timers continue while blocking prevents position integration", () => {
    let battle = acquire(fixture([holder(), mover(20, { checkpoints: [{ type: "WAIT", tick: 2 }] })]));
    const position = getUnit(battle, 20).position;
    battle = step(battle);
    assert.deepEqual(getUnit(battle, 20).route.main.phase, {
        type: "CHECKPOINT", index: 0,
        checkpointState: { type: "WAITING", deadlineTick: 2 },
    });
    battle = step({ ...battle, tick: 1 });
    assert.equal(getUnit(battle, 20).route.main.phase.checkpointState.deadlineTick, 2);
    battle = step({ ...battle, tick: 2 });
    assert.equal(getUnit(battle, 20).route.main.phase.type, "END");
    assert.deepEqual(getUnit(battle, 20).position, position);
    assert.deepEqual(getUnit(battle, 20).locomotion.velocity, [0.0625, 0]);
});

test("Route spatial instructions execute while blocked and release the old relation", () => {
    let battle = acquire(fixture([holder(), mover(20, { checkpoints: [{ type: "DISAPPEAR" }] })]));
    battle = step(battle);
    assert.equal(getUnit(battle, 20).spatialPresence.present, false);
    assert.equal(ownerId(battle), undefined);
    assert.deepEqual(blockedIds(battle), []);
});

test("appearance does not reacquire and disappearance releases immediately", () => {
    let battle = acquire(fixture([holder(), mover()]));
    battle = presence.disappear(battle, { id: 10 });
    assert.equal(ownerId(battle), undefined);
    assertMoves(battle);
    battle = presence.appear(battle, { id: 10 }, [2, 1]);
    assert.equal(ownerId(battle), undefined);
    battle = acquire(battle);
    assertStopped(battle);
    battle = presence.disappear(battle, { id: 20 });
    assert.equal(ownerId(battle), undefined);
    assert.deepEqual(blockedIds(battle), []);
});
