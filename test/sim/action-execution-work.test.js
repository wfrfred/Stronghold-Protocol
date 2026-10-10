import { fixtureBattlefield } from "../helpers/battlefield.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCombat } from '../../dist/core/tactical/battle/steps/combat.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { createBattleState } from '../../dist/core/tactical/battle/execution/context.js';
import { ActionExecutionWork } from '../../dist/core/tactical/unit/capability/action/internal/executions.js';
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
  return { state, battlefield };
}

function workingState(initial, actions = initial.state, tick = 0) {
  return createBattleState(fixtureBattlefield(initial.battlefield), undefined, new ActionExecutionWork(actions), tick);
}

function reference(initial, segments, resources, tick) {
  let state = initial.state;
  let work = createBattleState(fixtureBattlefield(initial.battlefield));
  for (const id of initial.battlefield.unitIds) {
    for (const execution of state.executions.filter(execution => execution.sourceUnitId === id)) {
      const advanced = resumeActionExecution(
        work,
        state,
        { executionId: execution.id, segments, tick },
        resources,
      );
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
      return { samples: { identity: context.executionId } };
    } },
    { type: 'WAIT', allowNewAction: false, blockingMovement: true,
      resolve: () => ({ type: 'FOR_TICKS', ticks: 3 }) },
  ];
  const combat = createCombat(resources, action => ({ definition: action, bind: () => new Map(), program: segments }));
  const before = structuredClone(initial.state);
  const expected = reference(initial, segments, resources, 0);
  const expectedOrder = [...observed];
  observed.length = 0;
  const working = workingState(initial);
  assert.equal(working.actionExecutions.result(), initial.state);
  combat.advance(working, 0);
  const actual = working.actionExecutions.result();
  assert.equal(working.actionExecutions.result(), actual);
  assert.notEqual(actual, initial.state);

  assert.deepEqual(observed, expectedOrder);
  assert.deepEqual(actual, expected.state);
  assert.deepEqual(initial.state, before);
  const originals = new Map(initial.state.executions.map(execution => [execution.id, execution]));
  for (const execution of actual.executions) {
    assert.equal(execution.definition, originals.get(execution.id).definition);
    assert.equal(execution.bindings, originals.get(execution.id).bindings);
  }
  assert.deepEqual(working.removedUnits, []);
  assert.deepEqual(working.events, []);
  assert.equal(combat.allowsMovement(actual, 0), false);
  assert.equal(combat.allowsMovement(actual, 128), true);
  const repeated = workingState(initial);
  combat.advance(repeated, 0);
  assert.deepEqual(repeated.actionExecutions.result(), actual);
  const advanced = workingState(initial, actual, 1);
  combat.advance(advanced, 1);
  const next = advanced.actionExecutions.result();
  assert.equal(advanced.actionExecutions.result(), next);
  assert.equal(next.executions.every(execution => execution.wait.remainingTicks === 2), true);
  assert.equal(actual.executions.every(execution => execution.wait.remainingTicks === 3), true);
  const prior = new Map(actual.executions.map(execution => [execution.id, execution]));
  for (const execution of next.executions) {
    assert.equal(execution.bindings, prior.get(execution.id).bindings);
    assert.equal(execution.samples, prior.get(execution.id).samples);
  }
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
    const entered = workingState(initial);
    combat.advance(entered, 0);
    const enteredActions = entered.actionExecutions.result();
    const unchanged = workingState(initial, enteredActions);
    combat.advance(unchanged, 0);
    assert.equal(unchanged.actionExecutions.result(), enteredActions);
    const single = resumeActionExecution(
      createBattleState(fixtureBattlefield(initial.battlefield)),
      enteredActions,
      { executionId: enteredActions.executions[0].id, segments, tick: 0 },
      resources,
    );
    assert.equal(single.state, enteredActions);
    assert.deepEqual(unchanged.events, []);
    assert.deepEqual(unchanged.removedUnits, []);
  }
});

test('action execution work: a later callback exception leaves the input execution batch retryable', () => {
  const initial = fixture(3, 1);
  const resources = new CombatResources();
  let fail = true;
  const segments = [
    { type: 'EXECUTE', run: context => {
      if (fail && context.sourceUnitId === 1) throw new Error('late action failure');
      return { samples: { source: context.sourceUnitId } };
    } },
    { type: 'WAIT', resolve: () => ({ type: 'FOR_TICKS', ticks: 2 }) },
  ];
  const combat = createCombat(resources, action => ({ definition: action, bind: () => new Map(), program: segments }));
  const before = structuredClone(initial.state);
  assert.throws(() => combat.advance(workingState(initial), 0), /late action failure/);
  assert.deepEqual(initial.state, before);
  fail = false;
  const retried = workingState(initial);
  combat.advance(retried, 0);
  assert.deepEqual(retried.actionExecutions.result(), reference(initial, segments, resources, 0).state);
  assert.deepEqual(initial.state, before);
});
