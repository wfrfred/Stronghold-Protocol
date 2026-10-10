import { fixtureBattlefield } from "../helpers/battlefield.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { createBattleState, getUnit } from '../../dist/core/tactical/battle/execution/context.js';
import { removeUnitWithEffects } from '../../dist/core/tactical/battle/execution/unit-lifecycle.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { createEffectDefinition } from '../../dist/core/tactical/unit/capability/effects/definition.js';
import {
    bindEffectLifetime,
    closeEffectLifetimes,
    finishEffects,
    installNewEffect,
} from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { uniqueEffectAdmission } from '../../dist/core/tactical/unit/capability/effects/lifecycle-resources.js';
import { getEffect } from '../../dist/core/tactical/unit/capability/effects/query.js';
import { createActionDefinition } from '../../dist/core/tactical/unit/capability/action/capability.js';
import {
    acceptActionExecution,
    createActionExecutionState,
} from '../../dist/core/tactical/unit/capability/action/process.js';
import { ActionExecutionWork } from '../../dist/core/tactical/unit/capability/action/internal/executions.js';
import { createSkillDefinition } from '../../dist/core/tactical/unit/capability/skill/capability.js';
import { activateSkill } from '../../dist/core/tactical/unit/capability/skill/execution.js';
import { createDamageOperands } from '../../dist/core/tactical/unit/capability/vitality/damage/contract.js';
import { attack } from '../../dist/core/tactical/unit/capability/offense/contributions.js';
import { create as createModifier } from '../../dist/core/tactical/contribution/value.js';

function unit(id, definition = {}) {
    return initializeUnit({ id, position: [id, 0], definition: {
        id: `closing-unit-${id}`, vitality: { maxHp: 100 }, ...definition,
    } });
}

function workOf(units, actions) {
    const byId = new Map(units.map(current => [current.id, current]));
    return createBattleState(fixtureBattlefield({
        unitIds: [...byId.keys()],
        getUnit: id => byId.get(id),
        blockerOf: () => undefined,
        blockedBy: () => [],
    }), undefined, actions);
}

function program(resources, id, lifecycle = {}, facets = {}) {
    return resources.registerEffect(createEffectDefinition({
        id, initialize: () => ({}),
    }), { ...facets, lifecycle });
}

function install(work, resources, effect, unitId, scopes = [], initialState = {}, source = null) {
    const installed = installNewEffect(work, unitId, effect, {
        source, scopes, initialState,
    }, resources, 0);
    assert.equal(installed.type, 'INSTALLED');
    return { work: work, ref: installed.ref };
}

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

test('Effect close: overlapping roots and a cross-Unit diamond finish once in stable parent-before-dependent order', () => {
    const resources = new CombatResources();
    const notices = [];
    const refs = [];
    const effect = program(resources, 'diamond', {
        finish: context => {
            assert.equal(refs.every(ref => context.facts.getEffect(ref).finished), true);
            assert.equal(refs.every(ref => !context.facts.getEffect(ref).participating), true);
            assert.equal([0, 1, 2].every(unitId => context.facts.getUnit(unitId).offense.attack.entries.every(entry => !entry.participating)), true);
            notices.push({ name: context.instance.state.name, end: context.end });
        },
    }, { contributions: [attack(() => [createModifier({ finalAddition: 10 })])] });
    let work = workOf([0, 1, 2].map(id => unit(id, { offense: { attack: 100 } })));
    const add = (name, unitId, scopes = []) => {
        const installed = install(work, resources, effect, unitId, scopes, { name });
        work = installed.work;
        refs.push(installed.ref);
        return installed.ref;
    };
    const a = add('A', 2);
    const b = add('B', 0);
    const left = add('left', 1, [a]);
    const right = add('right', 0, [a]);
    const diamond = add('diamond', 1, [left, right, b]);
    add('leaf', 2, [diamond]);
    const initialParent = getEffect(work, a);
    const finished = work;
    finishEffects(finished, [a, b, a], resources, 1, 'DISPELLED');

    assert.deepEqual(notices.map(notice => notice.name), ['B', 'A', 'right', 'left', 'diamond', 'leaf']);
    assert.deepEqual(notices.map(notice => notice.end), [
        { root: b, reason: 'DISPELLED' },
        { root: a, reason: 'DISPELLED' },
        { root: a, reason: 'DISPELLED' },
        { root: a, reason: 'DISPELLED' },
        { root: b, reason: 'DISPELLED' },
        { root: b, reason: 'DISPELLED' },
    ]);
    finishEffects(finished, refs, resources, 2, 'OTHER');
    assert.equal(notices.length, refs.length);
    assert.equal(initialParent.finished, false);
});

