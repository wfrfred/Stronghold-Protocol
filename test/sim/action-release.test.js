import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceRegistration } from '../../dist/core/common/resource-registration.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { getUnit } from '../../dist/core/tactical/battle/execution/context.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { createActionDefinition } from '../../dist/core/tactical/unit/capability/action/capability.js';
import { ActionReleaseResources, beforeActionRelease } from '../../dist/core/tactical/unit/capability/action/release.js';
import { createEffectDefinition } from '../../dist/core/tactical/unit/capability/effects/definition.js';
import { setEffectEnabled } from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { effectFixtureWork, installFixtureEffect } from '../helpers/effects.js';

const action = createActionDefinition({
  triggerBindingId: 'primary', baseAttackTimeTicks: 30, recoveryTicks: 0,
  targetGroups: [{ id: 'primary', targeting: {
    type: 'DAMAGE', scope: { type: 'BLOCKER' }, canTargetAir: true,
    includeBlockingRelations: false, preferBlockingRelations: false,
    ignoreTargetFree: false, ignoreInvisible: false, maxTargets: 1,
  }, operations: [{ type: 'DAMAGE', power: 1, damageType: 'TRUE' }] }], followUps: [],
});

function actor() {
  return initializeUnit({ id: 0, definition: {
    id: 'release-actor', action: { normalAction: action }, vitality: { maxHp: 1000 },
  }, position: [0, 0] });
}
function program(id, initialState = {}) {
  return createEffectDefinition({ id, initialize: () => ({ ...initialState }) });
}
function services(resources) {
  return { effects: resources.effects, effectBindings: resources.effectBindings,
    effectLifecycle: resources.effectLifecycle, actionRelease: new ActionReleaseResources(resources.effects) };
}
function attach(resources, unit, registered) {
  return installFixtureEffect(unit, resources.effects.create(registered, {
    id: unit.effects?.nextInstanceId ?? 0, acquiredSequence: unit.effects?.nextAcquiredSequence ?? 0,
    source: null, scopes: [{ type: "UNIT", unitId: unit.id }],
  }), resources);
}
function installation(unitId) {
  return { source: null, scopes: [{ type: 'UNIT', unitId }] };
}

test('action release: resources validate registered definitions, own the callback and respect registration sealing', () => {
  const resources = new CombatResources();
  const registration = new ResourceRegistration();
  const release = new ActionReleaseResources(resources.effects, registration);
  const registered = resources.registerEffect(program('release-contract'));
  assert.throws(() => release.register(program('unregistered'), { beforeRelease: () => ({ type: 'CONTINUE' }) }), /unregistered/);
  const other = program(registered.id);
  assert.throws(() => release.register(other, { beforeRelease: () => ({ type: 'CONTINUE' }) }), /unregistered/);
  const rules = { beforeRelease: context => {
    assert.equal(context.instance.definition, registered);
    return { type: 'CONTINUE' };
  } };
  release.register(registered, rules);
  rules.beforeRelease = () => { throw new Error('replacement'); };
  assert.throws(() => release.register(registered, rules), /duplicate/);
  const unit = attach(resources, actor(), registered);
  const instance = unit.effects.instances[0];
  assert.equal(Object.isFrozen(release.get(instance)), true);
  assert.deepEqual(release.get(instance).beforeRelease({ instance }), { type: 'CONTINUE' });
  assert.throws(() => release.get(instance).beforeRelease({ instance: { ...instance, definition: other } }), /matching/);
  registration.seal();
  assert.throws(() => release.register(registered, rules), /sealed/);
});

test('action release: absent resources, action, owner or participating rules preserve the original work', () => {
  const resources = new CombatResources();
  const input = effectFixtureWork(actor());
  assert.equal(beforeActionRelease(input, 0, 0, resources), false);
  const supplied = services(resources);
  assert.equal(beforeActionRelease(input, 0, 0, supplied), false);
  assert.equal(beforeActionRelease(input, 99, 0, supplied), false);
  const ordinary = initializeUnit({ id: 0, definition: { id: 'ordinary' }, position: [0, 0] });
  const ordinaryWork = effectFixtureWork(ordinary);
  assert.equal(beforeActionRelease(ordinaryWork, 0, 0, supplied), false);
  const registered = resources.registerEffect(program('disabled-release'));
  supplied.actionRelease.register(registered, { beforeRelease: () => { throw new Error('disabled ran'); } });
  const attached = effectFixtureWork(attach(resources, actor(), registered));
  setEffectEnabled(attached, { type: "EFFECT", unitId: 0, effectId: 0 }, false, resources, 0);
  assert.equal(beforeActionRelease(attached, 0, 0, supplied), false);
});

