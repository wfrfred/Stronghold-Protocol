import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { createBattleState, getUnit, transitionUnit } from "../../dist/core/tactical/battle/state.js";
import {
    initialize as initializeDeployment,
    notifyDeployed,
    removeDeployedHook,
    setDeployedHook,
} from "../../dist/core/tactical/battle/deployment/deployment.js";
import { removeUnitWithEffects } from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { initialize } from "../../dist/core/tactical/unit/initialize.js";
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
const profile = { buildableType: "ALL", advancedBuildableMask: 1 };
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
const definition = (id, fields = {}) => ({ id, vitality: { maxHp: 100 }, deployable: profile, ...fields });
const unit = (id, fields = {}) => initialize({ id, definition: definition(`unit:${id}`, fields), position: [id, 0] });
const input = (fields = {}) => ({
    map, schedule: { type: "TIMELINE", spawns: [spawn(enemy(), 1000)] }, initialUnits: [], predefines: [],
    initialMechanisms: [], initialNavigationModifiers: [], maxTicks: 30, routeMoveMultiplier: 1,
    rngState: 1, ...fields,
});
const deploy = (value, column = 0) => ({
    type: "DEPLOY_UNIT", definition: value, tilePosition: [0, column], playerSide: "SIDE_A",
});
const record = (id, invoke, enabled = () => true) => ({
    id, enabled, invoke(state, view, deployed) {
        return { state: invoke(state, view, deployed), value: undefined };
    },
});
const addHook = (state, entry) => ({ ...state, deployment: setDeployedHook(state.deployment, entry) });

test("deployment observers consume preceding state and recheck registration and eligibility", () => {
    const deployed = unit(1);
    let state = createBattleState(fixtureBattlefieldState([unit(0), deployed]));
    const calls = [];
    state = addHook(state, record("first", (state) => {
        calls.push("first");
        state = transitionUnit(state, 0, (unit) => ({ ...unit, vitality: { ...unit.vitality, hp: 70 } }));
        return { ...state, deployment: removeDeployedHook(state.deployment, "removed") };
    }));
    state = addHook(state, record("removed", () => assert.fail("removed observer ran")));
    state = addHook(state, record("enabled-after-first", (state, view, fact) => {
        calls.push("enabled-after-first");
        assert.equal(view.getUnit(0).vitality.hp, 70);
        assert.equal(fact.unit, deployed);
        return state;
    }, (view) => view.getUnit(0).vitality.hp === 70));
    const previous = state;
    const next = notifyDeployed(state, { unit: deployed, kind: "MANUAL" });
    assert.deepEqual(calls, ["first", "enabled-after-first"]);
    assert.equal(getUnit(next, 0).vitality.hp, 70);
    assert.equal(getUnit(previous, 0).vitality.hp, 100);
    assert.equal(previous.deployment.deployedHooks.length, 3);
});

test("new observers wait for the next notification; replacing an observer retains its position", () => {
    const deployed = unit(0);
    let state = createBattleState(fixtureBattlefieldState([deployed]));
    const calls = [];
    const late = record("late", (state) => { calls.push("late"); return state; });
    state = addHook(state, record("first", (state) => {
        calls.push("first");
        return addHook(state, late);
    }));
    state = addHook(state, record("second", (state) => { calls.push("obsolete"); return state; }));
    state = addHook(state, record("second", (state) => { calls.push("second"); return state; }));
    const fact = { unit: deployed, kind: "MANUAL" };
    state = notifyDeployed(state, fact);
    assert.deepEqual(calls, ["first", "second"]);
    notifyDeployed(state, fact);
    assert.deepEqual(calls, ["first", "second", "first", "second", "late"]);
    assert.equal(initializeDeployment().deployedHooks.length, 0);
});

