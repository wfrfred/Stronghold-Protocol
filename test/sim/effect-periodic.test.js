import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { getUnit } from '../../dist/core/tactical/battle/execution/context.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';
import { createDamageOperands } from '../../dist/core/tactical/unit/capability/vitality/damage/contract.js';
import { advanceEffects, expireEffects, installNewEffect, setEffectEnabled } from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { getEffect } from '../../dist/core/tactical/unit/capability/effects/query.js';
import { effectTick } from '../../dist/core/tactical/unit/capability/effects/instance.js';
import { createSkillDefinition } from '../../dist/core/tactical/unit/capability/skill/capability.js';
import { effectFixtureWork } from '../helpers/effects.js';
import { auraUnit, effectProgram, seededPlacement } from '../helpers/aura.js';

function battleInput(placement) {
    const tile = createTile({ heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
        playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null });
    return { map: createBattlefieldMap(1, 4, Array(4).fill(tile)), initialUnits: [placement],
        initialMechanisms: [], initialNavigationModifiers: [], predefines: [{ id: 7, alias: 'periodic-registration',
            initiallyPresent: false, creation: { type: 'UNIT', definition: auraUnit(1).definition,
                position: [1, 0], navigationModifiers: [] } }],
        schedule: { type: 'TIMELINE', spawns: [{
            definition: { id: 'future', vitality: { maxHp: 100 }, locomotion: { moveSpeedPerTick: 0,
                steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 } } }, tick: 9,
            route: { pathMotionMode: 'WALK', startPosition: [0, 3], endPosition: [0, 3],
                spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [],
                allowDiagonalMove: false, visitEveryTileCenter: false,
                visitEveryNodeCenter: false, visitEveryCheckPoint: true },
            timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
            alwaysCheckCurrentPoint: true, notCountInTotal: false,
        }] }, maxTicks: 10, routeMoveMultiplier: 1, rngState: 17 };
}

test('periodic effects: the tick callback controls trigger intervals independently of expiration', () => {
    const resources = new CombatResources();
    let poison;
    poison = resources.registerEffect(effectProgram('poison', () => ({ nextTriggerTick: 0, triggers: 0 })), {
        lifecycle: { advance: context => {
            if (context.tick < context.instance.state.nextTriggerTick) return;
            context.damage({ sourceUnitId: null, targetUnitId: context.ref.unitId,
                damageType: 'TRUE', operands: createDamageOperands(10) });
            context.effects.update(context.ref, poison.ref, state => ({
                ...state, triggers: state.triggers + 1, nextTriggerTick: context.tick + 2,
            }));
        } },
    });
    const state = effectFixtureWork(auraUnit(0));
    const installed = installNewEffect(state, 0, poison.ref, { source: null,
        scopes: [{ type: 'TICK', tick: 5 }] }, resources, 0);
    for (let tick = 0; tick < 5; tick++) {
        advanceEffects(state, tick, resources);
    }
    assert.equal(getUnit(state, 0).vitality.hp, 70);
    assert.equal(getEffect(state, installed.ref).state.triggers, 3);
    assert.equal(effectTick(getEffect(state, installed.ref)), 5, 'trigger progress does not change the lifetime deadline');
    expireEffects(state, 5, resources);
    advanceEffects(state, 5, resources);
    assert.equal(getEffect(state, installed.ref).finished, true);
    assert.equal(getUnit(state, 0).vitality.hp, 70);
});

test('periodic effects: advance freezes candidates and rechecks participation after nested callbacks', () => {
    const resources = new CombatResources();
    const trace = [];
    const child = resources.registerEffect(effectProgram('new-periodic-child'), {
        lifecycle: { advance: () => { trace.push('child'); } },
    });
    const later = resources.registerEffect(effectProgram('later-periodic'), {
        lifecycle: { advance: () => { trace.push('later'); } },
    });
    let parent;
    let laterRef;
    parent = resources.registerEffect(effectProgram('periodic-parent', () => ({ installed: false })), {
        lifecycle: { advance: context => {
            trace.push('parent');
            if (context.instance.state.installed) return;
            context.effects.update(context.ref, parent.ref, state => ({ ...state, installed: true }));
            context.effects.setEnabled(laterRef, false);
            context.effects.install(0, child.ref, { source: null, scopes: [] });
        } },
    });
    const state = effectFixtureWork(auraUnit(0), auraUnit(1));
    installNewEffect(state, 0, parent.ref, { source: null, scopes: [] }, resources, 0);
    laterRef = installNewEffect(state, 1, later.ref, { source: null, scopes: [] }, resources, 0).ref;
    advanceEffects(state, 0, resources);
    assert.deepEqual(trace, ['parent']);
    advanceEffects(state, 1, resources);
    assert.deepEqual(trace, ['parent', 'parent', 'child']);
});