test('Effect close: the first termination retains its root and reason across later overlapping closures', () => {
    const resources = new CombatResources();
    const notices = [];
    const effect = program(resources, 'first-reason', {
        finish: context => { notices.push([context.instance.state.name, context.end]); },
    });
    let work = workOf([unit(0), unit(1)]);
    const first = install(work, resources, effect, 0, [], { name: 'parent' });
    const child = install(first.work, resources, effect, 1, [first.ref, { type: 'UNIT', unitId: 0 }], { name: 'child' });
    finishEffects(child.work, [first.ref], resources, 1, 'DISPELLED');
    closeEffectLifetimes(work, [{ type: 'UNIT', unitId: 0 }], resources, 2, 'RETREAT');

    assert.deepEqual(notices, [
        ['parent', { root: first.ref, reason: 'DISPELLED' }],
        ['child', { root: first.ref, reason: 'DISPELLED' }],
    ]);
    assert.equal(getEffect(work, child.ref).finished, true);
});

test('Effect close: one host competition pass recovers an independent survivor without enabling ending competitors', () => {
    const resources = new CombatResources();
    let competitions = 0;
    const enabled = [];
    const disabled = [];
    const effect = program(resources, 'competition-batch', {
        competition: instance => {
            competitions++;
            return { group: 'same-host', priority: instance.state.priority };
        },
        enable: context => { enabled.push(context.instance.state.priority); },
        disable: context => { disabled.push(context.instance.state.priority); },
    });
    let work = workOf([unit(0)]);
    const roots = [];
    for (let priority = 1; priority <= 40; priority++) {
        const installed = install(work, resources, effect, 0, [], { priority });
        work = installed.work;
        roots.push(installed.ref);
    }
    const independent = install(work, resources, effect, 0, [], { priority: 0 });
    work = independent.work;
    competitions = 0;
    enabled.length = 0;
    disabled.length = 0;
    const finished = work;
    finishEffects(finished, roots, resources, 1, 'DISPELLED');

    assert.equal(competitions, 1);
    assert.deepEqual(enabled, [0]);
    assert.deepEqual(disabled, [40]);
    assert.equal(getEffect(finished, independent.ref).participating, true);
    assert.equal(roots.every(ref => getEffect(finished, ref).finished), true);
});

test('Effect admission: an accepted instance blocks duplicate admission while its start callback is still running', () => {
    const resources = new CombatResources();
    let starts = 0;
    let nested;
    const effect = program(resources, 'unique-pending-start', {
        accepts: uniqueEffectAdmission('unique-pending-start'),
        start: context => {
            starts++;
            assert.equal(context.instance.started, false);
            assert.equal(context.instance.participating, false);
            nested = context.effects.install(0, effect, { source: null, scopes: [] });
            assert.equal(context.facts.getUnit(0).effects.nextInstanceId, 1);
        },
    });
    const original = workOf([unit(0)]);
    const accepted = install(original, resources, effect, 0);

    assert.deepEqual(nested, { type: 'REJECTED', reason: 'ADMISSION_REJECTED' });
    assert.equal(starts, 1);
    assert.equal(getUnit(accepted.work, 0).effects.instances.length, 1);
    assert.equal(getUnit(accepted.work, 0).effects.nextInstanceId, 1);
    assert.equal(accepted.work.execution.rngState, original.execution.rngState);
});

test('Effect admission: a start that ends its accepted instance returns ENDED and still runs its terminal business once', () => {
    const resources = new CombatResources();
    const notices = [];
    const effect = program(resources, 'start-ends-self', {
        start: context => { context.effects.finish([context.ref], 'SELF_ENDED'); },
        enable: () => { notices.push('enable'); },
        disable: () => { notices.push('disable'); },
        finish: context => { notices.push(context.end); },
    });
    const acceptedState = workOf([unit(0)]);
const accepted = installNewEffect(acceptedState, 0, effect, { source: null, scopes: [] }, resources, 0);

    assert.equal(accepted.type, 'ENDED');
    assert.deepEqual(notices, [{ root: accepted.ref, reason: 'SELF_ENDED' }]);
    assert.equal(getUnit(acceptedState, 0).effects.nextInstanceId, 1);
    assert.equal(getEffect(acceptedState, accepted.ref).finished, true);
});

