import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { battlefieldView, getUnit, registerUnit, updateUnit } from '../../dist/core/tactical/battle/execution/context.js';
import { removeUnitWithEffects } from '../../dist/core/tactical/battle/execution/unit-lifecycle.js';
import { createDamageOperands } from '../../dist/core/tactical/unit/capability/vitality/damage/contract.js';
import { getEffect } from '../../dist/core/tactical/unit/capability/effects/query.js';
import { finishEffects, installNewEffect, reconcileEffects, setEffectEnabled } from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { resolveAttackPower } from '../../dist/core/tactical/unit/capability/offense/query.js';
import { createSkillDefinition } from '../../dist/core/tactical/unit/capability/skill/capability.js';
import { activateSkill, finishSkill } from '../../dist/core/tactical/unit/capability/skill/execution.js';
import { effectFixtureWork } from '../helpers/effects.js';
import { attackEffect, auraUnit, effectProgram, registerAura } from '../helpers/aura.js';

const install = (state, resources, unitId, effect, scopes = []) => installNewEffect(state, unitId,
    effect.ref, { source: unitId, scopes }, resources, 0).ref;
const power = (state, id, resources) => resolveAttackPower(id, battlefieldView(state), resources.computations);

test('aura effects: selection reuses targeting and entered members are not retried after rejection or buff ending', () => {
    const resources = new CombatResources();
    const attempts = [];
    const receiver = attackEffect(resources, 'membership-receiver', {
        lifecycle: { accepts: context => { attempts.push(context.unitId); return context.unitId !== 1; } },
    });
    const aura = registerAura(resources, receiver, { accepts: target => target.position[0] < 2 });
    const state = effectFixtureWork(auraUnit(0), auraUnit(1, [1, 0]), auraUnit(2, [3, 0]));
    const ref = install(state, resources, 0, aura);
    reconcileEffects(state, 0, resources);
    assert.deepEqual(attempts, [1]);
    assert.deepEqual(getEffect(state, ref).state.bindings, [{ unitId: 1, refs: [] }]);

    updateUnit(state, { ...getUnit(state, 2), position: [1.5, 0] });
    reconcileEffects(state, 1, resources);
    const child = getEffect(state, ref).state.bindings.find(binding => binding.unitId === 2).refs[0];
    assert.equal(power(state, 2, resources), 120);
    finishEffects(state, [child], resources, 1);
    for (let tick = 2; tick < 5; tick++) reconcileEffects(state, tick, resources);
    assert.deepEqual(attempts, [1, 2]);
    assert.equal(power(state, 2, resources), 100);
    assert.deepEqual(getEffect(state, ref).state.bindings.map(binding => binding.unitId), [1, 2]);
});

test('aura effects: leaving ends the bound buff and reentry installs a new identity', () => {
    const resources = new CombatResources();
    const receiver = attackEffect(resources, 'range-receiver');
    const aura = registerAura(resources, receiver, { accepts: target => target.position[0] < 2 });
    const state = effectFixtureWork(auraUnit(0), auraUnit(1, [1, 0]));
    const ref = install(state, resources, 0, aura);
    const oldView = battlefieldView(state);
    const first = getEffect(state, ref).state.bindings[0].refs[0];
    updateUnit(state, { ...getUnit(state, 1), position: [3, 0] });
    reconcileEffects(state, 1, resources);
    assert.deepEqual(getEffect(state, ref).state.bindings, []);
    assert.equal(getEffect(state, first).finished, true);
    assert.equal(power(state, 1, resources), 100);
    updateUnit(state, { ...getUnit(state, 1), position: [1, 0] });
    reconcileEffects(state, 2, resources);
    const second = getEffect(state, ref).state.bindings[0].refs[0];
    assert.notDeepEqual(second, first);
    assert.equal(power(state, 1, resources), 120);
    assert.equal(oldView.getUnit(1).effects.instances[0].finished, false);
    assert.equal(oldView.getUnit(0).effects.instances[0].state.bindings[0].refs[0].effectId, first.effectId);
});

test('aura effects: host departure cascades bound children and keeps independently installed children', () => {
    for (const bindLifetime of [true, false]) {
        const resources = new CombatResources();
        const receiver = attackEffect(resources, 'departure-receiver');
        const aura = registerAura(resources, receiver, { bindLifetime });
        const state = effectFixtureWork(auraUnit(0), auraUnit(1));
        const ref = install(state, resources, 0, aura);
        const child = getEffect(state, ref).state.bindings[0].refs[0];
        removeUnitWithEffects(state, 0, 'RETREAT', resources, 1);
        assert.equal(getUnit(state, 0), undefined);
        assert.equal(getEffect(state, child).finished, bindLifetime);
        assert.equal(power(state, 1, resources), bindLifetime ? 100 : 120);
    }
});

