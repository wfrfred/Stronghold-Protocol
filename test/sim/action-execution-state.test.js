import assert from 'node:assert/strict';
import { test } from 'node:test';
import { battle, unit, actionDefinition } from '../helpers/action-fixture.js';
import { createCombat } from '../../dist/core/tactical/battle/steps/combat.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { acceptActionExecution, resumeActionExecution } from '../../dist/core/tactical/unit/capability/action/process.js';

function fixture(count = 8, perSource = 2) {
  let state = battle(...Array.from({ length: count }, (_, id) => unit(id)));
  for (const id of state.battlefield.units.keys()) {
    for (let slot = 0; slot < perSource; slot++) {
      const accepted = acceptActionExecution(state.actionExecutions, {
        sourceUnitId: id, definition: actionDefinition(), inputTargetUnitId: id,
        bindings: new Map([['primary', [id]]]), tick: 0,
      });
      state = { ...state, actionExecutions: accepted.state };
    }
  }
  return { ...state, actionExecutions: { ...state.actionExecutions, executions: [...state.actionExecutions.executions].reverse() } };
}

function reference(state, segments, resources, tick) {
  for (const id of state.battlefield.units.keys()) {
    for (const execution of state.actionExecutions.executions.filter(execution => execution.sourceUnitId === id)) {
      state = resumeActionExecution(state, { executionId: execution.id, segments, tick }, resources).state;
    }
  }
  return state;
}

test('action execution state: combat preserves ordered progress and immutable input branches', () => {
  const initial = fixture(16);
  const observed = [];
  const resources = new CombatResources();
  const segments = [
    { type: 'EXECUTE', run: (state, context) => { observed.push(context.executionId); return { state, value: { samples: { identity: context.executionId } } }; } },
    { type: 'WAIT', allowNewAction: false, blockingMovement: true, resolve: () => ({ type: 'FOR_TICKS', ticks: 3 }) },
  ];
  const combat = createCombat(resources, definition => ({ definition, bind: () => new Map(), program: segments }));
  const expected = reference(initial, segments, resources, 0);
  const expectedOrder = [...observed];
  observed.length = 0;
  const actual = combat.advance(initial, 0);
  assert.deepEqual(actual, expected);
  assert.deepEqual(observed, expectedOrder);
  assert.equal(initial.actionExecutions.executions.every(execution => execution.cursor === 0), true);
  assert.equal(combat.allowsMovement(actual.actionExecutions, 0), false);
  assert.equal(combat.allowsMovement(actual.actionExecutions, 100), true);
  assert.deepEqual(combat.advance(initial, 0), actual);
  const next = combat.advance(actual, 1);
  assert.equal(next.actionExecutions.executions.every(execution => execution.wait.remainingTicks === 2), true);
  assert.equal(actual.actionExecutions.executions.every(execution => execution.wait.remainingTicks === 3), true);
  for (const execution of next.actionExecutions.executions) {
    const previous = actual.actionExecutions.executions.find(value => value.id === execution.id);
    assert.equal(execution.bindings, previous.bindings);
    assert.equal(execution.samples, previous.samples);
  }
});

test('action execution state: same-tick and absolute waits retain unchanged state references', () => {
  for (const resolve of [() => ({ type: 'UNTIL_TICK', targetTick: 20 }), () => ({ type: 'FOR_TICKS', ticks: 3 })]) {
    const segments = [{ type: 'WAIT', resolve, allowNewAction: false }];
    const resources = new CombatResources();
    const combat = createCombat(resources, definition => ({ definition, bind: () => new Map(), program: segments }));
    const entered = combat.advance(fixture(3, 1), 0);
    assert.equal(combat.advance(entered, 0), entered);
    assert.equal(resumeActionExecution(entered, { executionId: entered.actionExecutions.executions[0].id, segments, tick: 0 }, resources).state, entered);
  }
});

test('action execution state: an exception never mutates the input action progress', () => {
  const initial = fixture(3, 1);
  const segments = [{ type: 'EXECUTE', run: (state, context) => {
    if (context.sourceUnitId === 1) throw new Error('late action failure');
    return { state, value: { samples: { source: context.sourceUnitId } } };
  } }];
  const combat = createCombat(new CombatResources(), definition => ({ definition, bind: () => new Map(), program: segments }));
  assert.throws(() => combat.advance(initial, 0), /late action failure/);
  assert.equal(initial.actionExecutions.executions.every(execution => execution.cursor === 0), true);
  assert.deepEqual(initial.events, []);
});
