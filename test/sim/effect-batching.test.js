import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { getUnit } from '../../dist/core/tactical/battle/execution/context.js';
import { createEffectDefinition } from '../../dist/core/tactical/unit/capability/effects/definition.js';
import { finishEffects, closeEffectLifetimes, installNewEffect, bindEffectLifetime } from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { effectFixtureWork } from '../helpers/effects.js';
const host = id => ({ id, definition: { id: `host-${id}` }, position: [0, 0] });
const program = id => createEffectDefinition({ id, initialize: () => ({}) });
const input = { source: null, scopes: [] };

test('effect ending: overlapping roots and diamond dependencies settle one instance at a time in deterministic order', () => {
  const resources = new CombatResources();
  const notices = [];
  const effect = resources.registerEffect(program('diamond'), { lifecycle: {
    disable: context => {
      const finished = refs.filter(ref => context.facts.getEffect(ref).finished);
      assert.equal(finished.length, notices.length + 1);
      assert.equal(context.facts.getEffect(context.ref).participating, false);
      assert.equal(context.facts.participating(0).length + context.facts.participating(1).length, refs.length - finished.length);
      notices.push([context.ref.unitId, context.ref.effectId]);
    },
  } });
  let work = effectFixtureWork(host(0), host(1));
  const refs = [];
  for (const id of [0, 1, 1, 0]) {
    const installed = installNewEffect(work, id, effect, input, resources, 0);
     refs.push(installed.ref);
  }
  // Root → left/right → leaf; the leaf has a lower host ID than both parents.
  for (const [child, parent] of [[refs[1], refs[0]], [refs[2], refs[0]], [refs[3], refs[1]], [refs[3], refs[2]]]) {
    bindEffectLifetime(work, child, parent);
  }
  const before = work.battlefield.snapshot("draft");
  finishEffects(work, [refs[3], refs[0], refs[0]], resources, 1);
  assert.deepEqual(notices, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  assert.ok([0, 1].every(id => getUnit(work, id).effects.instances.every(instance => instance.finished)));
  finishEffects(work, refs, resources, 1);
  assert.equal(notices.length, refs.length);
  assert.ok([0, 1].every(id => before.getUnit(id).effects.instances.every(instance => !instance.finished)));
});

test('effect ending: a departing host settles competitors in instance order', () => {
  const resources = new CombatResources();
  const calls = [];
  let work = effectFixtureWork(host(0));
  for (const priority of [3, 2, 1]) {
    const effect = resources.registerEffect(program(`rank-${priority}`), { lifecycle: {
      competition: () => ({ group: 'rank', priority }),
      enable: () => { calls.push(priority); },
    } });
    installNewEffect(work, 0, effect, input, resources, 0);
  }
  calls.length = 0;
  closeEffectLifetimes(work, [{ type: 'UNIT', unitId: 0 }], resources, 1);
  assert.deepEqual(calls, [2, 1]);
  assert.ok(getUnit(work, 0).effects.instances.every(instance => instance.finished));
});

test('effect ending: an independent competitor participates after the last stronger instance ends', () => {
  for (const count of [1, 3]) {
    const resources = new CombatResources();
    let enables = 0;
    const survivor = resources.registerEffect(program('survivor'), { lifecycle: {
      competition: () => ({ group: 'rank', priority: 0 }),
      enable: () => { enables++; },
    } });
    const ending = resources.registerEffect(program('ending'), { lifecycle: {
      competition: () => ({ group: 'rank', priority: 1 }),
    } });
    const installedState = effectFixtureWork(host(0));
    let installed = installNewEffect(installedState, 0, survivor, input, resources, 0);
    let work = installedState;
    const roots = [];
    for (let index = 0; index < count; index++) {
      installed = installNewEffect(work, 0, ending, input, resources, 0);
      roots.push(installed.ref);
    }
    enables = 0;
    finishEffects(work, roots, resources, 1);
    assert.equal(enables, 1);
    assert.equal(getUnit(work, 0).effects.instances[0].participating, true);
  }
});

test('effect ending: finish business can supersede a surviving competitor before its queued enable', () => {
  const resources = new CombatResources();
  const calls = [];
  let followerRef;
  const follower = resources.registerEffect(program('queued-follower'), { lifecycle: {
    competition: () => ({ group: 'rank', priority: 0 }),
    enable: () => { calls.push('enable'); },
    finish: () => { calls.push('finish'); },
  } });
  const leader = resources.registerEffect(program('leader'), { lifecycle: {
    competition: () => ({ group: 'rank', priority: 1 }),
    finish: context => { context.effects.finish([followerRef]); },
  } });
  const initialState = effectFixtureWork(host(0));
  const initial = installNewEffect(initialState, 0, follower, input, resources, 0);
  followerRef = initial.ref;
  const installed = installNewEffect(initialState, 0, leader, input, resources, 0);
  calls.length = 0;
  const ended = initialState;
  finishEffects(ended, [installed.ref], resources, 1);
  assert.deepEqual(calls, ['finish']);
  assert.ok(getUnit(ended, 0).effects.instances.every(instance => instance.finished));
});

test('effect ending: a later root reads state changed by an earlier finish callback', () => {
  const resources = new CombatResources();
  const notices = [];
  let later;
  const effect = resources.registerEffect(createEffectDefinition({
    id: 'sequential-root-state', initialize: () => ({ name: '', amount: 0 }),
  }), { lifecycle: {
    finish: context => {
      notices.push([context.instance.state.name, context.instance.state.amount]);
      if (context.instance.state.name === 'first') {
        assert.equal(context.facts.getEffect(later).finished, false);
        context.effects.update(later, effect, state => ({ ...state, amount: 7 }));
      }
    },
  } });
  const work = effectFixtureWork(host(0));
  const first = installNewEffect(work, 0, effect, {
    ...input, initialState: { name: 'first', amount: 1 },
  }, resources, 0).ref;
  later = installNewEffect(work, 0, effect, {
    ...input, initialState: { name: 'later', amount: 2 },
  }, resources, 0).ref;

  finishEffects(work, [later, first], resources, 1);

  assert.deepEqual(notices, [['first', 1], ['later', 7]]);
});

test('effect ending: a nested finish of a later root runs its callback only once', () => {
  const resources = new CombatResources();
  const notices = [];
  let later;
  const effect = resources.registerEffect(program('nested-later-root'), { lifecycle: {
    finish: context => {
      notices.push([context.ref.effectId, context.end.reason]);
      if (context.ref.effectId === 0) {
        context.effects.finish([later], 'NESTED');
      }
    },
  } });
  const work = effectFixtureWork(host(0));
  const first = installNewEffect(work, 0, effect, input, resources, 0).ref;
  later = installNewEffect(work, 0, effect, input, resources, 0).ref;

  finishEffects(work, [first, later], resources, 1, 'OUTER');

  assert.deepEqual(notices, [[0, 'OUTER'], [1, 'NESTED']]);
  assert.ok(getUnit(work, 0).effects.instances.every(instance => instance.finished));
});
