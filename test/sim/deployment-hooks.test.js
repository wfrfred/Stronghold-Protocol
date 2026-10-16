import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { createBattleState, getUnit, transitionUnit } from "../../dist/core/tactical/battle/state.js";
import {
    notifyDeployed,
} from "../../dist/core/tactical/battle/deployment/deployment.js";
import { setHook, removeHook } from "../../dist/core/tactical/unit/capability/deployable/hook.js";
import { createDefinition as createDeployable } from "../../dist/core/tactical/unit/capability/deployable/capability.js";
import { removeUnitWithEffects } from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";

import { initialize } from "../helpers/unit.js";
import { createDefinition as createEnemy } from "../../dist/core/tactical/unit/archetype/enemy.js";
import { createRouteDefinition } from "../../dist/core/tactical/unit/capability/locomotion/route/definition.js";
import { install } from "../../dist/core/tactical/unit/effect/operations.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import { fixtureBattlefieldState } from "../helpers/battlefield.js";

const tile = createTile({
    heightType: "LOWLAND", buildableType: "ALL", passableMask: "ALL",
    playerSideMask: "ALL", terrain: "NORMAL", mechanism: null,
});
const map = createBattlefieldMap(1, 8, Array(8).fill(tile));
const profile = createDeployable({ cost: 0, redeployTicks: 0, slots: 1, buildableType: "ALL" });
const route = createRouteDefinition({
    pathMotionMode: "WALK", startPosition: [0, 7], endPosition: [0, 0],
    spawnOffset: [0, 0], spawnRandomRange: [0, 0],
    checkpoints: [{ type: "WAIT_FOR_TICKS", durationTicks: 1000 }],
    allowDiagonalMove: false, visitEveryTileCenter: false,
    visitEveryNodeCenter: false, visitEveryCheckPoint: true,
});
const enemy = (fields = {}) => createEnemy({
    id: "enemy", vitality: { maxHp: 100 }, locomotion: {
        moveSpeedPerTick: 0, minimumMoveSpeedPerTick: 0,
        steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
    }, ...fields,
});
const spawn = (definition, tick) => ({
    tick, definition, route, alwaysCheckCurrentPoint: true, notCountInTotal: false,
    timing: { waveStartedAtTick: tick, fragmentStartedAtTick: tick },
});
const definition = (id, fields = {}) => ({ id, vitality: { maxHp: 100 }, occupancy: {}, deployable: profile, ...fields });
const unit = (id, fields = {}) => initialize({ id, definition: definition(`unit:${id}`, fields), position: [id, 0] });
const deployment = (definitions) => ({
    definition: { initialDp: 0, maxDp: 99, dpRecoveryTicks: null, slotLimit: null },
    cards: definitions.map((unit) => ({ unit })),
});
const input = (fields = {}) => ({
    map, schedule: { type: "TIMELINE", spawns: [spawn(enemy(), 1000)] }, initialUnits: [], predefines: [],
    initialMechanisms: [], initialNavigationModifiers: [], maxTicks: 30, routeMoveMultiplier: 1,
    rngState: 1, ...fields,
});
const deploy = (cardId, column = 0) => ({
    type: "DEPLOY_UNIT", cardId, tilePosition: [0, column], playerSide: "SIDE_A",
});
const record = (id, invoke, accepts) => ({
    id, accepts, invoke(state, deployed) {
        return { state: invoke(state, deployed), value: undefined };
    },
});
const addHook = (state, unitId, entry) => transitionUnit(state, unitId, (unit) => ({
    ...unit, deployable: setHook(unit.deployable, entry),
}));
const deleteHook = (state, unitId, id) => transitionUnit(state, unitId, (unit) => ({
    ...unit, deployable: removeHook(unit.deployable, id),
}));

test("deployment observers consume preceding state and recheck registration and eligibility", () => {
    const deployed = unit(1);
    let state = createBattleState(fixtureBattlefieldState([unit(0), deployed]));
    const calls = [];
    state = addHook(state, 0, record("first", (state) => {
        calls.push("first");
        state = transitionUnit(state, 0, (unit) => ({ ...unit, vitality: { ...unit.vitality, hp: 70 } }));
        return deleteHook(state, 0, "removed");
    }));
    state = addHook(state, 0, record("removed", () => assert.fail("removed observer ran")));
    state = addHook(state, 0, record("enabled-after-first", (state, fact) => {
        calls.push("enabled-after-first");
        assert.equal(getUnit(state, 0).vitality.hp, 70);
        assert.equal(fact.unit, deployed);
        return state;
    }, (state) => getUnit(state, 0).vitality.hp === 70));
    const previous = state;
    const next = notifyDeployed(state, { unit: deployed, kind: "MANUAL" });
    assert.deepEqual(calls, ["first", "enabled-after-first"]);
    assert.equal(getUnit(next, 0).vitality.hp, 70);
    assert.equal(getUnit(previous, 0).vitality.hp, 100);
    assert.equal(getUnit(previous, 0).deployable.deployedHooks.length, 3);
});