test('aura effects: ordinary finish preserves sequential receiver decisions based on earlier callbacks', () => {
    const resources = new CombatResources();
    const trace = [];
    const marker = resources.registerEffect(effectProgram('retention-marker'));
    const receiver = attackEffect(resources, 'retention-receiver', {
        lifecycle: { finish: context => {
            trace.push(['finish', context.ref.unitId]);
            if (context.ref.unitId !== 1) return;
            assert.equal(context.battlefield.getUnit(0).effects.instances[0].finished, true);
            const installed = context.effects.install(2, marker.ref, { source: 1, scopes: [] });
            assert.equal(installed.type, 'INSTALLED');
            trace.push(['marker', installed.ref.unitId]);
        } },
    });
    let aura;
    aura = resources.registerEffect(effectProgram('retention-aura', () => ({ bindings: [] })), {
        lifecycle: {
            enable: context => {
                for (const unitId of [1, 2]) {
                    const installed = context.effects.install(unitId, receiver.ref, {
                        source: context.ref.unitId, scopes: [],
                    });
                    assert.equal(installed.type, 'INSTALLED');
                    context.effects.update(context.ref, aura.ref, state => ({
                        ...state, bindings: [...state.bindings, { unitId, ref: installed.ref }],
                    }));
                }
            },
            finish: context => {
                for (const binding of context.instance.state.bindings) {
                    const keep = context.facts.participating(binding.unitId)
                        .some(instance => instance.programRef === marker.ref);
                    assert.equal(context.battlefield.getUnit(binding.unitId).effects.instances
                        .some(instance => instance.programRef === marker.ref && instance.participating), keep);
                    trace.push(['decide', binding.unitId, keep]);
                    if (!keep) context.effects.finish([binding.ref], 'AURA_FINISHED');
                }
            },
        },
    });
    const state = effectFixtureWork(auraUnit(0), auraUnit(1), auraUnit(2));
    const ref = install(state, resources, 0, aura);
    const [first, second] = getEffect(state, ref).state.bindings.map(binding => binding.ref);
    assert.deepEqual(getEffect(state, first).scopes, []);
    assert.deepEqual(getEffect(state, second).scopes, []);
    const before = battlefieldView(state);
    finishEffects(state, [ref], resources, 1);
    assert.deepEqual(trace, [['decide', 1, false], ['finish', 1], ['marker', 2], ['decide', 2, true]]);
    assert.equal(getEffect(state, first).finished, true);
    assert.equal(getEffect(state, second).finished, false);
    assert.equal(getEffect(state, second).participating, true);
    assert.equal(power(state, 1, resources), 100);
    assert.equal(power(state, 2, resources), 120);
    assert.equal(before.getUnit(2).effects.instances.some(instance => instance.programRef === marker.ref), false);
});

test('aura effects: skill content installs an aura and skill completion closes its descendants', () => {
    const resources = new CombatResources();
    const receiver = attackEffect(resources, 'skill-receiver');
    const aura = registerAura(resources, receiver);
    const skill = createSkillDefinition({ id: 'aura-skill', activation: 'MANUAL',
        spRecovery: 'TIME', spCost: 1, initialSp: 1, durationTicks: 10 });
    resources.skills.register({ definition: skill, activate: context => {
        const installed = context.effects.install(context.unitId, aura.ref, { source: context.unitId,
            scopes: [{ type: 'SKILL', unitId: context.unitId, activationId: context.activationId }] });
        assert.equal(installed.type, 'INSTALLED');
        return { type: 'ACTIVATED' };
    } });
    const state = effectFixtureWork(auraUnit(0, [0, 0], { skill }), auraUnit(1));
    activateSkill(state, { unitId: 0, tick: 0 }, resources);
    assert.equal(power(state, 1, resources), 120);
    finishSkill(state, 0, 1, resources);
    assert.equal(getUnit(state, 0).effects.instances[0].finished, true);
    assert.equal(getUnit(state, 1).effects.instances[0].finished, true);
    assert.equal(power(state, 1, resources), 100);
});

test('aura effects: disable and competition suppress receivers without replacing registered identities', () => {
    const resources = new CombatResources();
    const receiver = attackEffect(resources, 'participation-receiver');
    const aura = registerAura(resources, receiver, { competition: () => ({ group: 'aura', priority: 1 }) });
    const winner = resources.registerEffect(effectProgram('aura-winner'), {
        lifecycle: { competition: () => ({ group: 'aura', priority: 2 }) },
    });
    const state = effectFixtureWork(auraUnit(0), auraUnit(1));
    const ref = install(state, resources, 0, aura);
    const binding = getEffect(state, ref).state.bindings[0];
    setEffectEnabled(state, ref, false, resources, 1);
    assert.equal(power(state, 1, resources), 100);
    setEffectEnabled(state, ref, true, resources, 1);
    const winnerRef = install(state, resources, 0, winner);
    assert.equal(getEffect(state, ref).enabled, true);
    assert.equal(getEffect(state, ref).participating, false);
    assert.equal(power(state, 1, resources), 100);
    finishEffects(state, [winnerRef], resources, 2);
    assert.equal(power(state, 1, resources), 120);
    assert.deepEqual(getEffect(state, ref).state.bindings[0], binding);
    assert.equal(getUnit(state, 1).effects.nextInstanceId, 1);
});