test('action release: a content rule consumes charges and only requests interruption and maximum recovery', () => {
  const resources = new CombatResources();
  const supplied = services(resources);
  const registered = resources.registerEffect(program('release-charges', { remaining: 3 }));
  supplied.actionRelease.register(registered, { beforeRelease: context => {
    assert.equal(context.unitId, 0);
    assert.equal(context.tick, 7);
    assert.equal(context.instance.state.remaining > 0, true);
    context.effects.update(context.ref, registered, state => ({ remaining: state.remaining - 1 }));
    if (context.instance.state.remaining === 0) { context.effects.finish([context.ref]); }
    return { type: 'INTERRUPT', recoveryTicks: 15 };
  } });
  let unit = attach(resources, actor(), registered);
  unit = { ...unit, action: { ...unit.action, recoveryUntilTick: 40 } };
  const input = effectFixtureWork(unit);
  const initialEffects = unit.effects;
  const execution = input.execution;
  let result = beforeActionRelease(input, 0, 7, supplied);
  assert.equal(result, true);
  assert.equal(getUnit(input, 0).action.recoveryUntilTick, 40);
  assert.equal(getUnit(input, 0).effects.instances[0].state.remaining, 2);
  assert.equal(input.execution, execution);
  assert.deepEqual(input.events, []);
  assert.equal(unit.effects, initialEffects);
  assert.equal(input.battlefield.snapshot('state').getUnit(0).effects, initialEffects);
  assert.equal(initialEffects.instances[0].definition, registered);
  assert.deepEqual(initialEffects.instances[0].state, { remaining: 3 });
  result = beforeActionRelease(input, 0, 7, supplied);
  result = beforeActionRelease(input, 0, 7, supplied);
  assert.equal(result, true);
  assert.deepEqual(getUnit(input, 0).effects.instances, []);
  assert.equal(beforeActionRelease(input, 0, 7, supplied), false);
  const shorter = { ...unit, action: { ...unit.action, recoveryUntilTick: 0 } };
  const shorterState = effectFixtureWork(shorter);
  beforeActionRelease(shorterState, 0, 7, supplied);
  assert.equal(getUnit(shorterState, 0).action.recoveryUntilTick, 22);
});

test('action release: the first interruption stops subsequent content rules', () => {
  const resources = new CombatResources();
  const supplied = services(resources);
  const calls = [];
  let unit = actor();
  for (const [id, type] of [['continue', 'CONTINUE'], ['interrupt', 'INTERRUPT'], ['later', 'CONTINUE']]) {
    const registered = resources.registerEffect(program(id));
    supplied.actionRelease.register(registered, { beforeRelease: () => {
      calls.push(id);
      return type === 'CONTINUE' ? { type } : { type, recoveryTicks: 0 };
    } });
    unit = attach(resources, unit, registered);
  }
  const result = beforeActionRelease(effectFixtureWork(unit), 0, 0, supplied);
  assert.deepEqual(calls, ['continue', 'interrupt']);
  assert.equal(result, true);
});

