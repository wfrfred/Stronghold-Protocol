import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCombat } from '../../dist/core/tactical/battle/combat.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { createCombatWork } from '../../dist/core/tactical/battle/execution/work.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { createActionDefinition } from '../../dist/core/tactical/unit/capability/action/capability.js';
import {
  acceptActionExecution,
  createActionExecutionState,
  resumeActionExecution,
} from '../../dist/core/tactical/unit/capability/action/process.js';

const definition = createActionDefinition({
  triggerBindingId: 'primary', baseAttackTimeTicks: 1, recoveryTicks: 0,
  targetGroups: [{ id: 'primary', targeting: {
    type: 'DAMAGE', scope: { type: 'BLOCKER' }, canTargetAir: true,
    includeBlockingRelations: false, preferBlockingRelations: false,
    ignoreTargetFree: false, ignoreInvisible: false, maxTargets: 1,
  }, operations: [{ type: 'DAMAGE', power: 1, damageType: 'TRUE' }] }], followUps: [],
});

function fixture(count = 8, perSource = 2) {
  const units = Array.from({ length: count }, (_, id) => initializeUnit({
    id, definition: { id: `waiting-${id}`, vitality: { maxHp: 100 } }, position: [0, 0],
  }));
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const battlefield = {
    unitIds: units.map(unit => unit.id), getUnit: id => byId.get(id),
    blockerOf: () => undefined, blockedBy: () => [],
    mechanismIds: [], getMechanism: () => undefined,
    projectileIds: [], getProjectile: () => undefined,
  };
  let state = createActionExecutionState();
  for (const unit of units) {
    for (let slot = 0; slot < perSource; slot++) {
      state = acceptActionExecution(state, {
        sourceUnitId: unit.id, definition, inputTargetUnitId: unit.id,
        bindings: new Map([['primary', [unit.id]]]), tick: 0,
      }).state;
    }
  }
  state = Object.freeze({ ...state, executions: Object.freeze([...state.executions].reverse()) });
  return {
    state, battlefield,
    input: { battlefield, tick: 0, execution: createCombatWork(battlefield).execution },
  };
}

function reference(initial, segments, resources, tick) {
  let state = initial.state;
  let work = createCombatWork(initial.battlefield);
  for (const id of initial.battlefield.unitIds) {
    for (const execution of state.executions.filter(execution => execution.sourceUnitId === id)) {
      const advanced = resumeActionExecution(
        work,
        state,
        { executionId: execution.id, segments, tick },
        resources,
      );
      work = advanced.work;
      state = advanced.state;
    }
  }
  return { state, work };
}

test('action execution work: combat batching preserves execution order, samples, and immutable input branches', () => {
  const initial = fixture(128);
  const resources = new CombatResources();
  const observed = [];
  const segments = [
    { type: 'EXECUTE', run: context => {
      observed.push(context.executionId);
      return { work: context.work, samples: { identity: context.executionId } };
    } },
    { type: 'WAIT', allowNewAction: false, blockingMovement: true,
      resolve: () => ({ type: 'FOR_TICKS', ticks: 3 }) },
  ];
  const combat = createCombat(resources, action => ({ definition: action, bind: () => new Map(), program: segments }));
  const before = structuredClone(initial.state);
  const expected = reference(initial, segments, resources, 0);
  const expectedOrder = [...observed];
  observed.length = 0;
  const freeze = Object.freeze;
  let executionArrays = 0;
  Object.freeze = value => {
    if (Array.isArray(value) && value.length === 256 && value[0]?.acceptedAtTick !== undefined) executionArrays++;
    return freeze(value);
  };
  let actual;
  try { actual = combat.advance(initial.input, initial.state); }
  finally { Object.freeze = freeze; }

  assert.equal(executionArrays, 1);
  assert.deepEqual(observed, expectedOrder);
  assert.deepEqual(actual.actionExecution, expected.state);
  assert.deepEqual(initial.state, before);
  assert.equal(Object.isFrozen(actual.actionExecution), true);
  assert.equal(Object.isFrozen(actual.actionExecution.executions), true);
  assert.equal(actual.actionExecution.executions.every(execution => Object.isFrozen(execution)), true);
  assert.deepEqual(actual.changes, []);
  assert.deepEqual(actual.events, []);
  assert.equal(combat.allowsMovement(actual.actionExecution, 0), false);
  assert.equal(combat.allowsMovement(actual.actionExecution, 128), true);
  const repeated = combat.advance(initial.input, initial.state);
  assert.deepEqual(repeated, actual);
  const advanced = combat.advance({ ...initial.input, tick: 1 }, actual.actionExecution);
  assert.equal(advanced.actionExecution.executions.every(execution => execution.wait.remainingTicks === 2), true);
  assert.equal(actual.actionExecution.executions.every(execution => execution.wait.remainingTicks === 3), true);
});

test('action execution work: absolute and same-tick consumed waits preserve unchanged state identities', () => {
  for (const resolve of [
    () => ({ type: 'UNTIL_TICK', targetTick: 20 }),
    () => ({ type: 'FOR_TICKS', ticks: 3 }),
  ]) {
    const initial = fixture(8, 1);
    const resources = new CombatResources();
    const segments = [{ type: 'WAIT', resolve, allowNewAction: false }];
    const combat = createCombat(resources, action => ({ definition: action, bind: () => new Map(), program: segments }));
    const entered = combat.advance(initial.input, initial.state);
    const unchanged = combat.advance(initial.input, entered.actionExecution);
    assert.equal(unchanged.actionExecution, entered.actionExecution);
    const single = resumeActionExecution(
      createCombatWork(initial.battlefield),
      entered.actionExecution,
      { executionId: entered.actionExecution.executions[0].id, segments, tick: 0 },
      resources,
    );
    assert.equal(single.state, entered.actionExecution);
    assert.deepEqual(unchanged.events, []);
    assert.deepEqual(unchanged.changes, []);
  }
});

test('action execution work: a later callback exception leaves the input execution batch retryable', () => {
  const initial = fixture(3, 1);
  const resources = new CombatResources();
  let fail = true;
  const segments = [
    { type: 'EXECUTE', run: context => {
      if (fail && context.sourceUnitId === 1) throw new Error('late action failure');
      return { work: context.work, samples: { source: context.sourceUnitId } };
    } },
    { type: 'WAIT', resolve: () => ({ type: 'FOR_TICKS', ticks: 2 }) },
  ];
  const combat = createCombat(resources, action => ({ definition: action, bind: () => new Map(), program: segments }));
  const before = structuredClone(initial.state);
  assert.throws(() => combat.advance(initial.input, initial.state), /late action failure/);
  assert.deepEqual(initial.state, before);
  fail = false;
  const retried = combat.advance(initial.input, initial.state);
  assert.deepEqual(retried.actionExecution, reference(initial, segments, resources, 0).state);
  assert.deepEqual(initial.state, before);
});
