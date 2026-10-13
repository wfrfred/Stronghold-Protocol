import { setData } from "../../dist/core/tactical/unit/effect/effect.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { battlefieldView, getUnit } from "../../dist/core/tactical/battle/state.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import { createDefinition } from "../../dist/core/tactical/unit/archetype/enemy.js";
import { createDefinition as createDeployableDefinition } from "../../dist/core/tactical/unit/capability/deployable/capability.js";
import { createRouteDefinition } from "../../dist/core/tactical/unit/capability/locomotion/route/definition.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { effectFixtureWork } from "../helpers/effects.js";
import {
    attackEffect,
    auraUnit,
    effectProgram,
    auraEffect,
    seededPlacement,
    snapshotAttack,
} from "../helpers/aura.js";

const tile = createTile({
    heightType: "LOWLAND",
    buildableType: "ALL",
    passableMask: "ALL",
    playerSideMask: "ALL",
    terrain: "NORMAL",
    mechanism: null,
});

function route({ start = 4, end = 7, wait = true } = {}) {
    return createRouteDefinition({
        pathMotionMode: "WALK",
        startPosition: [0, start],
        endPosition: [0, end],
        spawnOffset: [0, 0],
        spawnRandomRange: [0, 0],
        checkpoints: wait ? [{ type: "WAIT_FOR_TICKS", durationTicks: 100 }] : [],
        allowDiagonalMove: false,
        visitEveryTileCenter: false,
        visitEveryNodeCenter: false,
        visitEveryCheckPoint: true,
    });
}

function spawn({ tick = 2, start = 4, end = 7, speed = 0, wait = true } = {}) {
    return {
        definition: {
            ...createDefinition({
                id: "scheduled-receiver",
                vitality: { maxHp: 100 },
                locomotion: {
                    moveSpeedPerTick: speed,
                    steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
                },
            }),
            offense: Object.freeze({ attack: 100 }),
        },
        route: route({ start, end, wait }),
        tick,
        timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
        alwaysCheckCurrentPoint: true,
        notCountInTotal: false,
    };
}

function input(host, overrides = {}) {
    return {
        map: createBattlefieldMap(1, 8, Array(8).fill(tile)),
        initialUnits: [host, { definition: auraUnit(1).definition, position: [1, 0] }],
        schedule: { type: "TIMELINE", spawns: [spawn()] },
        predefines: [],
        initialMechanisms: [],
        initialNavigationModifiers: [],
        maxTicks: 10,
        routeMoveMultiplier: 1,
        rngState: 17,
        ...overrides,
    };
}

test("aura runtime: a restored aura refreshes on its first tick without creating a source mechanism", () => {
    const resources = new CombatResources();
    const receiver = attackEffect("initial-aura-receiver");
    const aura = auraEffect(receiver);
    const host = seededPlacement(aura);
    const runtime = new BattleRuntime(input(host), { combat: resources });
    const initial = runtime.snapshot();
    assert.deepEqual(initial.mechanisms, []);
    assert.equal(initial.units[0].effects.values()[0].definition, aura);
    assert.deepEqual(initial.units[0].effects.values()[0].data.bindings, []);
    assert.equal(snapshotAttack(initial, 1, resources), 100);
    assert.deepEqual(host.effects.values()[0].data.bindings, []);
    runtime.step();
    const after = runtime.snapshot();
    assert.deepEqual(
        after.units[0].effects.values()[0].data.bindings.map((binding) => binding.unitId),
        [1],
    );
    assert.equal(snapshotAttack(after, 1, resources), 120);
    assert.equal(after.units[1].effects.nextId, 1);
    assert.equal(snapshotAttack(initial, 1, resources), 100);
});

