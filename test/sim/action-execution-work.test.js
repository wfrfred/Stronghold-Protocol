import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCombatSystem } from '../../dist/core/tactical/battle/phases/combat.js';
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
  triggerBindingId: 'primary', intervalTicks: 1, recoveryTicks: 0,
  targetGroups: [{ id: 'primary', targeting: {
    type: 'DAMAGE', scope: { type: 'BLOCKER' }, canTargetAir: true,
    includeBlockingRelations: false, preferBlockingRelations: false,
    ignoreTargetFree: false, ignoreInvisible: false, maxTargets: 1,
  }, effects: [{ type: 'DAMAGE', power: 1, damageType: 'TRUE' }] }], followUps: [],
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
    input: { battlefield, tick: 0, commands: [], removedUnits: [], execution: createCombatWork(battlefield).execution },
  };
}

function reference(initial, segments, resources, tick) {
  let state = initial.state;
  let work = createCombatWork(initial.battlefield);
  for (const id of initial.battlefield.unitIds) {
    for (const execution of state.executions.filter(execution => execution.sourceUnitId === id)) {
      const advanced = resumeActionExecution(work, state, execution.id, segments, tick, resources);
      work = advanced.work;
      state = advanced.state;
    }
  }
  return { state, work };
}

test('action execution work: phase batching preserves execution order, samples, and immutable input branches', () => {
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
  const system = createCombatSystem(resources, action => ({ definition: action, bind: () => new Map(), program: segments }));
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
  try { actual = system.step(initial.input, initial.state); }
  finally { Object.freeze = freeze; }

  assert.equal(executionArrays, 1);
  assert.deepEqual(observed, expectedOrder);
  assert.deepEqual(actual.state, expected.state);
  assert.deepEqual(initial.state, before);
  assert.equal(Object.isFrozen(actual.state), true);
  assert.equal(Object.isFrozen(actual.state.executions), true);
  assert.equal(actual.state.executions.every(execution => Object.isFrozen(execution)), true);
  assert.deepEqual(actual.changes, []);
  assert.deepEqual(actual.events, []);
  assert.equal(system.allowsMovement(actual.state, 0), false);
  assert.equal(system.allowsMovement(actual.state, 128), true);
  const repeated = system.step(initial.input, initial.state);
  assert.deepEqual(repeated, actual);
  const advanced = system.step({ ...initial.input, tick: 1 }, actual.state);
  assert.equal(advanced.state.executions.every(execution => execution.wait.remainingTicks === 2), true);
  assert.equal(actual.state.executions.every(execution => execution.wait.remainingTicks === 3), true);
});

test('action execution work: absolute and same-tick consumed waits preserve unchanged state identities', () => {
  for (const resolve of [
    () => ({ type: 'UNTIL_TICK', targetTick: 20 }),
    () => ({ type: 'FOR_TICKS', ticks: 3 }),
  ]) {
    const initial = fixture(8, 1);
    const resources = new CombatResources();
    const segments = [{ type: 'WAIT', resolve, allowNewAction: false }];
    const system = createCombatSystem(resources, action => ({ definition: action, bind: () => new Map(), program: segments }));
    const entered = system.step(initial.input, initial.state);
    const unchanged = system.step(initial.input, entered.state);
    assert.equal(unchanged.state, entered.state);
    const single = resumeActionExecution(createCombatWork(initial.battlefield), entered.state,
      entered.state.executions[0].id, segments, 0, resources);
    assert.equal(single.state, entered.state);
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
  const system = createCombatSystem(resources, action => ({ definition: action, bind: () => new Map(), program: segments }));
  const before = structuredClone(initial.state);
  assert.throws(() => system.step(initial.input, initial.state), /late action failure/);
  assert.deepEqual(initial.state, before);
  fail = false;
  const retried = system.step(initial.input, initial.state);
  assert.deepEqual(retried.state, reference(initial, segments, resources, 0).state);
  assert.deepEqual(initial.state, before);
});
