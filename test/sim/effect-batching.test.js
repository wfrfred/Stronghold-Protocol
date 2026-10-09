import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { getCombatUnit } from '../../dist/core/tactical/battle/execution/work.js';
import { createEffectProgram } from '../../dist/core/tactical/unit/capability/effects/program.js';
import { finishEffects, closeEffectLifetimes, installNewEffect, bindEffectLifetime } from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { effectFixtureWork } from '../helpers/effects.js';
const host = id => ({ id, definition: { id: `host-${id}` } });
const program = id => createEffectProgram({ id, initialize: () => ({}), ownState: state => state });
const input = { source: null, scopes: [] };

test('effect batching: overlapping roots and diamond dependencies mark the complete set before deterministic callbacks', () => {
  const resources = new CombatResources();
  const notices = [];
  const effect = resources.registerEffect(program('diamond'), { lifecycle: {
    disable: context => {
      assert.equal(context.facts.participating(0).length, 0);
      assert.equal(context.facts.participating(1).length, 0);
      notices.push([context.ref.unitId, context.ref.effectId]);
    },
  } });
  let work = effectFixtureWork(host(0), host(1));
  const refs = [];
  for (const id of [0, 1, 1, 0]) {
    const installed = installNewEffect(work, id, effect.ref, input, resources, 0);
    work = installed.work; refs.push(installed.result.ref);
  }
  // Root → left/right → leaf; the leaf has a lower host ID than both parents.
  for (const [child, parent] of [[refs[1], refs[0]], [refs[2], refs[0]], [refs[3], refs[1]], [refs[3], refs[2]]]) {
    work = bindEffectLifetime(work, child, parent).work;
  }
  const before = work;
  work = finishEffects(work, [refs[3], refs[0], refs[0]], resources, 1);
  assert.deepEqual(notices, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  assert.ok([0, 1].every(id => getCombatUnit(work, id).effects.instances.every(instance => instance.finished)));
  assert.equal(finishEffects(work, refs, resources, 1), work);
  assert.ok([0, 1].every(id => getCombatUnit(before, id).effects.instances.every(instance => !instance.finished)));
});

test('effect batching: a departing host never temporarily enables suppressed competitors', () => {
  const resources = new CombatResources();
  const calls = [];
  let work = effectFixtureWork(host(0));
  for (const priority of [1, 2, 3]) {
    const effect = resources.registerEffect(program(`rank-${priority}`), { lifecycle: {
      competition: () => ({ group: 'rank', priority }),
      enable: () => { calls.push(priority); },
    } });
    work = installNewEffect(work, 0, effect.ref, input, resources, 0).work;
  }
  calls.length = 0;
  work = closeEffectLifetimes(work, [{ type: 'UNIT', unitId: 0 }], resources, 1);
  assert.deepEqual(calls, []);
  assert.ok(getCombatUnit(work, 0).effects.instances.every(instance => instance.finished));
});

test('effect batching: closing many roots reconciles a surviving competitor once per host', () => {
  for (const count of [1, 16, 128]) {
    const resources = new CombatResources();
    let checks = 0;
    let enables = 0;
    const survivor = resources.registerEffect(program('survivor'), { lifecycle: {
      competition: () => { checks++; return { group: 'rank', priority: 0 }; },
      enable: () => { enables++; },
    } });
    const ending = resources.registerEffect(program('ending'), { lifecycle: {
      competition: () => ({ group: 'rank', priority: 1 }),
    } });
    let installed = installNewEffect(effectFixtureWork(host(0)), 0, survivor.ref, input, resources, 0);
    let work = installed.work;
    const roots = [];
    for (let index = 0; index < count; index++) {
      installed = installNewEffect(work, 0, ending.ref, input, resources, 0);
      work = installed.work; roots.push(installed.result.ref);
    }
    checks = 0; enables = 0;
    work = finishEffects(work, roots, resources, 1);
    assert.equal(checks, 1, `${count} roots`);
    assert.equal(enables, 1);
    assert.equal(getCombatUnit(work, 0).effects.instances[0].participating, true);
  }
});

test('effect batching: finish business can supersede a surviving competitor before its queued enable', () => {
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
  const initial = installNewEffect(effectFixtureWork(host(0)), 0, follower.ref, input, resources, 0);
  followerRef = initial.result.ref;
  const installed = installNewEffect(initial.work, 0, leader.ref, input, resources, 0);
  calls.length = 0;
  const ended = finishEffects(installed.work, [installed.result.ref], resources, 1);
  assert.deepEqual(calls, ['finish']);
  assert.ok(getCombatUnit(ended, 0).effects.instances.every(instance => instance.finished));
});
