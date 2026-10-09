import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import {
    appendCombatEvents,
    createCombatWork,
    getCombatUnit,
    removeCombatUnit,
    updateCombatUnit,
    updateCombatUnits,
    withCombatExecution,
} from '../../dist/core/tactical/battle/execution/work.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { createEffectProgram } from '../../dist/core/tactical/unit/capability/effects/program.js';
import {
    bindEffectLifetime,
    finalizeEffect,
    finishEffects,
    closeEffectLifetimes,
    installNewEffect,
} from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import {
    effectDependents,
} from '../../dist/core/tactical/unit/capability/effects/lifetime-index.js';
import {
    acceptActionExecution,
    cancelActionExecution,
    createActionExecutionState,
} from '../../dist/core/tactical/unit/capability/action/process.js';
import { createActionDefinition } from '../../dist/core/tactical/unit/capability/action/capability.js';
import { getEffect } from '../../dist/core/tactical/unit/capability/effects/query.js';

import { ActionExecutionWork } from '../../dist/core/tactical/unit/capability/action/internal/executions.js';

const scope = executionId => ({ type: 'ACTION', executionId });

const input = lifetime => ({ source: 0, scopes: lifetime === null ? [] : [lifetime] });
const unit = id => initializeUnit({ id, definition: { id: `receiver-${id}` }, position: [id, 0] });
const program = id => createEffectProgram({
    id,
    initialize: () => ({}),
    ownState: value => value,
});

function actionDefinition() {
    return createActionDefinition({
        triggerBindingId: 'primary', baseAttackTimeTicks: 1, recoveryTicks: 0,
        targetGroups: [{
            id: 'primary',
            targeting: {
                type: 'DAMAGE', scope: { type: 'BLOCKER' }, maxTargets: 1,
                canTargetAir: true, includeBlockingRelations: false, preferBlockingRelations: false,
                ignoreTargetFree: false, ignoreInvisible: false,
            },
            operations: [{ type: 'DAMAGE', power: 1, damageType: 'TRUE' }],
        }],
        followUps: [],
    });
}

function actionWork() {
    let state = createActionExecutionState();
    const definition = actionDefinition();
    for (let id = 0; id < 6; id++) {
        state = acceptActionExecution(state, {
            sourceUnitId: 0, definition, inputTargetUnitId: null,
            bindings: new Map(), tick: 0,
        }).state;
    }
    return new ActionExecutionWork(state);
}

function host(...units) {
    const byId = new Map(units.map(value => [value.id, value]));
    let membershipReads = 0;
    let rejectMembership = false;
    const battlefield = {
        get unitIds() {
            membershipReads++;
            assert.equal(rejectMembership, false, 'cached cleanup must not rescan battlefield');
            return [...byId.keys()];
        },
        getUnit: id => byId.get(id),
        blockerOf: () => undefined,
        blockedBy: () => [],
    };
    return {
        battlefield,
        byId,
        work: createCombatWork(battlefield, undefined, undefined, actionWork()),
        reads: () => membershipReads,
        forbidMembership: () => { rejectMembership = true; },
    };
}

function install(work, resources, ref, receiver, lifetime = null) {
    const installed = installNewEffect(work, receiver, ref, input(lifetime), resources, 0);
    assert.equal(installed.result.type, 'INSTALLED');
    return { work: installed.work, address: installed.result.ref };
}

test('effect lifetime index: foreign receivers are ordered by receiver then instance identity', () => {
    const resources = new CombatResources();
    const effect = resources.registerEffect(program('ordered'));
    let work = host(unit(9), unit(0), unit(2)).work;
    const addresses = [];
    for (const receiver of [9, 2, 9, 2]) {
        const installed = install(work, resources, effect.ref, receiver, scope(3));
        work = installed.work;
        addresses.push(installed.address);
    }
    const unitOwned = install(work, resources, effect.ref, 2, { type: 'UNIT', unitId: 0 });
    const foreignOwner = install(unitOwned.work, resources, effect.ref, 9, {
        type: 'ACTION', executionId: 5,
    });
    work = foreignOwner.work;

    assert.deepEqual(effectDependents(work, scope(3)), [
        addresses[1], addresses[3], addresses[0], addresses[2],
    ]);
    assert.deepEqual(effectDependents(work, { type: 'UNIT', unitId: 0 }), [
        unitOwned.address,
    ]);
    assert.deepEqual(effectDependents(work, scope(5)), [foreignOwner.address]);
    assert.deepEqual(effectDependents(work, scope(99)), []);
});