test('aura effects: resuming ends departed receivers before their enable callbacks can run', () => {
    const resources = new CombatResources();
    const enabled = [];
    const receiver = attackEffect(resources, 'resume-receiver', {
        lifecycle: { enable: context => { enabled.push(context.ref.unitId); } },
    });
    const aura = registerAura(resources, receiver, { accepts: target => target.position[0] < 2 });
    const state = effectFixtureWork(auraUnit(0), auraUnit(1, [1, 0]), auraUnit(2, [1, 0]));
    const ref = install(state, resources, 0, aura);
    const child = getEffect(state, ref).state.bindings.find(binding => binding.unitId === 1).refs[0];
    enabled.length = 0;
    setEffectEnabled(state, ref, false, resources, 1);
    updateUnit(state, { ...getUnit(state, 1), position: [3, 0] });
    reconcileEffects(state, 1, resources);
    setEffectEnabled(state, ref, true, resources, 2);
    assert.deepEqual(enabled, [2]);
    assert.equal(getEffect(state, child).finished, true);
    assert.deepEqual(getEffect(state, ref).state.bindings.map(binding => binding.unitId), [2]);
    assert.equal(power(state, 1, resources), 100);
    assert.equal(power(state, 2, resources), 120);
});

test('aura effects: nested receiver start can stop the aura without leaving active or later receivers', () => {
    const resources = new CombatResources();
    const starts = [];
    const receiver = attackEffect(resources, 'stopping-receiver', {
        lifecycle: { start: context => {
            starts.push(context.ref.unitId);
            context.effects.setEnabled(context.instance.scopes[0], false);
        } },
    });
    const aura = registerAura(resources, receiver);
    const state = effectFixtureWork(auraUnit(0), auraUnit(1), auraUnit(2));
    const ref = install(state, resources, 0, aura);
    const instance = getEffect(state, ref);
    assert.equal(instance.enabled, false);
    assert.equal(instance.participating, false);
    assert.deepEqual(starts, [1]);
    assert.deepEqual(instance.state.bindings.map(binding => binding.unitId), [1]);
    const child = getEffect(state, instance.state.bindings[0].refs[0]);
    assert.equal(child.enabled, false);
    assert.equal(child.participating, false);
    assert.equal(power(state, 1, resources), 100);
    assert.equal(getUnit(state, 2).effects, undefined);
    reconcileEffects(state, 1, resources);
    assert.deepEqual(starts, [1]);
});

test('aura effects: nested receiver start cannot revive its finished parent', () => {
    const resources = new CombatResources();
    const starts = [];
    const receiver = attackEffect(resources, 'ending-receiver', {
        lifecycle: { start: context => {
            starts.push(context.ref.unitId);
            context.effects.finish([context.instance.scopes[0]], 'NESTED_END');
        } },
    });
    const aura = registerAura(resources, receiver);
    const state = effectFixtureWork(auraUnit(0), auraUnit(1), auraUnit(2));
    const ref = installNewEffect(state, 0, aura.ref, { source: 0, scopes: [] }, resources, 0).ref;
    assert.equal(getEffect(state, ref).finished, true);
    assert.equal(getEffect(state, ref).participating, false);
    assert.deepEqual(starts, [1]);
    assert.equal(getUnit(state, 1).effects.instances[0].finished, true);
    assert.equal(power(state, 1, resources), 100);
    assert.equal(getUnit(state, 2).effects, undefined);
    reconcileEffects(state, 1, resources);
    assert.deepEqual(starts, [1]);
});

test('aura effects: nested installation reads current state and retains old battlefield snapshots', () => {
    const resources = new CombatResources();
    let captured;
    const observations = [];
    const receiver = attackEffect(resources, 'nested-receiver', { lifecycle: { start: context => {
        if (context.ref.unitId === 1) {
            captured = context.battlefield;
            assert.deepEqual(context.battlefield.getUnit(0).effects.instances[0].state.bindings,
                [{ unitId: 1, refs: [] }]);
            context.damage({ sourceUnitId: 0, targetUnitId: 2, damageType: 'TRUE', operands: createDamageOperands(30) });
            observations.push(context.battlefield.getUnit(2).vitality.hp);
        }
    } } });
    const aura = registerAura(resources, receiver, {
        initialState: (context, unitId) => ({ addition: 100 - context.battlefield.getUnit(unitId).vitality.hp }),
    });
    const state = effectFixtureWork(auraUnit(0), auraUnit(1), auraUnit(2));
    const ref = install(state, resources, 0, aura);
    assert.deepEqual(observations, [70]);
    assert.equal(getUnit(state, 2).effects.instances[0].state.addition, 30);
    assert.equal(power(state, 2, resources), 130);
    assert.equal(captured.getUnit(2).vitality.hp, 100);
    assert.deepEqual(captured.getUnit(0).effects.instances[0].state.bindings, [{ unitId: 1, refs: [] }]);
    registerUnit(state, auraUnit(3));
    reconcileEffects(state, 0, resources);
    assert.deepEqual(getEffect(state, ref).state.bindings.map(binding => binding.unitId), [1, 2, 3]);
    assert.equal(captured.unitIds.includes(3), false);
});
