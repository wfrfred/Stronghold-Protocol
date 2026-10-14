import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { battle, unit, actionDefinition, assertData } from '../helpers/action-fixture.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { acceptActionExecution, createActionExecutionState, resumeActionExecution, cancelActionExecution, actionExecutionPermissions } from '../../dist/core/tactical/unit/capability/action/process.js';
import { getUnit, battlefieldView, updateUnit, removeUnit } from '../../dist/core/tactical/battle/state.js';
import { removeUnitWithEffects } from '../../dist/core/tactical/battle/execution/unit-lifecycle.js';
import * as effects from '../../dist/core/tactical/unit/effect/operations.js';
import { setAttackContribution, removeAttackContribution } from '../../dist/core/tactical/unit/capability/offense/capability.js';
import { resolveAttackPower } from '../../dist/core/tactical/unit/capability/offense/query.js';
import { create as modifier } from '../../dist/core/tactical/unit/contribution/value.js';
import { createDamageOperands } from '../../dist/core/tactical/unit/capability/vitality/damage/contract.js';

function accepted(state = battle(unit(0), unit(1)), options = {}) {
  const result = acceptActionExecution(state.actionExecutions, {
    sourceUnitId: 0, definition: actionDefinition(), inputTargetUnitId: 1,
    bindings: new Map([['primary', [1]]]), tick: 0, ...options,
  });
  return { ...state, actionExecutions: result.state };
}

function resume(state, segments, tick = 0, resources = new CombatResources(), executionId = 0) {
  return resumeActionExecution(state, { executionId, segments, tick }, resources);
}

const execute = run => ({ type: 'EXECUTE', run });
const wait = ticks => ({ type: 'WAIT', resolve: () => ({ type: 'FOR_TICKS', ticks }) });
const pass = (state, value) => ({ state, value });
const bonus = {
  id: 'action-owned-bonus', initialize: () => ({}),
  onEnable: (state, context) => updateUnit(state, ({ ...context.unit, offense: setAttackContribution(context.unit.offense, {
    id: `bonus/${context.self.id}`, value: [modifier({ finalAddition: 13 })],
  }) })),
  onDisable: (state, context) => updateUnit(state, ({ ...context.unit, offense: removeAttackContribution(context.unit.offense, `bonus/${context.self.id}`) })),
};

function installOwned(state, context, content = bonus, unitId = 1) {
  return effects.install(state, unitRef(getUnit(state, unitId)), content, {
    source: context.sourceUnitId, scopes: [{ type: 'ACTION', executionId: context.executionId }],
  }, context.call).state;
}

test('action process: immutable execution data preserves samples, consumed waits and absolute waits without replay', () => {
  const samples = { power: 10 };
  const initial = accepted(undefined, { samples });
  const segments = [
    execute((state, context) => pass(state, { samples: { power: context.samples.power + 1 } })),
    { ...wait(2), blockingMovement: true, allowNewAction: false },
    { type: 'RELEASE', markerId: 'first' },
    { type: 'WAIT', resolve: context => ({ type: 'UNTIL_TICK', targetTick: context.tick + 2 }) },
    { type: 'RELEASE', markerId: 'second' },
  ];
  const entered = resume(initial, segments);
  const execution = entered.state.actionExecutions.executions[0];
  assert.equal(execution.samples.power, 11);
  assert.equal(execution.wait.remainingTicks, 2);
  assert.deepEqual(actionExecutionPermissions(execution, segments), { blockingMovement: true, allowNewAction: false });
  assertData(assert, entered.state.actionExecutions);
  assert.equal(initial.actionExecutions.executions[0].samples, samples);
  assert.equal(initial.actionExecutions.executions[0].cursor, 0);
  const run = () => {
    let state = entered.state;
    for (const tick of [5, 5, 8, 8, 10, 10]) {
      const result = resume(state, segments, tick);
      state = result.state;
    }
    return { state, signals: state.events.filter(event => event.type.startsWith("ACTION_")) };
  };
  const actual = run();
  assert.deepEqual(actual, run());
  assert.deepEqual(actual.signals.map(signal => signal.type), ['ACTION_RELEASED', 'ACTION_RELEASED', 'ACTION_FINISHED']);
  assert.deepEqual(actual.state.actionExecutions.executions, []);
  assert.equal(execution.wait.remainingTicks, 2);
});