test('effect lifetime index: ordinary Unit and event updates reuse the projection without a world scan', () => {
    const resources = new CombatResources();
    const effect = resources.registerEffect(program('stable'));
    const fixture = host(unit(0), unit(2), unit(9));
    let { work, address } = install(fixture.work, resources, effect.ref, 9, scope(3));
    assert.deepEqual(effectDependents(work, scope(3)), [address]);
    const reads = fixture.reads();
    fixture.forbidMembership();

    for (let tick = 0; tick < 30; tick++) {
        work = updateCombatUnit(work, { ...getCombatUnit(work, 2), position: [tick, 0] });
        work = updateCombatUnit(work, { ...getCombatUnit(work, 9), position: [tick, 1] });
        work = appendCombatEvents(work, [{ type: 'ACTION', sourceUnitId: 0, targetUnitId: 9, tick }]);
        work = withCombatExecution(work, { ...work.execution, nextUnitId: tick + 10 });
        assert.deepEqual(effectDependents(work, scope(3)), [address]);
        assert.equal(closeEffectLifetimes(work, [scope(tick + 10)], resources, tick), work);
    }

    assert.equal(fixture.reads(), reads);
});

test('effect lifetime index: lazy construction sees earlier overlay installs and removals', () => {
    const resources = new CombatResources();
    const effect = resources.registerEffect(program('lazy'));
    const first = install(host(unit(0), unit(2), unit(9)).work, resources, effect.ref, 2, scope(3));
    const second = install(first.work, resources, effect.ref, 9, scope(3));
    const work = removeCombatUnit(second.work, 2);

    assert.deepEqual(effectDependents(work, scope(3)), [second.address]);
});

test('effect lifetime index: immutable branches and removal preserve previous candidates', () => {
    const resources = new CombatResources();
    const effect = resources.registerEffect(program('branch'));
    const installed = install(host(unit(0), unit(2), unit(9)).work, resources, effect.ref, 2, scope(3));
    const original = installed.work;
    const captured = effectDependents(original, scope(3));
    const other = install(original, resources, effect.ref, 9, scope(3));
    const removed = removeCombatUnit(other.work, 2);
    const restored = updateCombatUnit(removed, getCombatUnit(original, 2));

    assert.deepEqual(captured, [installed.address]);
    assert.ok(Object.isFrozen(captured));
    assert.ok(Object.isFrozen(captured[0]));
    assert.deepEqual(effectDependents(original, scope(3)), captured);
    assert.deepEqual(effectDependents(other.work, scope(3)), [installed.address, other.address]);
    assert.deepEqual(effectDependents(removed, scope(3)), [other.address]);
    assert.deepEqual(effectDependents(restored, scope(3)), [installed.address, other.address]);
});

test('effect lifetime index: a fresh Work sees changes behind the same mutable battlefield view', () => {
    const resources = new CombatResources();
    const effect = resources.registerEffect(program('phase'));
    const fixture = host(unit(0), unit(2));
    assert.deepEqual(effectDependents(fixture.work, scope(3)), []);
    const installed = install(fixture.work, resources, effect.ref, 2, scope(3));
    fixture.byId.set(2, getCombatUnit(installed.work, 2));
    const nextPhase = createCombatWork(fixture.battlefield, undefined, undefined, fixture.work.actionExecutions);

    assert.deepEqual(effectDependents(nextPhase, scope(3)), [installed.address]);
});

