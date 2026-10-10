import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { getUnit } from '../../dist/core/tactical/battle/execution/context.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';
import { createEnemyDefinition } from '../../dist/core/tactical/unit/archetype/enemy.js';
import { createDeploymentProfile } from '../../dist/core/tactical/unit/capability/deployment.js';
import { createRouteDefinition } from '../../dist/core/tactical/unit/capability/locomotion/route/definition.js';
import { installNewEffect } from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { effectFixtureWork } from '../helpers/effects.js';
import { attackEffect, auraUnit, effectProgram, registerAura, seededPlacement, snapshotAttack } from '../helpers/aura.js';

const tile = createTile({ heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null });

function route({ start = 4, end = 7, wait = true } = {}) {
    return createRouteDefinition({ pathMotionMode: 'WALK', startPosition: [0, start], endPosition: [0, end],
        spawnOffset: [0, 0], spawnRandomRange: [0, 0],
        checkpoints: wait ? [{ type: 'WAIT_FOR_TICKS', durationTicks: 100 }] : [],
        allowDiagonalMove: false, visitEveryTileCenter: false,
        visitEveryNodeCenter: false, visitEveryCheckPoint: true });
}

function spawn({ tick = 2, start = 4, end = 7, speed = 0, wait = true } = {}) {
    return { definition: { ...createEnemyDefinition({ id: 'scheduled-receiver', vitality: { maxHp: 100 },
        locomotion: { moveSpeedPerTick: speed,
            steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 } } }),
        offense: Object.freeze({ attack: 100 }) },
    route: route({ start, end, wait }), tick,
    timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
    alwaysCheckCurrentPoint: true, notCountInTotal: false };
}

function input(host, overrides = {}) {
    return { map: createBattlefieldMap(1, 8, Array(8).fill(tile)),
        initialUnits: [host, { definition: auraUnit(1).definition, position: [1, 0] }],
        schedule: { type: 'TIMELINE', spawns: [spawn()] }, predefines: [],
        initialMechanisms: [], initialNavigationModifiers: [],
        maxTicks: 10, routeMoveMultiplier: 1, rngState: 17, ...overrides };
}

test('aura runtime: initialization reconciles a unit effect without creating a source mechanism', () => {
    const resources = new CombatResources();
    const receiver = attackEffect(resources, 'initial-aura-receiver');
    const aura = registerAura(resources, receiver);
    const host = seededPlacement(resources, aura);
    const runtime = new BattleRuntime(input(host), { combat: resources });
    const initial = runtime.snapshot();
    assert.deepEqual(initial.mechanisms, []);
    assert.equal(initial.units[0].effects.instances[0].programRef, aura.ref);
    assert.deepEqual(initial.units[0].effects.instances[0].state.bindings.map(binding => binding.unitId), [1]);
    assert.equal(snapshotAttack(initial, 1, resources), 120);
    assert.deepEqual(host.states.effects.instances[0].state.bindings, []);
    runtime.step();
    assert.equal(snapshotAttack(initial, 1, resources), 120);
    assert.equal(initial.units[1].effects.nextInstanceId, 1);
});

test('aura runtime: predefined, deployment and spawning join before the same tick effect advance', () => {
    const resources = new CombatResources();
    const starts = [];
    const receiver = attackEffect(resources, 'registration-receiver', {
        lifecycle: { start: context => { starts.push([context.ref.unitId, context.tick]); } },
    });
    const aura = registerAura(resources, receiver);
    const seen = [];
    const observer = resources.registerEffect(effectProgram('registration-observer'), {
        lifecycle: { advance: context => {
            seen.push(context.battlefield.unitIds.map(id => [id,
                context.battlefield.getUnit(id).effects?.instances.some(effect => effect.programRef === receiver.ref) ?? false]));
        } },
    });
    const hostState = effectFixtureWork(auraUnit(0));
    for (const effect of [aura, observer]) installNewEffect(hostState, 0, effect.ref,
        { source: 0, scopes: [] }, resources, 0);
    const hostUnit = getUnit(hostState, 0);
    const host = { definition: hostUnit.definition, position: hostUnit.position, states: { effects: hostUnit.effects } };
    const predefined = { id: 7, alias: 'late-aura-receiver', initiallyPresent: false,
        creation: { type: 'UNIT', definition: auraUnit(2).definition, position: [3, 0], navigationModifiers: [] } };
    const deployable = auraUnit(3, [0, 0], {
        deployment: createDeploymentProfile({ buildableType: 'ALL' }),
    }).definition;
    const runtime = new BattleRuntime(input(host, { predefines: [predefined],
        schedule: { type: 'TIMELINE', spawns: [spawn({ tick: 0 })] } }), { combat: resources });
    runtime.step([{ type: 'APPEAR_PREDEFINED', definitionId: 7 },
        { type: 'DEPLOY_UNIT', definition: deployable, tilePosition: [0, 2], playerSide: 'SIDE_A' }]);
    assert.deepEqual(starts, [[1, 0], [2, 0], [3, 0], [4, 0]]);
    assert.deepEqual(seen, [[[0, false], [1, true], [2, true], [3, true], [4, true]]]);
    const after = runtime.snapshot();
    assert.deepEqual(after.units[0].effects.instances[0].state.bindings.map(binding => binding.unitId), [1, 2, 3, 4]);
    assert.deepEqual([1, 2, 3, 4].map(id => snapshotAttack(after, id, resources)), [120, 120, 120, 120]);
});