test('action process: cancellation ends owned effects while retaining an already completed damage prefix', () => {
  const resources = new CombatResources();
  const initial = accepted();
  const segments = [execute((state, context) => {
    state = installOwned(state, context);
    state = resources.settleDamage(state, { sourceUnitId: 0, targetUnitId: 1, tick: context.tick, damageType: 'TRUE', operands: createDamageOperands(20) }, context.call).state;
    return pass(state, undefined);
  }), wait(2), { type: 'RELEASE', markerId: 'never' }];
  const waiting = resume(initial, segments, 0, resources);
  assert.equal(resolveAttackPower(1, battlefieldView(waiting.state)), 23);
  const cancelled = cancelActionExecution(waiting.state, { executionId: 0, tick: 1 });
  assert.deepEqual(cancelled.value, { type: 'CANCELLED', reason: 'CANCELLED' });
  assert.equal(getUnit(cancelled.state, 1).vitality.hp, 80);
  assert.deepEqual(getUnit(cancelled.state, 1).effects.values(), []);
  assert.equal(resolveAttackPower(1, battlefieldView(cancelled.state)), 10);
  assert.equal(getUnit(initial, 1).vitality.hp, 100);
  assert.equal(getUnit(waiting.state, 1).effects.values().length, 1);
  assert.equal(cancelActionExecution(cancelled.state, { executionId: 0, tick: 1 }).state, cancelled.state);
  assert.equal(cancelled.state.events.some(event => event.type === 'ACTION_RELEASED'), false);
});

test('action process: a following query and segment observe the preceding returned state', () => {
  const resources = new CombatResources();
  const initial = accepted();
  let observed;
  const result = resume(initial, [
    execute((state, context) => pass(installOwned(state, context), { bindings: new Map([['primary', [1]]]) })),
    execute((state, context) => {
      const power = resolveAttackPower(1, battlefieldView(state));
      state = resources.settleDamage(state, { sourceUnitId: 0, targetUnitId: context.bindings.get('primary')[0], tick: context.tick, damageType: 'TRUE', operands: createDamageOperands(power) }, context.call).state;
      return pass(state, undefined);
    }),
    execute(state => { observed = getUnit(state, 1).vitality.hp; return pass(state, undefined); }),
  ], 0, resources);
  assert.equal(observed, 77);
  assert.equal(getUnit(result.state, 1).vitality.hp, 77);
  assert.equal(getUnit(initial, 1).vitality.hp, 100);
});

test('action process: concurrent executions own independent effects and finish independently', () => {
  const resources = new CombatResources();
  const initial = accepted(accepted());
  const segments = [execute((state, context) => pass(installOwned(state, context), undefined)), wait(2)];
  const first = resume(initial, segments, 0, resources);
  const second = resume(first.state, segments, 0, resources, 1);
  assert.equal(resolveAttackPower(1, battlefieldView(second.state)), 36);
  const cancelled = cancelActionExecution(second.state, { executionId: 0, tick: 1 });
  assert.equal(resolveAttackPower(1, battlefieldView(cancelled.state)), 23);
  assert.deepEqual(cancelled.state.actionExecutions.executions.map(value => value.id), [1]);
  const completed = resume(resume(cancelled.state, segments, 1, resources, 1).state, segments, 2, resources, 1);
  assert.equal(resolveAttackPower(1, battlefieldView(completed.state)), 10);
  assert.deepEqual(completed.state.actionExecutions.executions, []);
});

