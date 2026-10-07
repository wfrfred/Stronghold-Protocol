import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import {
    createCombatWork,
    getCombatUnit,
} from '../../dist/core/tactical/battle/execution/work.js';
import {
    finalizeFinishedEffects,
    finishEffect,
    installNewEffect,
} from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { createEffectProgram } from '../../dist/core/tactical/unit/capability/effects/program.js';
import { effectFixtureWork } from '../helpers/effects.js';

const owner = () => ({ id: 2, definition: { id: 'receiver' }, position: [0, 0] });
const input = { sourceUnitId: null, lifetimeOwner: null, expiresAtTick: null };
const program = id => createEffectProgram({
    id,
    initialize: () => ({}),
    ownState: value => value,
});

function hostWork(unit) {
    return createCombatWork({
        get unitIds() {
            assert.fail('host cleanup must not enumerate units');
        },
        getUnit: id => id === unit.id ? unit : undefined,
        blockerOf: () => undefined,
        blockedBy: () => [],
    });
}

test('effect cleanup: missing hosts and hosts without Effects require no membership query', () => {
    const resources = new CombatResources();
    const work = hostWork(owner());

    assert.equal(finalizeFinishedEffects(work, 2, resources, 1), work);
    assert.equal(finalizeFinishedEffects(work, 99, resources, 1), work);
});

test('effect cleanup: finished host instances are finalized without enumerating other units', () => {
    const resources = new CombatResources();
    const finalized = [];
    const effect = resources.registerEffect(program('local'), {
        lifecycle: {
            finalize: context => {
                finalized.push(context.address);
            },
        },
    });
    const installed = installNewEffect(effectFixtureWork(owner()), 2, effect.ref, input, resources, 0);
    assert.equal(installed.result.type, 'INSTALLED');
    const finished = finishEffect(installed.work, installed.result.address, resources, 1);
    const work = hostWork(getCombatUnit(finished, 2));
    const cleaned = finalizeFinishedEffects(work, 2, resources, 1);

    assert.deepEqual(finalized, [installed.result.address]);
    assert.deepEqual(getCombatUnit(cleaned, 2).effects.instances, []);
});

test('effect cleanup: captured identities recheck finished facts and exclude newly installed instances', () => {
    const resources = new CombatResources();
    const finalized = [];
    let followerAddress;
    let newbornAddress;
    const newborn = resources.registerEffect(program('newborn'), {
        lifecycle: {
            finalize: () => {
                finalized.push('newborn');
            },
        },
    });
    const leader = resources.registerEffect(program('leader'), {
        lifecycle: {
            finalize: context => {
                finalized.push('leader');
                const installed = context.effects.install(2, newborn.ref, input);
                assert.equal(installed.type, 'INSTALLED');
                newbornAddress = installed.address;
                context.effects.finish(newbornAddress);
                context.effects.finish(followerAddress);
            },
        },
    });
    const follower = resources.registerEffect(program('follower'), {
        lifecycle: {
            finalize: () => {
                finalized.push('follower');
            },
        },
    });
    const first = installNewEffect(effectFixtureWork(owner()), 2, leader.ref, input, resources, 0);
    const second = installNewEffect(first.work, 2, follower.ref, input, resources, 0);
    assert.equal(first.result.type, 'INSTALLED');
    assert.equal(second.result.type, 'INSTALLED');
    followerAddress = second.result.address;
    const finished = finishEffect(second.work, first.result.address, resources, 1);
    assert.equal(getCombatUnit(finished, 2).effects.instances[1].finished, false);

    const cleaned = finalizeFinishedEffects(finished, 2, resources, 1);
    const remaining = getCombatUnit(cleaned, 2).effects.instances;

    assert.deepEqual(finalized, ['leader', 'follower']);
    assert.deepEqual(remaining.map(instance => instance.id), [newbornAddress.instanceId]);
    assert.equal(remaining[0].finished, true);
    const next = finalizeFinishedEffects(cleaned, 2, resources, 1);

    assert.deepEqual(finalized, ['leader', 'follower', 'newborn']);
    assert.deepEqual(getCombatUnit(next, 2).effects.instances, []);
});