test('aura runtime: movement departure is reconciled within the tick that moves the receiver', () => {
    const resources = new CombatResources();
    let before;
    const receiver = attackEffect(resources, 'moving-receiver', { lifecycle: { enable: context => {
        if (context.ref.unitId === 2) {
            const view = context.battlefield;
            before = { units: view.unitIds.map(id => view.getUnit(id)) };
        }
    } } });
    const aura = registerAura(resources, receiver, { accepts: target => target.position[0] <= 4.1 });
    const host = seededPlacement(resources, aura);
    const runtime = new BattleRuntime(input(host, {
        schedule: { type: 'TIMELINE', spawns: [spawn({ tick: 0, speed: 1, wait: false })] },
    }), { combat: resources });
    let departed;
    for (let tick = 0; tick < 8 && departed === undefined; tick++) {
        runtime.step();
        const after = runtime.snapshot();
        const moved = after.units.find(unit => unit.id === 2);
        if (moved && moved.position[0] > 4.1) departed = after;
    }
    assert.ok(before, 'receiver entered the aura before departure');
    assert.ok(departed, 'receiver moved out of the aura');
    assert.equal(snapshotAttack(before, 2, resources), 120);
    assert.equal(snapshotAttack(departed, 2, resources), 100);
    assert.equal(departed.units[0].effects.instances[0].state.bindings.some(binding => binding.unitId === 2), false);
    assert.equal(snapshotAttack(before, 2, resources), 120);
});

test('aura runtime: callback failure drops all draft changes and rethrows the original error', () => {
    const resources = new CombatResources();
    const failure = new Error('aura registration failed');
    let fail = true;
    const attempts = [];
    let receiver;
    receiver = attackEffect(resources, 'fallible-aura-receiver', { lifecycle: { start: context => {
        context.effects.update(context.ref, receiver.ref, state => ({ ...state, starts: 1 }));
        if (context.ref.unitId === 2) {
            attempts.push(context.ref);
            if (fail) throw failure;
        }
    } } });
    const aura = registerAura(resources, receiver);
    const runtime = new BattleRuntime(input(seededPlacement(resources, aura)), { combat: resources });
    runtime.step(); runtime.step();
    const before = runtime.snapshot();
    assert.throws(() => runtime.step(), error => error === failure);
    assert.deepEqual(runtime.snapshot(), before);
    fail = false;
    runtime.step();
    const after = runtime.snapshot();
    assert.equal(after.tickIndex, before.tickIndex + 1);
    assert.equal(snapshotAttack(after, 2, resources), 120);
    assert.deepEqual(attempts[0], attempts[1]);
    assert.equal(after.units.find(unit => unit.id === 2).effects.nextInstanceId, 1);
    assert.equal(after.units[0].effects.instances[0].state.bindings.filter(binding => binding.unitId === 2).length, 1);
});

test('aura runtime: source retirement ends remote bound buffs within the same step', () => {
    const resources = new CombatResources();
    const receiver = attackEffect(resources, 'retired-aura-receiver');
    const aura = registerAura(resources, receiver);
    const runtime = new BattleRuntime(input(seededPlacement(resources, aura)), { combat: resources });
    const before = runtime.snapshot();
    runtime.step([{ type: 'RETREAT_UNIT', unitId: 0 }]);
    const after = runtime.snapshot();
    assert.equal(after.units.some(unit => unit.id === 0), false);
    assert.equal(snapshotAttack(after, 1, resources), 100);
    assert.equal(snapshotAttack(before, 1, resources), 120);
});