test('action process: normal finish and content cancellation retain the prefix and skip successors', () => {
  for (const continuation of ['FINISH', 'CANCEL']) {
    const initial = accepted();
    let reached = false;
    const result = resume(initial, [
      execute((state, context) => { state = installOwned(state, context); return pass(updateUnit(state, { ...getUnit(state, 1), position: [3, 0] }), { continuation }); }),
      execute(state => { reached = true; return pass(state, undefined); }),
    ]);
    assert.equal(reached, false);
    assert.equal(result.value.type, continuation === 'FINISH' ? 'FINISHED' : 'CANCELLED');
    assert.deepEqual(getUnit(result.state, 1).position, [3, 0]);
    assert.deepEqual(result.state.actionExecutions.executions, []);
    assert.deepEqual(getUnit(initial, 1).position, [1, 0]);
  }
});

test('action process: an exception propagates and leaves the input state unchanged', () => {
  const initial = accepted();
  assert.throws(() => resume(initial, [
    execute(state => pass(updateUnit(state, { ...getUnit(state, 1), position: [4, 0] }), undefined)),
    execute(() => { throw new Error('successor failed'); }),
  ]), /successor failed/);
  assert.equal(initial.actionExecutions.executions[0].cursor, 0);
  assert.deepEqual(getUnit(initial, 1).position, [1, 0]);
  assert.deepEqual(initial.events, []);
});

test('action process: an entered segment completes after source departure and unentered successors cancel', () => {
  const initial = accepted();
  const observed = [];
  const result = resume(initial, [
    execute((state, context) => pass(installOwned(state, context), undefined)),
    execute(state => {
      state = removeUnit(state, 0, 'RETREAT');
      observed.push('synchronous');
      state = updateUnit(state, { ...getUnit(state, 1), position: [3, 0] });
      return pass(state, undefined);
    }), wait(1), execute(state => { observed.push('successor'); return pass(state, undefined); }),
  ]);
  assert.deepEqual(observed, ['synchronous']);
  assert.deepEqual(result.value, { type: 'CANCELLED', reason: 'SOURCE_ABSENT' });
  assert.deepEqual(getUnit(result.state, 1).position, [3, 0]);
  assert.deepEqual(getUnit(result.state, 1).effects.values(), []);
});

test('action process: source absence before a later release retains earlier release signals', () => {
  const result = resume(accepted(), [
    { type: 'RELEASE', markerId: 'before' }, execute(state => pass(removeUnit(state, 0, 'RETREAT'), undefined)),
    { type: 'RELEASE', markerId: 'after' },
  ]);
  assert.deepEqual(result.state.events.filter(event => event.type.startsWith("ACTION_")).map(event => event.type), ['ACTION_RELEASED', 'ACTION_CANCELLED']);
});

test('action process: a final entered segment may finish after removing its source', () => {
  const result = resume(accepted(), [execute(state => pass(removeUnit(state, 0, 'RETREAT'), undefined))]);
  assert.equal(result.value.type, 'FINISHED');
  assert.equal(getUnit(result.state, 0), undefined);
});

test('action process: nested lifecycle removal cancels the execution before a successor can enter', () => {
  const resources = new CombatResources();
  let reached = false;
  const result = resume(accepted(), [
    execute((state, context) => {
      state = installOwned(state, context);
      state = removeUnitWithEffects(state, 0, 'SCRIPT', resources, context.tick, context.call);
      return pass(state, undefined);
    }), execute(state => { reached = true; return pass(state, undefined); }),
  ], 0, resources);
  assert.equal(reached, false);
  assert.deepEqual(result.state.actionExecutions.executions, []);
  assert.equal(getUnit(result.state, 0), undefined);
  assert.deepEqual(getUnit(result.state, 1).effects.values(), []);
});

test('action process: attack completion cannot revive an execution cancelled by departure', () => {
  const resources = new CombatResources();
  let reached = false;
  const result = resume(accepted(), [
    execute(state => pass(state, undefined)), execute(state => { reached = true; return pass(state, undefined); }),
  ], 2, { completeAttack: (state, id, tick, call) => removeUnitWithEffects(state, id, 'DEATH', resources, tick, call) });
  assert.equal(reached, false);
  assert.deepEqual(result.state.actionExecutions.executions, []);
  assert.equal(result.state.events.filter(event => event.type === 'ACTION_CANCELLED').length, 1);
});
