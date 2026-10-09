import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { createCombatWork, getCombatUnit } from '../../dist/core/tactical/battle/execution/work.js';
import { finalizeFinishedEffects, finishEffects, installNewEffect, closeEffectLifetimes } from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { projectEffectLifetimes } from '../../dist/core/tactical/unit/capability/effects/lifetime-index.js';
import { createEffectProgram } from '../../dist/core/tactical/unit/capability/effects/program.js';
import { EffectDispatchScope } from '../../dist/core/tactical/unit/capability/effects/dispatch.js';
import { effectFixtureWork } from '../helpers/effects.js';

const owner = (id = 2) => ({ id, definition: { id: 'receiver' }, position: [0, 0] });
const input = { source: null, scopes: [] };
const program = id => createEffectProgram({ id, initialize: () => ({}), ownState: value => value });

function hostWork(unit) {
    return createCombatWork({
        effectLifetimes: projectEffectLifetimes([unit]),
        get unitIds() { assert.fail('local cleanup must not enumerate units'); },
        getUnit: id => id === unit.id ? unit : undefined,
        blockerOf: () => undefined, blockedBy: () => [],
    });
}

test('effect cleanup: absent hosts and hosts without finished instances retain their work', () => {
    const resources = new CombatResources();
    const work = hostWork(owner());
    assert.equal(finalizeFinishedEffects(work, 2, resources, 1), work);
    assert.equal(finalizeFinishedEffects(work, 99, resources, 1), work);
    const effect = resources.registerEffect(program('active'));
    const installed = installNewEffect(effectFixtureWork(owner()), 2, effect.ref, input, resources, 0);
    const local = hostWork(getCombatUnit(installed.work, 2));
    assert.equal(finalizeFinishedEffects(local, 2, resources, 1), local);
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
    let work = installNewEffect(effectFixtureWork(owner()), 2, leader.ref, input, resources, 0).work;
    work = installNewEffect(work, 2, follower.ref, input, resources, 0).work;
    const previous = getCombatUnit(work, 2);
    const finished = closeEffectLifetimes(hostWork(previous), [{ type: 'UNIT', unitId: 2 }], resources, 1);
    assert.equal(starts, 0);
    assert.ok(getCombatUnit(finished, 2).effects.instances.every(instance => instance.finished));
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
    const installed = installNewEffect(effectFixtureWork(owner()), 2, leader.ref, input, resources, 0);
    const finished = finishEffects(installed.work, [installed.result.ref], resources, 1);
    assert.deepEqual(getCombatUnit(finished, 2).effects.instances.map(instance => instance.finished), [true, false]);
    const cleaned = finalizeFinishedEffects(hostWork(getCombatUnit(finished, 2)), 2, resources, 1);
    assert.deepEqual(getCombatUnit(cleaned, 2).effects.instances.map(instance => instance.programRef), [replacement.ref]);
});

test('effect cleanup: a pending end notification prevents physical removal', () => {
    const resources = new CombatResources();
    const effect = resources.registerEffect(program('local'));
    const installed = installNewEffect(effectFixtureWork(owner()), 2, effect.ref, input, resources, 0);
    const finished = finishEffects(installed.work, [installed.result.ref], resources, 1);
    const local = hostWork(getCombatUnit(finished, 2));
    const dispatch = new EffectDispatchScope();
    dispatch.beginEnds([installed.result.ref]);
    assert.equal(finalizeFinishedEffects(local, 2, resources, 1, dispatch), local);
    dispatch.completeEnd(installed.result.ref);
    const cleaned = finalizeFinishedEffects(local, 2, resources, 1, dispatch);
    assert.deepEqual(getCombatUnit(cleaned, 2).effects.instances, []);
});
