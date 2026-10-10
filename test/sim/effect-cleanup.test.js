import { fixtureBattlefield } from "../helpers/battlefield.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { createBattleState, getUnit } from '../../dist/core/tactical/battle/execution/context.js';
import { finalizeFinishedEffects, finishEffects, installNewEffect, closeEffectLifetimes } from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { projectEffectLifetimes } from '../../dist/core/tactical/unit/capability/effects/lifetime-index.js';
import { createEffectProgram } from '../../dist/core/tactical/unit/capability/effects/program.js';
import { EffectDispatchScope } from '../../dist/core/tactical/unit/capability/effects/dispatch.js';
import { effectFixtureWork } from '../helpers/effects.js';

const owner = (id = 2) => ({ id, definition: { id: 'receiver' }, position: [0, 0] });
const input = { source: null, scopes: [] };
const program = id => createEffectProgram({ id, initialize: () => ({}) });

function hostWork(unit) {
    return createBattleState(fixtureBattlefield([unit]));
}

test('effect cleanup: absent hosts and hosts without finished instances retain their work', () => {
    const resources = new CombatResources();
    const work = hostWork(owner());
    finalizeFinishedEffects(work, 2, resources, 1);
    finalizeFinishedEffects(work, 99, resources, 1);
    const effect = resources.registerEffect(program('active'));
    const installedState = effectFixtureWork(owner());
const installed = installNewEffect(installedState, 2, effect.ref, input, resources, 0);
    const local = hostWork(getUnit(installedState, 2));
    finalizeFinishedEffects(local, 2, resources, 1);
});

test('effect cleanup: closing a host rejects reentrant installation before start', () => {
    const resources = new CombatResources();
    let starts = 0;
    const newborn = resources.registerEffect(program('newborn'), { lifecycle: { start: () => { starts++; } } });
    const leader = resources.registerEffect(program('leader'), {
        lifecycle: { disable: context => {
            assert.equal(context.instance.finished, true);
            const rejected = context.effects.install(2, newborn.ref, input);
            assert.deepEqual(rejected, { type: 'REJECTED', reason: 'TARGET_CLOSING' });
            assert.equal(context.facts.getEffect(context.ref).finished, true);
        } },
    });
    const follower = resources.registerEffect(program('follower'));
    let work = effectFixtureWork(owner());
    installNewEffect(work, 2, leader.ref, input, resources, 0);
    installNewEffect(work, 2, follower.ref, input, resources, 0);
    const previous = getUnit(work, 2);
    const finished = hostWork(previous);
    closeEffectLifetimes(finished, [{ type: 'UNIT', unitId: 2 }], resources, 1);
    assert.equal(starts, 0);
    assert.ok(getUnit(finished, 2).effects.instances.every(instance => instance.finished));
    assert.ok(previous.effects.instances.every(instance => !instance.finished));
});

test('effect cleanup: explicit ending permits independent replacement while pending notices retain finished facts', () => {
    const resources = new CombatResources();
    const replacement = resources.registerEffect(program('replacement'));
    const leader = resources.registerEffect(program('leader'), {
        lifecycle: { disable: context => {
            assert.equal(context.effects.install(2, replacement.ref, input).type, 'INSTALLED');
            assert.equal(context.facts.getEffect(context.ref).finished, true);
        } },
    });
    const installedState = effectFixtureWork(owner());
const installed = installNewEffect(installedState, 2, leader.ref, input, resources, 0);
    const finished = installedState;
    finishEffects(finished, [installed.ref], resources, 1);
    assert.deepEqual(getUnit(finished, 2).effects.instances.map(instance => instance.finished), [true, false]);
    const cleaned = hostWork(getUnit(finished, 2));
    finalizeFinishedEffects(cleaned, 2, resources, 1);
    assert.deepEqual(getUnit(cleaned, 2).effects.instances.map(instance => instance.programRef), [replacement.ref]);
});

test('effect cleanup: a pending end notification prevents physical removal', () => {
    const resources = new CombatResources();
    const effect = resources.registerEffect(program('local'));
    const installedState = effectFixtureWork(owner());
const installed = installNewEffect(installedState, 2, effect.ref, input, resources, 0);
    const finished = installedState;
    finishEffects(finished, [installed.ref], resources, 1);
    const local = hostWork(getUnit(finished, 2));
    const dispatch = new EffectDispatchScope();
    dispatch.beginEnds([installed.ref]);
    finalizeFinishedEffects(local, 2, resources, 1, dispatch);
    dispatch.completeEnd(installed.ref);
    const cleaned = local;
    finalizeFinishedEffects(cleaned, 2, resources, 1, dispatch);
    assert.deepEqual(getUnit(cleaned, 2).effects.instances, []);
});

test('effect cleanup: a host removes terminal instances as one array before binding cleanup and runs no lifecycle business', () => {
    const resources = new CombatResources();
    const arrays = [];
    const effect = resources.registerEffect(program('bulk-cleanup'), { bindings: [{
        install: unit => unit,
        update: unit => unit,
        setParticipation: unit => unit,
        remove: unit => { arrays.push(unit.effects.instances); return unit; },
    }] });
    let work = effectFixtureWork(owner());
    const roots = [];
    for (let index = 0; index < 64; index++) {
        const installed = installNewEffect(work, 2, effect.ref, input, resources, 0);

        roots.push(installed.ref);
    }
    finishEffects(work, roots, resources, 1);
    const services = {
        effectBindings: resources.effectBindings,
        effectLifecycle: { get: () => { assert.fail('physical cleanup cannot dispatch lifecycle business'); } },
    };
    const cleaned = work;
    finalizeFinishedEffects(cleaned, 2, services, 1);
    assert.equal(arrays.length, 64);
    assert.equal(new Set(arrays).size, 1);
    assert.deepEqual(arrays[0], []);
    assert.equal(getUnit(cleaned, 2).effects.instances, arrays[0]);
    assert.equal(getUnit(work, 2).effects.instances.length, 0);
});