test('effect lifetime index: parent attachment, finish and finalization track other receivers', () => {
    const resources = new CombatResources();
    const disabled = [];
    const effect = resources.registerEffect(program('tree'), {
        lifecycle: { disable: context => { disabled.push(context.ref); } },
    });
    const parent = install(host(unit(0), unit(2), unit(9)).work, resources, effect.ref, 9, scope(3));
    const child = install(parent.work, resources, effect.ref, 2);
    assert.deepEqual(effectDependents(child.work, parent.address), []);
    const attached = bindEffectLifetime(child.work, child.address, parent.address);
    assert.equal(attached.result.type, 'BOUND');
    assert.deepEqual(effectDependents(attached.work, parent.address), [child.address]);
    const finished = closeEffectLifetimes(attached.work, [scope(3)], resources, 1);

    assert.deepEqual(disabled, [parent.address, child.address]);
    assert.equal(getEffect(finished, parent.address).finished, true);
    assert.equal(getEffect(finished, child.address).finished, true);
    const finalized = finalizeEffect(finished, child.address, resources, 1);
    assert.deepEqual(effectDependents(finalized, parent.address), []);
    assert.deepEqual(effectDependents(attached.work, parent.address), [child.address]);
});

test('effect lifetime index: nested finalization rechecks frozen candidates and exposes new identities to later queries', () => {
    const resources = new CombatResources();
    const trace = [];
    let followerAddress;
    let newbornAddress;
    const newborn = resources.registerEffect(program('newborn'), {
        lifecycle: { disable: () => { trace.push('newborn'); } },
    });
    const leader = resources.registerEffect(program('leader'), {
        lifecycle: {
            disable: context => {
                trace.push('leader');
                context.effects.finish([followerAddress]);
                const installed = context.effects.install(9, newborn.ref, input(null));
                assert.equal(installed.type, 'INSTALLED');
                newbornAddress = installed.ref;
            },
        },
    });
    const follower = resources.registerEffect(program('follower'), {
        lifecycle: {
            disable: () => { trace.push('follower'); },
            finalize: () => { trace.push('follower-finalized'); },
        },
    });
    const first = install(host(unit(0), unit(2), unit(9)).work, resources, leader.ref, 2, scope(3));
    const second = install(first.work, resources, follower.ref, 9, scope(3));
    followerAddress = second.address;
    const captured = effectDependents(second.work, scope(3));
    const finished = closeEffectLifetimes(second.work, [scope(3)], resources, 1);

    assert.deepEqual(trace, ['leader', 'follower']);
    assert.deepEqual(captured, [first.address, followerAddress]);
    assert.equal(getEffect(finished, followerAddress).finished, true);
    assert.equal(getEffect(finished, newbornAddress).finished, false);
    assert.deepEqual(effectDependents(finished, scope(3)), []);
    const settled = finalizeEffect(finished, followerAddress, resources, 1);
    assert.equal(getEffect(settled, followerAddress), undefined);
    const next = finishEffects(settled, [newbornAddress], resources, 2);
    assert.deepEqual(trace, ['leader', 'follower', 'follower-finalized', 'newborn']);
    assert.equal(getEffect(next, newbornAddress).finished, true);
});

test('effect lifetime index: Action cancellation finishes execution-owned effects on other receivers', () => {
    const resources = new CombatResources();
    const effect = resources.registerEffect(program('cancel'));
    const definition = actionDefinition();
    const accepted = acceptActionExecution(createActionExecutionState(), {
        sourceUnitId: 0, definition, inputTargetUnitId: 9,
        bindings: new Map([['primary', [9]]]), tick: 0,
    });
    const fixture = host(unit(0), unit(9));
    const initial = { ...fixture.work, actionExecutions: new ActionExecutionWork(accepted.state) };
    const installed = install(initial, resources, effect.ref, 9, scope(accepted.execution.id));
    effectDependents(installed.work, scope(accepted.execution.id));
    const cancelled = cancelActionExecution(
      installed.work,
      accepted.state,
      { executionId: accepted.execution.id, tick: 1 },
      resources,
    );

    assert.equal(cancelled.result.type, 'CANCELLED');
    assert.deepEqual(cancelled.state.executions, []);
    assert.equal(getEffect(cancelled.work, installed.address).finished, true);
});