test("new observers wait for the next notification; replacing an observer retains its position", () => {
    const deployed = unit(0);
    let state = createBattleState(fixtureBattlefieldState([deployed]));
    const calls = [];
    const late = record("late", (state) => { calls.push("late"); return state; });
    state = addHook(state, 0, record("first", (state) => {
        calls.push("first");
        return addHook(state, 0, late);
    }));
    state = addHook(state, 0, record("second", (state) => { calls.push("obsolete"); return state; }));
    state = addHook(state, 0, record("second", (state) => { calls.push("second"); return state; }));
    const fact = { unit: deployed, kind: "MANUAL" };
    state = notifyDeployed(state, fact);
    assert.deepEqual(calls, ["first", "second"]);
    notifyDeployed(state, fact);
    assert.deepEqual(calls, ["first", "second", "first", "second", "late"]);
});

test("a nested deployment notification returns its state before the outer observer continues", () => {
    const deployed = unit(0);
    let state = createBattleState(fixtureBattlefieldState([deployed]));
    const calls = [];
    state = addHook(state, 0, record("nested", (state, fact) => {
        calls.push(fact.kind);
        if (fact.kind === "MANUAL") {
            state = notifyDeployed(state, { unit: deployed, kind: "AUTOMATIC" });
            assert.equal(getUnit(state, 0).vitality.hp, 50);
            return state;
        }
        return transitionUnit(state, 0, (unit) => ({ ...unit, vitality: { ...unit.vitality, hp: 50 } }));
    }));
    const next = notifyDeployed(state, { unit: deployed, kind: "MANUAL" });
    assert.deepEqual(calls, ["MANUAL", "AUTOMATIC"]);
    assert.equal(getUnit(next, 0).vitality.hp, 50);
    assert.equal(getUnit(state, 0).vitality.hp, 100);
});

test("entry precedes deployment observers; observer registrations survive successful ticks", () => {
    const calls = [];
    const bootstrap = definition("bootstrap", { onEnter(state) {
        return addHook(state, 0, record("observer", (state, fact) => {
            calls.push(["observed", fact.unit.id, fact.kind]);
            assert.equal(fact.unit.deployable.cardId, fact.unit.id - 1);
            assert.equal(getUnit(state, fact.unit.id).vitality.hp, 75);
            return state;
        }));
    } });
    const incoming = definition("incoming", { onEnter(state, unitId) {
        calls.push(["entered", unitId]);
        return transitionUnit(state, unitId, (unit) => ({ ...unit, vitality: { ...unit.vitality, hp: 75 } }));
    } });
    const runtime = new BattleRuntime(input({
        initialUnits: [{ definition: bootstrap, position: [7, 0] }],
        deployment: deployment([incoming, incoming]),
    }));
    const previous = runtime.snapshot();
    runtime.step([deploy(0, 0)]);
    const first = runtime.snapshot();
    runtime.step([deploy(1, 1)]);
    assert.deepEqual(calls, [["entered", 1], ["observed", 1, "MANUAL"], ["entered", 2], ["observed", 2, "MANUAL"]]);
    assert.equal(previous.deployment.cards[0].costStage, 0);
    assert.equal(runtime.snapshot().units.find((unit) => unit.id === 0).deployable.deployedHooks.length, 1);
    assert.equal(previous.units.length, 1);
    assert.equal(first.units.length, 2);
});

test("a deployment remains observable when its entry callback immediately removes the unit", () => {

    const calls = [];
    const bootstrap = definition("bootstrap", { onEnter(state) {
        return addHook(state, 0, record("observer", (state, fact) => {
            calls.push(["deployed", fact.unit.id]);
            assert.equal(getUnit(state, fact.unit.id), undefined);
            return state;
        }));
    } });
    const incoming = definition("immediate-exit", {
        onEnter(state, id) { return removeUnitWithEffects(state, id, "SCRIPT"); },
        onLeave(state, departure) { calls.push(["left", departure.unit.id]); return state; },
    });
    const runtime = new BattleRuntime(input({
        initialUnits: [{ definition: bootstrap, position: [7, 0] }],
        deployment: deployment([incoming]),
    }));
    const step = runtime.step([deploy(0)]);
    assert.deepEqual(calls, [["left", 1], ["deployed", 1]]);
    assert.equal(runtime.snapshot().units.length, 1);
    assert.equal(step.events.filter((event) => event.type === "UNIT_DEPLOYED").length, 1);
    assert.equal(step.events.filter((event) => event.type === "UNIT_REMOVED").length, 1);
});

