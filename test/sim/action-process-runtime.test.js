import * as effects from '../../dist/core/tactical/unit/effect/operations.js';
import { createDamageOperands } from '../../dist/core/tactical/unit/capability/vitality/damage/contract.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unit, actionDefinition, assertData } from '../helpers/action-fixture.js';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { createLegacyCombatSpec } from '../../dist/legacy/combat.js';
import { compileAction } from '../../dist/core/tactical/unit/capability/action/compile.js';
import { createDefinition } from '../../dist/core/tactical/unit/archetype/enemy.js';
import { createRouteDefinition } from '../../dist/core/tactical/unit/capability/locomotion/route/definition.js';
import { getUnit, updateUnit } from '../../dist/core/tactical/battle/state.js';

function spec(initialUnits) {
  return { ...createLegacyCombatSpec({ rows: 1, columns: 8, operators: [], enemies: [], maxTicks: 20, seed: 17 }),
    initialUnits: initialUnits.map(value => ({ definition: value.definition, position: value.position })),
    schedule: { type: 'TIMELINE', spawns: [{ definition: createDefinition({ id: 'future', vitality: { maxHp: 1 }, locomotion: { moveSpeedPerTick: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } } }),
      route: createRouteDefinition({ pathMotionMode: 'WALK', startPosition: [0, 7], endPosition: [0, 1], spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [], allowDiagonalMove: false, visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true }),
      tick: 19, timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true, notCountInTotal: false }] },
  };
}

function delayed(compiled, ticks) {
  return { ...compiled, program: [{ type: 'WAIT', allowNewAction: false, blockingMovement: true, resolve: () => ({ type: 'FOR_TICKS', ticks }) }, { type: 'RELEASE', markerId: 'normal' }, ...compiled.program] };
}

test('action runtime: delayed actions preserve ordinary same-tick order and data-only progress', () => {
  const first = unit(0, { action: actionDefinition(7) });
  const instant = unit(1, { side: 'ALLY', action: actionDefinition(3) });
  const resources = new CombatResources();
  const runtime = new BattleRuntime(spec([first, instant, unit(2)]), { combat: resources,
    compileAction: (definition, services) => definition === first.definition.action.normalAction ? delayed(compileAction(definition, services), 2) : compileAction(definition, services),
  });
  const one = runtime.step();
  const snapshot = runtime.snapshot();
  assert.deepEqual(one.events.filter(event => event.type === 'ACTION').map(event => event.sourceUnitId), [0, 1]);
  assert.deepEqual(one.events.filter(event => event.type === 'DAMAGE').map(event => [event.sourceUnitId, event.amount]), [[1, 3]]);
  assert.equal(snapshot.actionExecution.executions.length, 1);
  assertData(assert, snapshot.actionExecution);
  const saved = JSON.stringify(snapshot);
  assert.deepEqual(JSON.parse(saved).actionExecution, snapshot.actionExecution);
  assert.equal(runtime.step().events.some(event => event.type === 'ACTION_RELEASED'), false);
  const three = runtime.step();
  assert.deepEqual(three.events.filter(event => event.type === 'DAMAGE').map(event => event.amount), [7]);
  assert.equal(runtime.snapshot().actionExecution.executions.length, 0);
  assert.equal(snapshot.units.find(value => value.id === 2).vitality.hp, 97);
  assert.equal(JSON.stringify(snapshot), saved);
});

test('action runtime: a cancellation command precedes release and preserves sibling progress', () => {
  const runtime = new BattleRuntime(spec([unit(0, { action: true }), unit(1, { side: 'ALLY', action: true }), unit(2)]), {
    compileAction: (definition, resources) => delayed(compileAction(definition, resources), 1),
  });
  runtime.step();
  const second = runtime.step([{ type: 'CANCEL_ACTION_EXECUTION', executionId: 0 }]);
  assert.deepEqual(second.events.filter(event => event.type === 'ACTION_RELEASED').map(event => event.sourceUnitId), [1]);
  assert.deepEqual(second.events.filter(event => event.type === 'DAMAGE').map(event => event.sourceUnitId), [1]);
  assert.equal(runtime.snapshot().actionExecution.executions.length, 0);
});

test('action runtime: a throwing successor leaves the published Tick untouched', () => {
  const runtime = new BattleRuntime(spec([unit(0, { action: true }), unit(1)]), {
    compileAction: (definition, resources) => ({ ...compileAction(definition, resources), program: [
      { type: 'WAIT', allowNewAction: false, resolve: () => ({ type: 'FOR_TICKS', ticks: 1 }) },
      { type: 'EXECUTE', run: state => ({ state: updateUnit(state, { ...getUnit(state, 1), position: [3, 0] }), value: { samples: { changed: 1 } } }) },
      { type: 'EXECUTE', run: () => { throw new Error('continuation failed'); } },
    ] }),
  });
  runtime.step();
  const before = runtime.snapshot();
  assert.throws(() => runtime.step(), /continuation failed/);
  assert.deepEqual(runtime.snapshot(), before);
});

test('action runtime: ending an Action-owned Effect may settle nested host death before propagating an error', () => {
  const resources = new CombatResources();
  const terminal = { id: 'terminal-action-effect', initialize: () => ({}), onEnd: (state, context) => {
    state = resources.settleDamage(state, { sourceUnitId: 0, targetUnitId: context.unit.id, tick: context.tick, damageType: 'TRUE', operands: createDamageOperands(100) }, context.call).state;
    assert.equal(getUnit(state, context.unit.id), undefined);
    throw new Error('terminal finish failed');
  } };
  const rt = new BattleRuntime(spec([unit(0, { action: true }), unit(1)]), { combat: resources, compileAction: (definition, ports) => ({
    ...compileAction(definition, ports), program: [
      { type: 'EXECUTE', run: (state, context) => ({ state: effects.install(state, getUnit(state, 1), terminal, { scopes: [{ type: 'ACTION', executionId: context.executionId }] }, context.call).state, value: undefined }) },
      { type: 'WAIT', allowNewAction: false, resolve: () => ({ type: 'FOR_TICKS', ticks: 1 }) },
    ],
  }) });
  rt.step();
  const before = rt.snapshot();
  assert.throws(() => rt.step(), /terminal finish failed/);
  assert.deepEqual(rt.snapshot(), before);
});

test('action runtime: a waiting execution blocks routed movement until that execution completes', () => {
  const initial = spec([unit(0)]);
  const mover = unit(1, { action: true, side: 'ENEMY', locomotion: { moveSpeedPerTick: 0.1, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } }, blockable: { weight: 1 } });
  const route = createRouteDefinition({ pathMotionMode: 'WALK', startPosition: [0, 7], endPosition: [0, 1], spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [], allowDiagonalMove: false, visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true });
  initial.schedule = { ...initial.schedule, spawns: [{ definition: mover.definition, route, tick: 0, timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true, notCountInTotal: false }, ...initial.schedule.spawns] };
  const rt = new BattleRuntime(initial, { compileAction: (definition, ports) => delayed(compileAction(definition, ports), 2) });
  rt.step();
  const first = rt.snapshot().units.find(value => value.id === 1).position;
  rt.step();
  assert.deepEqual(rt.snapshot().units.find(value => value.id === 1).position, first);
  rt.step();
  assert.notDeepEqual(rt.snapshot().units.find(value => value.id === 1).position, first);
});