test('action release: candidate identities freeze, participation is rechecked and ordinary facts see new effects', () => {
  for (const operation of ['enable', 'finish']) {
    const resources = new CombatResources();
    const supplied = services(resources);
    const calls = [];
    const c = resources.registerEffect(program(`new-${operation}`));
    supplied.actionRelease.register(c, { beforeRelease: () => { calls.push('C'); return { type: 'CONTINUE' }; } });
    const a = resources.registerEffect(program(`first-${operation}`, { entered: false }));
    supplied.actionRelease.register(a, { beforeRelease: context => {
      calls.push('A');
      if (!context.instance.state.entered) {
        context.effects.update(context.ref, a, () => ({ entered: true }));
        if (operation === 'enable') { context.effects.setEnabled({ type: "EFFECT", unitId: 0, effectId: 1 }, true); }
        else { context.effects.finish([{ type: "EFFECT", unitId: 0, effectId: 1 }]); }
        const installed = context.effects.install(0, c, installation(0));
        assert.equal(installed.type, 'INSTALLED');
        assert.equal(context.facts.getEffect(installed.ref).definition, c);
        assert.equal(context.facts.participating(0).some(instance => instance.definition === c), true);
      }
      return { type: 'CONTINUE' };
    } });
    const b = resources.registerEffect(program(`second-${operation}`));
    supplied.actionRelease.register(b, { beforeRelease: () => { calls.push('B'); return { type: 'CONTINUE' }; } });
    const work = effectFixtureWork(attach(resources, attach(resources, actor(), a), b));
    if (operation === 'enable') { setEffectEnabled(work, { type: "EFFECT", unitId: 0, effectId: 1 }, false, resources, 0); }
    beforeActionRelease(work, 0, 0, supplied);
    assert.deepEqual(calls, operation === 'enable' ? ['A', 'B'] : ['A']);
    calls.length = 0;
    beforeActionRelease(work, 0, 1, supplied);
    assert.deepEqual(calls, operation === 'enable' ? ['A', 'B', 'C'] : ['A', 'C']);
  }
});

test('action release: the live typed instance tracks updates and all borrowed operations expire after continuation', () => {
  const resources = new CombatResources();
  const supplied = services(resources);
  let borrowed;
  const registered = resources.registerEffect(program('live-release', { value: 0 }));
  supplied.actionRelease.register(registered, { beforeRelease: context => {
    borrowed = context;
    context.effects.update(context.ref, registered, state => ({ value: state.value + 1 }));
    assert.equal(context.instance.state.value, 1);
    context.effects.finish([context.ref]);
    assert.equal(context.instance.finished, true);
    assert.equal(context.instance.state.value, 1);
    return { type: 'CONTINUE' };
  } });
  const input = effectFixtureWork(attach(resources, actor(), registered));
  const result = beforeActionRelease(input, 0, 0, supplied);
  assert.equal(result, false);
  assert.deepEqual(getUnit(input, 0).effects.instances, []);
  assert.throws(() => borrowed.instance, /no longer active/);
  assert.throws(() => borrowed.facts.getUnit(0), /no longer active/);
  assert.throws(() => borrowed.facts.getEffect(borrowed.ref), /no longer active/);
  assert.throws(() => borrowed.facts.participating(0), /no longer active/);
  assert.throws(() => borrowed.effects.finish([borrowed.ref]), /no longer active/);
});

test('action release: content exceptions propagate and release borrowed state without publishing a partial transition', () => {
  const resources = new CombatResources();
  const supplied = services(resources);
  let borrowed;
  let fail = true;
  const registered = resources.registerEffect(program('failed-release', { attempts: 0 }));
  supplied.actionRelease.register(registered, { beforeRelease: context => {
    borrowed = context;
    context.effects.update(context.ref, registered, state => ({ attempts: state.attempts + 1 }));
    if (fail) { throw new Error('release content failed'); }
    return { type: 'CONTINUE' };
  } });
  const input = effectFixtureWork(attach(resources, actor(), registered));
  assert.throws(() => beforeActionRelease(input, 0, 0, supplied), /release content failed/);
  assert.throws(() => borrowed.instance, /no longer active/);
  assert.equal(input.battlefield.snapshot("state").getUnit(0).effects.instances[0].state.attempts, 0);
  input.battlefield.drop();
  fail = false;
  beforeActionRelease(input, 0, 0, supplied);
  assert.equal(getUnit(input, 0).effects.instances[0].state.attempts, 1);
});

test('action release: malformed recovery deadlines are programming errors', () => {
  for (const recoveryTicks of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    const resources = new CombatResources();
    const supplied = services(resources);
    const registered = resources.registerEffect(program(`invalid-${recoveryTicks}`));
    supplied.actionRelease.register(registered, { beforeRelease: () => ({ type: 'INTERRUPT', recoveryTicks }) });
    assert.throws(() => beforeActionRelease(effectFixtureWork(attach(resources, actor(), registered)), 0, 1, supplied), RangeError);
  }
});