test('Effect lifetimes: provenance survives source departure and the implicit host lifetime ends the Effect', () => {
    const resources = new CombatResources();
    const notices = [];
    const effect = program(resources, 'independent-provenance', {
        finish: context => { notices.push(context.end); },
    });
    const installed = install(workOf([unit(0), unit(1)]), resources, effect, 1, [], {}, 0);
    let work = installed.work;
removeUnitWithEffects(work, 0, 'RETREAT', resources, 1);
    assert.equal(getEffect(work, installed.ref).finished, false);
    assert.equal(getEffect(work, installed.ref).source, 0);
    assert.deepEqual(notices, []);
    removeUnitWithEffects(work, 1, 'DEATH', resources, 2);

    assert.equal(getUnit(work, 1), undefined);
    assert.deepEqual(notices, [{ root: { type: 'UNIT', unitId: 1 }, reason: 'DEATH' }]);
});

test('Effect closing: departing Unit, Skill, Action and Effect scopes reject before start while independent remote Effects remain admissible', () => {
    const resources = new CombatResources();
    const skill = createSkillDefinition({
        id: 'closing-skill', activation: 'MANUAL', spRecovery: 'NONE',
        spCost: 0, initialSp: 0, durationTicks: null,
    });
    resources.skills.register({ definition: skill, activate: () => ({ type: 'ACTIVATED' }) });
    const accepted = acceptActionExecution(createActionExecutionState(), {
        sourceUnitId: 0, definition: actionDefinition(), inputTargetUnitId: 1,
        bindings: new Map([['primary', [1]]]), tick: 0,
    });
    const actions = new ActionExecutionWork(accepted.state);
    let starts = 0;
    const remote = program(resources, 'closing-remote', { start: () => { starts++; } });
    const installedRemote = install(workOf([unit(0, { skill }), unit(1)], actions), resources, remote, 1);
    let survivor = installedRemote.ref;
    let work = installedRemote.work;
activateSkill(work, { unitId: 0, tick: 0 }, resources);
    const activationId = getUnit(work, 0).skill.active.id;
    let independent;
    const checks = [];
    const trigger = program(resources, 'closing-trigger', {
        finish: context => {
            assert.deepEqual(context.end, { root: { type: 'UNIT', unitId: 0 }, reason: 'RETREAT' });
            assert.equal(context.facts.getUnit(0).skill.active, null);
            assert.equal(actions.get(accepted.execution.id), undefined);
            const before = context.facts.getUnit(1).effects;
            checks.push(context.effects.install(0, remote, { source: null, scopes: [] }));
            const unavailable = [
                { type: 'UNIT', unitId: 0 },
                { type: 'ACTION', executionId: accepted.execution.id },
                { type: 'SKILL', unitId: 0, activationId },
                context.ref,
            ];
            for (const scope of unavailable) {
                checks.push(context.effects.install(1, remote, { source: null, scopes: [scope] }));
                assert.deepEqual(context.effects.bind(survivor, scope), { type: 'LIFETIME_UNAVAILABLE' });
            }
            assert.equal(context.facts.getUnit(1).effects, before);
            independent = context.effects.install(1, remote, { source: 0, scopes: [] });
            assert.equal(independent.type, 'INSTALLED');
            assert.equal(context.facts.getEffect(independent.ref).source, 0);
        },
    });
    const installedTrigger = install(work, resources, trigger, 0);
    starts = 0;
    removeUnitWithEffects(installedTrigger.work, 0, 'RETREAT', resources, 1);

    assert.deepEqual(checks, [
        { type: 'REJECTED', reason: 'TARGET_CLOSING' },
        ...Array.from({ length: 4 }, () => ({ type: 'REJECTED', reason: 'LIFETIME_UNAVAILABLE' })),
    ]);
    assert.equal(starts, 1);
    assert.equal(getUnit(work, 0), undefined);
    assert.equal(getUnit(work, 1).effects.nextInstanceId, 2);
    assert.deepEqual(getEffect(work, survivor).scopes, []);
    assert.equal(getEffect(work, independent.ref).finished, false);
    assert.equal(work.events.filter(event => event.type === 'SKILL_FINISHED').length, 1);
    assert.equal(work.events.filter(event => event.type === 'ACTION_CANCELLED').length, 1);
    const late = bindEffectLifetime(work, survivor, installedTrigger.ref);
    assert.deepEqual(late, { type: 'LIFETIME_UNAVAILABLE' });

});