test('effect lifetime index: a failed working branch leaves the previous scope and parent projection intact', () => {
    const resources = new CombatResources();
    const leader = resources.registerEffect(program('throws'), {
        lifecycle: { disable: () => { throw new Error('abort'); } },
    });
    const installed = install(host(unit(0), unit(2)).work, resources, leader.ref, 2, scope(3));
    const original = installed.work;
    const before = effectDependents(original, scope(3));

    assert.throws(() => finishEffects(original, [installed.address], resources, 1), /abort/);
    assert.deepEqual(effectDependents(original, scope(3)), before);
    assert.equal(getEffect(original, installed.address).finished, false);
});


test('effect lifetime index: batch updates share unchanged relations without rescanning', () => {
    const resources = new CombatResources();
    const effect = resources.registerEffect(program('batch-stable'));
    const fixture = host(unit(0), unit(2), unit(9));
    const installed = install(fixture.work, resources, effect.ref, 9, scope(3));
    const before = installed.work;
    const addresses = effectDependents(before, scope(3));
    fixture.forbidMembership();
    const next = updateCombatUnits(before, [
        { ...getCombatUnit(before, 2), position: [4, 5] },
        { ...getCombatUnit(before, 9), position: [6, 7] },
    ]);

    assert.deepEqual(effectDependents(next, scope(3)), addresses);
    assert.deepEqual(effectDependents(before, scope(3)), addresses);
    assert.deepEqual(getCombatUnit(before, 2).position, [2, 0]);
    assert.deepEqual(getCombatUnit(next, 2).position, [4, 5]);
});

test('effect lifetime index: batch relation edits and repeated receiver IDs preserve independent projections', () => {
    const resources = new CombatResources();
    const effect = resources.registerEffect(program('batch-relations'));
    const fixture = host(unit(0), unit(2), unit(9));
    const parent = install(fixture.work, resources, effect.ref, 0);
    const otherParent = install(parent.work, resources, effect.ref, 0);
    const first = install(otherParent.work, resources, effect.ref, 2, scope(3));
    const second = install(first.work, resources, effect.ref, 9, scope(3));
    const attachedFirst = bindEffectLifetime(second.work, first.address, parent.address);
    const attachedSecond = bindEffectLifetime(attachedFirst.work, second.address, parent.address);
    const before = attachedSecond.work;
    assert.deepEqual(effectDependents(before, scope(3)), [first.address, second.address]);
    assert.deepEqual(effectDependents(before, parent.address), [first.address, second.address]);
    fixture.forbidMembership();

    const change = (receiver, lifetime, parentAddress) => ({
        ...receiver,
        effects: {
            ...receiver.effects,
            instances: receiver.effects.instances.map(instance => ({
                ...instance, scopes: [lifetime, ...(parentAddress === null ? [] : [parentAddress])],
            })),
        },
    });
    const firstReceiver = getCombatUnit(before, 2);
    const secondReceiver = getCombatUnit(before, 9);
    const firstMoved = change(firstReceiver, scope(4), otherParent.address);
    const secondMoved = change(secondReceiver, scope(4), otherParent.address);
    const firstRestored = change(firstReceiver, scope(3), null);
    const next = updateCombatUnits(before, [firstMoved, secondMoved, firstRestored]);

    assert.deepEqual(effectDependents(next, scope(3)), [first.address]);
    assert.deepEqual(effectDependents(next, scope(4)), [second.address]);
    assert.deepEqual(effectDependents(next, parent.address), []);
    assert.deepEqual(effectDependents(next, otherParent.address), [second.address]);
    assert.deepEqual(effectDependents(before, scope(3)), [first.address, second.address]);
    assert.deepEqual(effectDependents(before, scope(4)), []);
    assert.deepEqual(effectDependents(before, parent.address), [first.address, second.address]);
    assert.deepEqual(effectDependents(before, otherParent.address), []);
});