test("geometry relocation and ordinary enemy entry do not broadcast deployment", () => {
    const calls = [];
    const bootstrap = definition("bootstrap", { onEnter(state) {
        return addHook(state, 0, record("observer", (state, fact) => { calls.push(fact.unit.id); return state; }));
    } });
    let entered = 0;
    const runtime = new BattleRuntime(input({
        initialUnits: [{ definition: bootstrap, position: [7, 0] }],
        schedule: { type: "TIMELINE", spawns: [spawn(enemy({ onEnter(state) { entered++; return state; } }), 0)] },
        deployment: deployment([definition("incoming")]),
    }));
    runtime.step([deploy(0)]);
    runtime.step([{ type: "RELOCATE_UNIT", unitId: 1, tilePosition: [0, 2], playerSide: "SIDE_A" }]);
    assert.deepEqual(calls, [1]);
    assert.equal(entered, 1);
    assert.deepEqual(runtime.snapshot().units.find((unit) => unit.id === 1).position, [2, 0]);
});

test("an Effect can own a deployment observer and remove it during source retirement", () => {
    const calls = [];
    const effect = {
        id: "deployment-talent", initialize: () => ({}),
        onInstall(state, context) {
            const ref = context.ref;
            return addHook(state, ref.host.id, record("talent", (state, fact) => {
                calls.push(fact.unit.id);
                return state;
            }, (state) => getUnit(state, ref.host.id)?.effects.get(ref.id)?.status === "ACTIVE"));
        },
        onEnd(state, context) { return deleteHook(state, context.ref.host.id, "talent"); },
    };
    const source = definition("source", { onEnter(state, id) { return install(state, unitRef(getUnit(state, id)), effect).state; } });
    const runtime = new BattleRuntime(input({
        initialUnits: [{ definition: source, position: [7, 0] }],
        deployment: deployment([definition("first"), definition("second")]),
    }));
    const initial = runtime.snapshot();
    runtime.step([deploy(0)]);
    runtime.step([{ type: "RETREAT_UNIT", unitId: 0 }, deploy(1, 1)]);
    assert.deepEqual(calls, [1]);
    assert.equal(runtime.snapshot().units.find((unit) => unit.id === 0), undefined);
    assert.equal(initial.units[0].deployable.deployedHooks.length, 1);
    assert.equal(initial.units[0].effects.values()[0].status, "ACTIVE");
});

test("failed ticks throw and do not publish deployment hook changes", () => {
    const failure = new Error("deployment callback failed");
    const incoming = definition("failing-entry", { onEnter(state, id) {
        state = addHook(state, id, record("unpublished", (state) => state));
        throw failure;
    } });
    const runtime = new BattleRuntime(input({ deployment: deployment([incoming]) }));
    const before = runtime.snapshot();
    assert.throws(() => runtime.step([deploy(0)]), (error) => error === failure);
    assert.deepEqual(runtime.snapshot(), before);
    assert.equal(runtime.snapshot().units.length, 0);
});


test("deployment keeps its event snapshot after removal while observers read the latest battle", () => {
    const deployed = unit(1);
    const fact = { unit: deployed, kind: "MANUAL" };
    let state = createBattleState(fixtureBattlefieldState([unit(0), deployed]));
    state = addHook(state, 0, record("remove", (state, context) => {
        assert.equal(context, fact);
        return removeUnitWithEffects(state, context.unit.id, "SCRIPT");
    }));
    state = addHook(state, 0, record("observe", (state, context) => {
        assert.equal(context, fact);
        assert.equal(context.unit, deployed);
        assert.equal(context.unit.lifecycle, "PRESENT");
        assert.equal(getUnit(state, context.unit.id), undefined);
        return state;
    }));
    const next = notifyDeployed(state, fact);
    assert.equal(getUnit(next, 1), undefined);
    assert.equal(getUnit(state, 1), deployed);
});

test("deployment resolves current versions independently for identical IDs on different hosts", () => {
    const calls = [];
    let state = createBattleState(fixtureBattlefieldState([unit(0), unit(1)]));
    state = addHook(state, 0, record("same", state => {
        calls.push("first-host");
        return addHook(state, 1, record("same", state => { calls.push("replacement"); return state; }));
    }));
    state = addHook(state, 1, record("same", () => assert.fail("old registration ran")));
    notifyDeployed(state, { unit: getUnit(state, 1), kind: "MANUAL" });
    assert.deepEqual(calls, ["first-host", "replacement"]);
});

test("nested deployment observes newly registered candidates without adding them to its outer dispatch", () => {
    const calls = [];
    const deployed = unit(0);
    let state = createBattleState(fixtureBattlefieldState([deployed]));
    state = addHook(state, 0, record("first", (state, context) => {
        calls.push(["first", context.kind]);
        if (context.kind === "MANUAL") {
            state = addHook(state, 0, record("late", (state, nested) => {
                calls.push(["late", nested.kind]);
                return state;
            }));
            state = notifyDeployed(state, { unit: deployed, kind: "AUTOMATIC" });
        }
        return state;
    }));
    notifyDeployed(state, { unit: deployed, kind: "MANUAL" });
    assert.deepEqual(calls, [["first", "MANUAL"], ["first", "AUTOMATIC"], ["late", "AUTOMATIC"]]);
});