test("a nested deployment notification returns its state before the outer observer continues", () => {
    const deployed = unit(0);
    let state = createBattleState(fixtureBattlefieldState([deployed]));
    const calls = [];
    state = addHook(state, record("nested", (state, _view, fact) => {
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
    const bootstrap = { id: "bootstrap", onEnter(state) {
        return addHook(state, record("observer", (state, view, fact) => {
            calls.push(["observed", fact.unit.id, fact.kind]);
            assert.equal(fact.unit.deployable.cardId, null);
            assert.equal(view.getUnit(fact.unit.id).vitality.hp, 75);
            return state;
        }));
    } };
    const incoming = definition("incoming", { onEnter(state, unitId) {
        calls.push(["entered", unitId]);
        return transitionUnit(state, unitId, (unit) => ({ ...unit, vitality: { ...unit.vitality, hp: 75 } }));
    } });
    const runtime = new BattleRuntime(input({ initialUnits: [{ definition: bootstrap, position: [7, 0] }] }));
    const previous = runtime.snapshot();
    runtime.step([deploy(incoming, 0)]);
    const first = runtime.snapshot();
    runtime.step([deploy(incoming, 1)]);
    assert.deepEqual(calls, [["entered", 1], ["observed", 1, "MANUAL"], ["entered", 2], ["observed", 2, "MANUAL"]]);
    assert.equal(first.deployment, previous.deployment);
    assert.equal(runtime.snapshot().deployment.deployedHooks.length, 1);
    assert.equal(previous.units.length, 1);
    assert.equal(first.units.length, 2);
});

test("a deployment remains observable when its entry callback immediately removes the unit", () => {
    const resources = new CombatResources();
    const calls = [];
    const bootstrap = { id: "bootstrap", onEnter(state) {
        return addHook(state, record("observer", (state, view, fact) => {
            calls.push(["deployed", fact.unit.id]);
            assert.equal(view.getUnit(fact.unit.id), undefined);
            return state;
        }));
    } };
    const incoming = definition("immediate-exit", {
        onEnter(state, id) { return removeUnitWithEffects(state, id, "SCRIPT", resources, state.tick); },
        onLeave(state, departure) { calls.push(["left", departure.unit.id]); return state; },
    });
    const runtime = new BattleRuntime(input({ initialUnits: [{ definition: bootstrap, position: [7, 0] }] }), { combat: resources });
    const step = runtime.step([deploy(incoming)]);
    assert.deepEqual(calls, [["left", 1], ["deployed", 1]]);
    assert.equal(runtime.snapshot().units.length, 1);
    assert.equal(step.events.filter((event) => event.type === "UNIT_DEPLOYED").length, 1);
    assert.equal(step.events.filter((event) => event.type === "UNIT_REMOVED").length, 1);
});

test("geometry relocation and ordinary enemy entry do not broadcast deployment", () => {
    const calls = [];
    const bootstrap = { id: "bootstrap", onEnter(state) {
        return addHook(state, record("observer", (state, _view, fact) => { calls.push(fact.unit.id); return state; }));
    } };
    let entered = 0;
    const runtime = new BattleRuntime(input({
        initialUnits: [{ definition: bootstrap, position: [7, 0] }],
        schedule: { type: "TIMELINE", spawns: [spawn(enemy({ onEnter(state) { entered++; return state; } }), 0)] },
    }));
    runtime.step([deploy(definition("incoming"))]);
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
            return addHook(state, record("talent", (state, _view, fact) => {
                calls.push(fact.unit.id);
                return state;
            }, (view) => view.getUnit(ref.unitId)?.effects.get(ref.effectId)?.status === "ACTIVE"));
        },
        onEnd(state) { return { ...state, deployment: removeDeployedHook(state.deployment, "talent") }; },
    };
    const source = { id: "source", onEnter(state, id) { return install(state, getUnit(state, id), effect).state; } };
    const runtime = new BattleRuntime(input({ initialUnits: [{ definition: source, position: [7, 0] }] }));
    const initial = runtime.snapshot();
    runtime.step([deploy(definition("first"))]);
    runtime.step([{ type: "RETREAT_UNIT", unitId: 0 }, deploy(definition("second"), 1)]);
    assert.deepEqual(calls, [1]);
    assert.equal(runtime.snapshot().deployment.deployedHooks.length, 0);
    assert.equal(initial.deployment.deployedHooks.length, 1);
    assert.equal(initial.units[0].effects.values()[0].status, "ACTIVE");
});

test("failed ticks throw and do not publish deployment hook changes", () => {
    const failure = new Error("deployment callback failed");
    const incoming = definition("failing-entry", { onEnter(state) {
        state = addHook(state, record("unpublished", (state) => state));
        throw failure;
    } });
    const runtime = new BattleRuntime(input());
    const before = runtime.snapshot();
    assert.throws(() => runtime.step([deploy(incoming)]), (error) => error === failure);
    assert.deepEqual(runtime.snapshot(), before);
    assert.equal(runtime.snapshot().deployment.deployedHooks.length, 0);
});