test("aura runtime: predefined, deployment and spawning join before the same tick effect advance", () => {
    const resources = new CombatResources();
    const starts = [];
    const receiver = attackEffect("registration-receiver", {
        onInstall: (state, context) => {
            starts.push([context.ref.unitId, context.tick]);
            return state;
        },
    });
    const aura = auraEffect(receiver);
    const seen = [];
    const observer = {
        ...effectProgram("registration-observer"),
        onTick: (state) => {
            const view = battlefieldView(state);
            seen.push(
                view.unitIds.map((id) => [
                    id,
                    view
                        .getUnit(id)
                        .effects.values().some((effect) => effect.definition === receiver),
                ]),
            );
            return state;
        },
    };
    let hostState = effectFixtureWork(auraUnit(0));
    for (const effect of [observer, aura])
        hostState = effects.install(hostState, getUnit(hostState, 0), effect, { source: 0 }).state;
    const hostUnit = getUnit(hostState, 0);
    const host = {
        definition: hostUnit.definition,
        position: hostUnit.position,
        effects: hostUnit.effects,
    };
    const predefined = {
        id: 7,
        alias: "late-aura-receiver",
        initiallyPresent: false,
        creation: {
            type: "UNIT",
            definition: auraUnit(2).definition,
            position: [3, 0],
            navigationModifiers: [],
        },
    };
    const deployable = auraUnit(3, [0, 0], {
        deployable: createDeployableDefinition({ buildableType: "ALL" }),
    }).definition;
    const runtime = new BattleRuntime(
        input(host, {
            predefines: [predefined],
            schedule: { type: "TIMELINE", spawns: [spawn({ tick: 0 })] },
        }),
        { combat: resources },
    );
    assert.deepEqual(starts, []);
    runtime.step([
        { type: "APPEAR_PREDEFINED", definitionId: 7 },
        { type: "DEPLOY_UNIT", definition: deployable, tilePosition: [0, 2], playerSide: "SIDE_A" },
    ]);
    assert.deepEqual(starts, [
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
    ]);
    assert.deepEqual(seen, [
        [
            [0, false],
            [1, false],
            [2, false],
            [3, false],
            [4, false],
        ],
    ]);
    const after = runtime.snapshot();
    const auraInstance = after.units[0].effects.values().find(
        (effect) => effect.definition === aura,
    );
    assert.deepEqual(
        auraInstance.data.bindings.map((binding) => binding.unitId),
        [1, 2, 3, 4],
    );
    assert.deepEqual(
        [1, 2, 3, 4].map((id) => snapshotAttack(after, id, resources)),
        [120, 120, 120, 120],
    );
});

test("aura runtime: movement departure is observed at the next aura tick", () => {
    const resources = new CombatResources();
    let before;
    const receiver = attackEffect("moving-receiver", {
        onEnable: (state, context) => {
            if (context.ref.unitId === 2) {
                const view = battlefieldView(state);
                before = { units: view.unitIds.map((id) => view.getUnit(id)) };
            }
            return state;
        },
    });
    const aura = auraEffect(receiver, { accepts: (target) => target.position[0] <= 4.1 });
    const host = seededPlacement(aura);
    const runtime = new BattleRuntime(
        input(host, {
            schedule: { type: "TIMELINE", spawns: [spawn({ tick: 0, speed: 1, wait: false })] },
        }),
        { combat: resources },
    );
    let departed;
    for (let tick = 0; tick < 8 && departed === undefined; tick++) {
        runtime.step();
        const after = runtime.snapshot();
        const moved = after.units.find((unit) => unit.id === 2);
        if (moved && moved.position[0] > 4.1) departed = after;
    }
    assert.ok(before, "receiver entered the aura before departure");
    assert.ok(departed, "receiver moved out of the aura");
    assert.equal(snapshotAttack(before, 2, resources), 120);
    assert.equal(snapshotAttack(departed, 2, resources), 120);
    assert.equal(
        departed.units[0].effects.values()[0].data.bindings.some(
            (binding) => binding.unitId === 2,
        ),
        true,
    );
    runtime.step();
    const refreshed = runtime.snapshot();
    assert.equal(snapshotAttack(refreshed, 2, resources), 100);
    assert.equal(
        refreshed.units[0].effects.values()[0].data.bindings.some(
            (binding) => binding.unitId === 2,
        ),
        false,
    );
    assert.equal(snapshotAttack(departed, 2, resources), 120);
    assert.equal(snapshotAttack(before, 2, resources), 120);
});

test("aura runtime: callback failure propagates the original error without publishing the tick", () => {
    const resources = new CombatResources();
    const failure = new Error("aura registration failed");
    const attempts = [];
    let receiver;
    receiver = attackEffect("fallible-aura-receiver", {
        onInstall: (state, context) => {
            state = effects.replaceEffect(
                state,
                context.ref,
                setData(context.self, (current) => ({ ...current, starts: 1 })),
            );
            if (context.ref.unitId === 2) {
                attempts.push(context.ref);
                throw failure;
            }
            return state;
        },
    });
    const aura = auraEffect(receiver);
    const runtime = new BattleRuntime(input(seededPlacement(aura)), { combat: resources });
    runtime.step();
    runtime.step();
    const before = runtime.snapshot();
    assert.throws(
        () => runtime.step(),
        (error) => error === failure,
    );
    assert.deepEqual(runtime.snapshot(), before);
    assert.equal(attempts.length, 1);
});

test("aura runtime: source retirement ends remote bound buffs within the same step", () => {
    const resources = new CombatResources();
    const receiver = attackEffect("retired-aura-receiver");
    const aura = auraEffect(receiver);
    const runtime = new BattleRuntime(input(seededPlacement(aura)), { combat: resources });
    runtime.step();
    const before = runtime.snapshot();
    runtime.step([{ type: "RETREAT_UNIT", unitId: 0 }]);
    const after = runtime.snapshot();
    assert.equal(
        after.units.some((unit) => unit.id === 0),
        false,
    );
    assert.equal(snapshotAttack(after, 1, resources), 100);
    assert.equal(snapshotAttack(before, 1, resources), 120);
});
