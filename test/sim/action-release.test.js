import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { setData } from "../../dist/core/tactical/unit/effect/effect.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { battle, unit } from '../helpers/action-fixture.js';
import { getUnit, transitionUnit } from '../../dist/core/tactical/battle/state.js';
import { setBeforeReleaseHook, removeBeforeReleaseHook } from '../../dist/core/tactical/unit/capability/action/capability.js';
import { beforeActionRelease } from '../../dist/core/tactical/unit/capability/action/release.js';
import * as effects from '../../dist/core/tactical/unit/effect/operations.js';
import { get } from '../../dist/core/tactical/unit/effect/operations.js';

function releaseEffect(id, initial, run) {
  const definition = { id, initialize: () => initial,
    onInstall(state, context) {
      const ref = context.ref;
      return transitionUnit(state, ref.unitId, unit => ({ ...unit, action: setBeforeReleaseHook(unit.action, {
        id: `release/${ref.effectId}`,
        enabled: context => context.unit.effects.get(ref.effectId, definition)?.status === 'ACTIVE',
        invoke: (state, context) => run(state, context, context.unit.effects.get(ref.effectId, definition), ref),
      }) }));
    },
    onEnd: (state, context) => transitionUnit(state, context.ref.unitId, unit => ({ ...unit, action: removeBeforeReleaseHook(unit.action, `release/${context.ref.effectId}`) })),
  };
  return definition;
}
const continueRelease = { type: 'CONTINUE' };
const attach = (state, definition) => effects.install(state, unitRef(getUnit(state, 0)), definition);
const stateOf = (state, ref, next) => effects.replaceEffect(state, ref, setData(get(state, ref), next));

test('action release: ordinary and disabled effects do not interrupt', () => {
  const initial = battle(unit(0, { action: true }));
  assert.equal(beforeActionRelease(initial, 0, 0).value, false);
  const installed = attach(initial, releaseEffect('disabled', {}, () => assert.fail('disabled hook ran')));
  const state = effects.setEnabled(installed.state, installed.value, false);
  assert.equal(beforeActionRelease(state, 0, 0).value, false);
});

test('action release: charges update before end and recovery never shortens', () => {
  const initial = battle(unit(0, { action: true }));
  const definition = releaseEffect('charges', { remaining: 3 }, (state, context, self, ref) => {
    const remaining = self.data.remaining - 1;
    state = stateOf(state, ref, { remaining });
    assert.equal(get(state, ref).data.remaining, remaining);
    if (remaining === 0) state = effects.end(state, ref, undefined, context.call);
    return { state, value: { type: 'INTERRUPT', recoveryTicks: 15 } };
  });
  const installed = attach(initial, definition);
  let state = installed.state;
  for (const tick of [1, 2, 3]) {
    const result = beforeActionRelease(state, 0, tick);
    assert.equal(result.value, true);
    state = result.state;
  }
  assert.equal(get(state, installed.value), undefined);
  assert.equal(beforeActionRelease(state, 0, 4).value, false);
  assert.equal(getUnit(state, 0).action.recoveryUntilTick, 18);
  assert.deepEqual(getUnit(initial, 0).effects.values(), []);
  assert.equal(get(installed.state, installed.value).data.remaining, 3);
});

test('action release: registration order stops at the first interruption', () => {
  let state = battle(unit(0, { action: true }));
  const calls = [];
  for (const [id, directive] of [['first', continueRelease], ['second', { type: 'INTERRUPT', recoveryTicks: 4 }], ['third', continueRelease]]) {
    state = attach(state, releaseEffect(id, {}, state => { calls.push(id); return { state, value: directive }; })).state;
  }
  const result = beforeActionRelease(state, 0, 10);
  assert.equal(result.value, true);
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(getUnit(result.state, 0).action.recoveryUntilTick, 14);
});

for (const operation of ['enable', 'end']) {
  test(`action release: ${operation} changes later eligibility but added candidates await the next call`, () => {
    let state = battle(unit(0, { action: true }));
    const calls = [];
    const third = releaseEffect('third', {}, state => { calls.push('C'); return { state, value: continueRelease }; });
    let secondRef;
    const first = releaseEffect('first', { entered: false }, (state, context, self, ref) => {
      calls.push('A');
      if (!self.data.entered) {
        state = stateOf(state, ref, { entered: true });
        state = operation === 'enable' ? effects.setEnabled(state, secondRef, true, context.call) : effects.end(state, secondRef, undefined, context.call);
        state = attach(state, third).state;
      }
      return { state, value: continueRelease };
    });
    state = attach(state, first).state;
    const second = attach(state, releaseEffect('second', {}, state => { calls.push('B'); return { state, value: continueRelease }; }));
    state = second.state;
    secondRef = second.value;
    if (operation === 'enable') state = effects.setEnabled(state, secondRef, false);
    state = beforeActionRelease(state, 0, 0).state;
    assert.deepEqual(calls, operation === 'enable' ? ['A', 'B'] : ['A']);
    calls.length = 0;
    beforeActionRelease(state, 0, 1);
    assert.deepEqual(calls, operation === 'enable' ? ['A', 'B', 'C'] : ['A', 'C']);
  });
}

test('action release: an exception leaves the input private state untouched', () => {
  const installed = attach(battle(unit(0, { action: true })), releaseEffect('fault', { attempts: 0 }, (state, _context, self, ref) => {
    state = stateOf(state, ref, { attempts: self.data.attempts + 1 });
    throw new Error('release failed');
  }));
  assert.throws(() => beforeActionRelease(installed.state, 0, 0), /release failed/);
  assert.equal(get(installed.state, installed.value).data.attempts, 0);
});

for (const recoveryTicks of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
  test(`action release: invalid recovery ${recoveryTicks} is rejected`, () => {
    const installed = attach(battle(unit(0, { action: true })), releaseEffect('invalid', {}, state => ({ state, value: { type: 'INTERRUPT', recoveryTicks } })));
    assert.throws(() => beforeActionRelease(installed.state, 0, 1), RangeError);
  });
}
