import { attack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import {
    createMechanismDefinition,
} from "../../dist/core/tactical/battlefield/mechanism.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createTile } from "../../dist/core/tactical/battlefield/map/tile.js";
import {
    createEffectSourceProgramRef,
    effectSourceInstallation,
} from "../../dist/core/tactical/battlefield/effect-source/program.js";
import * as modifier from "../../dist/core/tactical/modifier/value.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { updateAttackContributions } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { createEnemyDefinition } from "../../dist/core/tactical/unit/archetype/enemy.js";
import { createRouteDefinition } from "../../dist/core/tactical/unit/capability/locomotion/route/definition.js";

function unitDefinition(id) {
    return Object.freeze({
        id,
        vitality: Object.freeze({ maxHp: 100 }),
        offense: Object.freeze({ attack: 100 }),
    });
}

function createBattleInput(sources = [], options = {}) {
    const tile = createTile({
        heightType: "LOWLAND",
        buildableType: "ALL",
        passableMask: "ALL",
        playerSideMask: "ALL",
        terrain: "NORMAL",
        mechanism: null,
    });
    const route = createRouteDefinition({
        pathMotionMode: "WALK",
        startPosition: [0, 2],
        endPosition: [0, 3],
        spawnOffset: [0, 0],
        spawnRandomRange: [0, 0],
        checkpoints: [{ type: "WAIT_FOR_TICKS", durationTicks: 100 }],
        allowDiagonalMove: false,
        visitEveryTileCenter: false,
        visitEveryNodeCenter: false,
        visitEveryCheckPoint: true,
    });
    const enemy = Object.freeze({
        ...createEnemyDefinition({
            id: "later-receiver",
            vitality: { maxHp: 100 },
            locomotion: {
                moveSpeedPerTick: 0,
                steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
            },
        }),
        offense: Object.freeze({ attack: 100 }),
    });

    return {
        map: createBattlefieldMap(1, 4, [tile, tile, tile, tile]),
        initialUnits: [
            { definition: unitDefinition("first-receiver"), position: [0, 0] },
            { definition: unitDefinition("second-receiver"), position: [1, 0] },
        ],
        schedule: {
            type: "TIMELINE",
            spawns: [{
                definition: enemy,
                route,
                tick: 2,
                timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
                alwaysCheckCurrentPoint: true,
                notCountInTotal: false,
            }],
        },
        predefines: [],
        initialMechanisms: sources,
        initialNavigationModifiers: [],
        maxTicks: 10,
        routeMoveMultiplier: 1,
        rngState: 17,
        ...options,
    };
}

function receiverProgram(resources, id, addition = 20, lifecycle) {
    const program = createEffectProgram({
        id,
        initialize: () => ({}),
        ownState: value => value,
    });

    return resources.registerEffect(program, {
        contributions: [attack(() => [modifier.create({ finalAddition: addition })])],
        ...(lifecycle === undefined ? {} : { lifecycle }),
    });
}

function currentAttack(snapshot, unitId, resources) {
    const byId = new Map(snapshot.units.map(unit => [unit.id, unit]));

    return resolveAttackPower(unitId, {
        unitIds: [...byId.keys()],
        getUnit: id => byId.get(id),
        blockerOf: () => undefined,
        blockedBy: () => [],
    }, resources.computations);
}

function sourceMechanism(resources, id, receiver, options = {}) {
    const ref = createEffectSourceProgramRef(`source-${id}`);
    const continuous = options.continuous ?? true;
    resources.effectSources.register({
        ref,
        initialize: () => ({ remainingCount: 3 }),
        ownState: value => value,
        selectInitial: ({ battlefield }) =>
            options.selectFirst ? battlefield.unitIds.slice(0, 1) : battlefield.unitIds,
        ...(continuous ? { acceptsRegistration: () => true } : {}),
        install: () => effectSourceInstallation(receiver.ref, { scopes: [] }),
        ...(options.shouldFinish === undefined ? {} : { shouldFinish: options.shouldFinish }),
    });

    return {
        definition: createMechanismDefinition({ id: ref.id }),
        active: true,
        effectSource: { programRef: ref, state: { remainingCount: 3 } },
    };
}

test("effect source runtime: initialization installs independent receiver facts from a nonspatial source", () => {
    const resources = new CombatResources();
    const receiver = receiverProgram(resources, "initial-receiver");
    const source = sourceMechanism(resources, 40, receiver);
    const runtime = new BattleRuntime(createBattleInput([source]), { combat: resources });
    const snapshot = runtime.snapshot();
    const registeredSource = snapshot.mechanisms[0];
    const receivers = registeredSource.effectSource.receivers;

    assert.equal(registeredSource.id, 0);
    assert.equal(registeredSource.effectSource.initialized, true);
    assert.equal(registeredSource.effectSource.sourceUnitId, null);
    assert.deepEqual(receivers.map(binding => binding.unitId), [0, 1]);
    assert.deepEqual(receivers.map(binding => binding.installationAttempts), [1, 1]);
    assert.notDeepEqual(receivers[0].address, receivers[1].address);
    assert.deepEqual(receivers.map(binding => binding.address.unitId), [0, 1]);
    assert.deepEqual(snapshot.units.map(unit => unit.id), [0, 1]);
    assert.equal(currentAttack(snapshot, 0, resources), 120);
    assert.equal(currentAttack(snapshot, 1, resources), 120);
    assert.equal(snapshot.units.every(unit => unit.effects.instances[0].source === null), true);
    assert.equal("receivers" in source.effectSource, false);
    assert.equal("initialized" in source.effectSource, false);
    assert.deepEqual(source.effectSource.state, { remainingCount: 3 });
});

test("effect source runtime: scheduled registrations join continuous sources but do not extend initial selection", () => {
    const resources = new CombatResources();
    const globalReceiver = receiverProgram(resources, "global-receiver", 20);
    const onceReceiver = receiverProgram(resources, "once-receiver", 5);
    const global = sourceMechanism(resources, 40, globalReceiver);
    const once = sourceMechanism(resources, 41, onceReceiver, {
        continuous: false,
        selectFirst: true,
    });
    const runtime = new BattleRuntime(createBattleInput([global, once]), { combat: resources });
    const initial = runtime.snapshot();

    assert.equal(currentAttack(initial, 0, resources), 125);
    assert.equal(currentAttack(initial, 1, resources), 120);
    runtime.step();
    runtime.step();
    assert.deepEqual(runtime.snapshot().units.map(unit => unit.id), [0, 1]);
    runtime.step();
    const afterSpawn = runtime.snapshot();

    assert.equal(currentAttack(afterSpawn, 2, resources), 120);
    assert.deepEqual(afterSpawn.mechanisms[0].effectSource.receivers.map(binding => binding.unitId), [0, 1, 2]);
    assert.deepEqual(afterSpawn.mechanisms[1].effectSource.receivers.map(binding => binding.unitId), [0]);
    assert.deepEqual(initial.mechanisms[0].effectSource.receivers.map(binding => binding.unitId), [0, 1]);
    assert.equal(initial.mechanisms[0].effectSource.state.remainingCount, 3);
    runtime.step();

    assert.deepEqual(runtime.snapshot().mechanisms[0].effectSource.receivers.map(binding => binding.installationAttempts), [1, 1, 1]);
    assert.equal(currentAttack(runtime.snapshot(), 2, resources), 120);
});

test("effect source runtime: receiver removal is independent and source ending cleans surviving bindings", () => {
    const resources = new CombatResources();
    const receiver = receiverProgram(resources, "ending-receiver");
    const source = sourceMechanism(resources, 40, receiver, {
        shouldFinish: ({ tick }) => tick >= 1,
    });
    const runtime = new BattleRuntime(createBattleInput([source]), { combat: resources });
    const before = runtime.snapshot();
    runtime.step([{ type: "RETREAT_UNIT", unitId: 0 }]);
    const afterRemoval = runtime.snapshot();

    assert.equal(afterRemoval.units.some(unit => unit.id === 0), false);
    assert.equal(currentAttack(afterRemoval, 1, resources), 120);
    assert.equal(currentAttack(before, 0, resources), 120);
    runtime.step();
    const ended = runtime.snapshot();

    assert.equal(ended.mechanisms[0].effectSource.finished, true);
    assert.equal(currentAttack(ended, 1, resources), 100);
    assert.deepEqual(ended.units.find(unit => unit.id === 1).effects.instances, []);
    runtime.step();

    assert.equal(currentAttack(runtime.snapshot(), 2, resources), 100);
});

test("effect source runtime: predefined registration joins the source during the same tick", () => {
    const resources = new CombatResources();
    const receiver = receiverProgram(resources, "predefined-receiver");
    const source = sourceMechanism(resources, 40, receiver);
    const runtime = new BattleRuntime(
        createBattleInput([source], {
            predefines: [{
                id: 7,
                alias: "late-receiver",
                initiallyPresent: false,
                creation: {
                    type: "UNIT",
                    definition: unitDefinition("predefined-receiver"),
                    position: [3, 0],
                    navigationModifiers: [],
                },
            }],
        }),
        { combat: resources },
    );

    runtime.step([{ type: "APPEAR_PREDEFINED", definitionId: 7 }]);
    const snapshot = runtime.snapshot();

    assert.equal(snapshot.tickIndex, 1);
    assert.equal(currentAttack(snapshot, 2, resources), 120);
    assert.equal(snapshot.mechanisms[0].effectSource.receivers.find(binding => binding.unitId === 2).installationAttempts, 1);
    assert.equal(snapshot.units.find(unit => unit.id === 2).effects.instances.length, 1);
});

test("effect source runtime: a receiver installation exception discards the complete tick and retry does not duplicate state", () => {
    const resources = new CombatResources();
    let shouldThrow = true;
    const attempts = [];
    let receiver;
    receiver = receiverProgram(resources, "fallible-receiver", 20, {
        start: context => {
            context.effects.update(context.ref, receiver.ref, state => ({
                ...state,
                starts: (state.starts ?? 0) + 1,
            }));

            if (context.ref.unitId === 2) {
                attempts.push(context.ref);

                if (shouldThrow) {
                    throw new Error("receiver installation failed");
                }
            }
        },
    });
    const source = sourceMechanism(resources, 40, receiver);
    const runtime = new BattleRuntime(createBattleInput([source]), { combat: resources });
    runtime.step();
    runtime.step();
    const before = runtime.snapshot();

    assert.throws(() => runtime.step(), /receiver installation failed/);
    assert.deepEqual(runtime.snapshot(), before);
    shouldThrow = false;
    runtime.step();
    const after = runtime.snapshot();
    const spawned = after.units.find(unit => unit.id === 2);

    assert.equal(after.tickIndex, before.tickIndex + 1);
    assert.equal(currentAttack(after, 2, resources), 120);
    assert.equal(spawned.effects.instances.length, 1);
    assert.equal(spawned.effects.instances[0].state.starts, 1);
    assert.deepEqual(attempts, [{ type: "EFFECT", unitId: 2, effectId: 0 }, { type: "EFFECT", unitId: 2, effectId: 0 }]);
    assert.equal(after.mechanisms[0].effectSource.receivers.find(binding => binding.unitId === 2).installationAttempts, 1);
    assert.deepEqual(before.mechanisms[0].effectSource.receivers.map(binding => binding.unitId), [0, 1]);
});

test("effect source runtime: delivering a battle seals the source registry", () => {
    const resources = new CombatResources();
    const receiver = receiverProgram(resources, "sealed-receiver");
    const source = sourceMechanism(resources, 40, receiver);
    const runtime = new BattleRuntime(createBattleInput([source]), { combat: resources });

    assert.throws(() => sourceMechanism(resources, 41, receiver), /registration is sealed/);
    runtime.step();
    assert.equal(currentAttack(runtime.snapshot(), 0, resources), 120);
});