test('Effect closing: nested self-host death waits for pending terminal notices before physically removing the host', () => {
    const resources = new CombatResources();
    const trace = [];
    let a;
    let b;
    let c;
    const parent = program(resources, 'nested-host-A', {
        finish: context => {
            trace.push(['A-start', context.end]);
            context.damage({ sourceUnitId: null, targetUnitId: 0, damageType: 'TRUE', operands: createDamageOperands(100) });
            assert.notEqual(context.facts.getUnit(0), undefined);
            assert.equal(context.facts.getEffect(b).finished, true);
            assert.equal(context.facts.getEffect(c).finished, true);
            trace.push(['A-after', context.end]);
        },
    });
    const remaining = program(resources, 'nested-host-B', {
        finish: context => {
            assert.notEqual(context.facts.getUnit(0), undefined);
            assert.equal(context.facts.getEffect(a).finished, true);
            assert.equal(context.facts.getEffect(c).finished, true);
            trace.push(['B', context.end]);
        },
    });
    const child = program(resources, 'nested-host-C', {
        finish: context => {
            assert.notEqual(context.facts.getUnit(0), undefined);
            trace.push(['C', context.end]);
        },
    });
    const first = install(workOf([unit(0), unit(1)]), resources, parent, 0);
    a = first.ref;
    const second = install(first.work, resources, remaining, 0);
    b = second.ref;
    const third = install(second.work, resources, child, 1, [b]);
    c = third.ref;
    const finished = third.work;
    finishEffects(finished, [a], resources, 1, 'DISPELLED');

    assert.deepEqual(trace, [
        ['A-start', { root: a, reason: 'DISPELLED' }],
        ['B', { root: { type: 'UNIT', unitId: 0 }, reason: 'DEATH' }],
        ['C', { root: { type: 'UNIT', unitId: 0 }, reason: 'DEATH' }],
        ['A-after', { root: a, reason: 'DISPELLED' }],
    ]);
    assert.equal(getUnit(finished, 0), undefined);
    assert.equal(getEffect(finished, c).finished, true);
    finishEffects(finished, [a, b, c], resources, 2);
});

test('Effect closing: an inner finish cannot drain host removal while a remote dependent terminal callback is still active', () => {
    const resources = new CombatResources();
    const trace = [];
    const nested = program(resources, 'remote-nested-ending', {
        start: context => { context.effects.finish([context.ref], 'NESTED'); },
        finish: () => { trace.push('nested'); },
    });
    const parent = program(resources, 'remote-parent', {
        finish: context => {
            trace.push('parent');
            context.damage({ sourceUnitId: null, targetUnitId: 0, damageType: 'TRUE', operands: createDamageOperands(100) });
            assert.notEqual(context.facts.getUnit(0), undefined);
        },
    });
    const dependent = program(resources, 'remote-pending-notice', {
        finish: context => {
            trace.push('dependent-start');
            assert.notEqual(context.facts.getUnit(0), undefined);
            const ended = context.effects.install(1, nested, { source: null, scopes: [] });
            assert.equal(ended.type, 'ENDED');
            assert.notEqual(context.facts.getUnit(0), undefined);
            trace.push('dependent-end');
        },
    });
    const first = install(workOf([unit(0), unit(1)]), resources, parent, 0);
    const second = install(first.work, resources, dependent, 1, [first.ref]);
    const finished = second.work;
    finishEffects(finished, [first.ref], resources, 1, 'DISPELLED');

    assert.deepEqual(trace, ['parent', 'dependent-start', 'nested', 'dependent-end']);
    assert.equal(getUnit(finished, 0), undefined);
    assert.equal(getEffect(finished, second.ref).finished, true);
});