test('periodic effects: disabled and overridden effects do not advance but still expire', () => {
    for (const inactive of ['disabled', 'overridden']) {
        const resources = new CombatResources();
        let calls = 0;
        const periodic = resources.registerEffect(effectProgram('inactive-periodic'), {
            lifecycle: { competition: () => ({ group: 'periodic', priority: 1 }),
                advance: () => { calls++; } },
        });
        const winner = resources.registerEffect(effectProgram('periodic-winner'), {
            lifecycle: { competition: () => ({ group: 'periodic', priority: 2 }) },
        });
        const state = effectFixtureWork(auraUnit(0));
        const ref = installNewEffect(state, 0, periodic.ref,
            { source: null, scopes: [{ type: 'TICK', tick: 2 }] }, resources, 0).ref;
        if (inactive === 'disabled') setEffectEnabled(state, ref, false, resources, 0);
        else installNewEffect(state, 0, winner.ref, { source: null, scopes: [] }, resources, 0);
        advanceEffects(state, 1, resources);
        expireEffects(state, 2, resources);
        assert.equal(calls, 0);
        assert.equal(getEffect(state, ref).finished, true);
    }
});

test('periodic effects: Runtime advances once per tick regardless of unit registration', () => {
    const resources = new CombatResources();
    let periodic;
    periodic = resources.registerEffect(effectProgram('runtime-periodic', () => ({ advances: 0 })), {
        lifecycle: {
            advance: context => {
                context.damage({ sourceUnitId: null, targetUnitId: 0,
                    damageType: 'TRUE', operands: createDamageOperands(10) });
                context.effects.update(context.ref, periodic.ref, state => ({ ...state, advances: state.advances + 1 }));
            },
        },
    });
    const runtime = new BattleRuntime(battleInput(seededPlacement(resources, periodic)), { combat: resources });
    const before = runtime.snapshot();
    assert.equal(before.units[0].vitality.hp, 100);
    assert.equal(before.units[0].effects.instances[0].state.advances, 0);
    runtime.step([{ type: 'APPEAR_PREDEFINED', definitionId: 7 }]);
    const after = runtime.snapshot();
    assert.equal(after.units[0].vitality.hp, 90);
    assert.equal(after.units[0].effects.instances[0].state.advances, 1);
    runtime.step();
    assert.equal(runtime.snapshot().units[0].vitality.hp, 80);
    assert.equal(runtime.snapshot().units[0].effects.instances[0].state.advances, 2);
});

test('periodic effects: a skill installs after the effect tick and starts advancing on the next tick', () => {
    const resources = new CombatResources();
    const trace = [];
    const periodic = resources.registerEffect(effectProgram('skill-periodic'), {
        lifecycle: { advance: context => { trace.push(context.tick); } },
    });
    const skill = createSkillDefinition({ id: 'periodic-skill', activation: 'MANUAL',
        spRecovery: 'TIME', spCost: 1, initialSp: 1, durationTicks: 10 });
    resources.skills.register({ definition: skill, activate: context => {
        const installed = context.effects.install(context.unitId, periodic.ref, {
            source: context.unitId,
            scopes: [{ type: 'SKILL', unitId: context.unitId, activationId: context.activationId }],
        });
        assert.equal(installed.type, 'INSTALLED');
        return { type: 'ACTIVATED' };
    } });
    const host = auraUnit(0, [0, 0], { skill });
    const runtime = new BattleRuntime(battleInput({ definition: host.definition, position: host.position }),
        { combat: resources });
    runtime.step([{ type: 'ACTIVATE_SKILL', unitId: 0 }]);
    assert.deepEqual(trace, []);
    assert.equal(runtime.snapshot().units[0].effects.instances[0].started, true);
    runtime.step();
    assert.deepEqual(trace, [1]);
});

test('periodic effects: failed time advancement rolls back damage and progress before retry', () => {
    const resources = new CombatResources();
    const failure = new Error('periodic fault');
    let fail = true;
    let periodic;
    periodic = resources.registerEffect(effectProgram('fallible-periodic', () => ({ advances: 0 })), {
        lifecycle: { advance: context => {
            context.damage({ sourceUnitId: null, targetUnitId: 0,
                damageType: 'TRUE', operands: createDamageOperands(10) });
            context.effects.update(context.ref, periodic.ref, state => ({ advances: state.advances + 1 }));
            if (fail) throw failure;
        } },
    });
    const runtime = new BattleRuntime(battleInput(seededPlacement(resources, periodic)), { combat: resources });
    const before = runtime.snapshot();
    assert.throws(() => runtime.step(), error => error === failure);
    assert.deepEqual(runtime.snapshot(), before);
    fail = false;
    runtime.step();
    assert.equal(runtime.snapshot().units[0].vitality.hp, 90);
    assert.equal(runtime.snapshot().units[0].effects.instances[0].state.advances, 1);
});
