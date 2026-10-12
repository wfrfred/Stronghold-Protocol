import assert from 'node:assert/strict';
import { test } from 'node:test';
import { battle, unit, actionDefinition } from '../helpers/action-fixture.js';
import { compileAction } from '../../dist/core/tactical/unit/capability/action/compile.js';
import { compile as compileOperation } from '../../dist/core/tactical/unit/capability/action/operation.js';
import { startAction } from '../../dist/core/tactical/unit/capability/action/execution.js';
import { getUnit, updateUnit, removeUnit, battlefieldView } from '../../dist/core/tactical/battle/state.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { setAttackContribution } from '../../dist/core/tactical/unit/capability/offense/capability.js';
import { create as modifier } from '../../dist/core/tactical/unit/contribution/value.js';
import { emptyCall } from '../../dist/core/tactical/battle/execution/call.js';
import { createDamageOperands } from '../../dist/core/tactical/unit/capability/vitality/damage/contract.js';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { createLegacyCombatSpec } from '../../dist/legacy/combat.js';
import { setHook } from '../../dist/core/tactical/unit/capability/vitality/damage/hook.js';
import { removeUnitWithEffects } from '../../dist/core/tactical/battle/execution/unit-lifecycle.js';
import * as effects from '../../dist/core/tactical/unit/effect/operations.js';
import { addStatusContribution, removeStatusContribution, hasStatusFlag } from '../../dist/core/tactical/unit/capability/status/capability.js';

const context = (bindings = new Map([['primary', [1]]])) => ({ sourceUnitId: 0, executionId: 0, acceptedAtTick: 0, inputTargetUnitId: 1, tick: 7, bindings, samples: {}, call: emptyCall });
const start = (state, compiled, resources = new CombatResources(), tick = 0, mayStart = true) => startAction(state, { sourceUnitId: 0, compiled, tick, mayStart }, resources);
const status = {
  id: 'status-prefix', initialize: () => ({}),
  onEnable: (state, ctx) => updateUnit(state, { ...ctx.unit, status: addStatusContribution(ctx.unit.status, { id: `status/${ctx.self.id}`, flags: ['INVINCIBLE'] }) }),
  onDisable: (state, ctx) => updateUnit(state, { ...ctx.unit, status: removeStatusContribution(ctx.unit.status, `status/${ctx.self.id}`) }),
};

function runtime(units, resources, compile) {
  return new BattleRuntime({ ...createLegacyCombatSpec({ rows: 1, columns: 8, operators: [], enemies: [], maxTicks: 10, seed: 17 }), initialUnits: units.map(value => ({ definition: value.definition, position: value.position, effects: value.effects, states: { vitality: value.vitality, ...(value.action === undefined ? {} : { action: value.action }) } })) }, { combat: resources, compileAction: compile });
}

test('combat program: compiled operations use pure settlement ports and observe prior returned state', () => {
  const definition = actionDefinition();
  const action = { ...definition, targetGroups: definition.targetGroups.map(group => ({ ...group, operations: [{ type: 'DAMAGE', powerSource: 'SOURCE_ATTACK', power: 1, damageType: 'PHYSICAL' }] })), followUps: [{ receiver: { type: 'SOURCE' }, operation: { type: 'HEAL', power: 5, ignoreHealFree: false } }] };
  const initial = battle(unit(0, { action: true }), unit(1));
  const calls = [];
  const compiled = compileAction(action, {
    settleDamage: (state, request) => {
      calls.push({ request });
      const target = getUnit(state, 1);
      return { state: updateUnit(state, { ...target, vitality: { ...target.vitality, hp: target.vitality.hp - request.operands.power } }), value: undefined };
    },
    settleHealing: (state, request) => { calls.push({ request, targetHp: getUnit(state, 1).vitality.hp }); return { state, value: undefined }; },
  });
  const bindings = compiled.bind({ source: getUnit(initial, 0), battlefield: battlefieldView(initial) });
  let state = initial;
  for (const segment of compiled.program) state = segment.run(state, context(bindings)).state;
  assert.deepEqual([...bindings], [['primary', [1]]]);
  assert.equal(calls[0].request.operands.power, 10);
  assert.equal(calls[0].request.tick, 7);
  assert.equal(calls[1].request.targetUnitId, 0);
  assert.equal(calls[1].targetHp, 90);
  assert.equal(getUnit(state, 1).vitality.hp, 90);
  assert.equal(getUnit(initial, 1).vitality.hp, 100);
});

test('combat program: custom compiled operations can update a target without Vitality', () => {
  const source = unit(0, { action: true });
  const target = unit(1, { vitality: undefined });
  const initial = battle(source, target);
  const resources = new CombatResources();
  let calls = 0;
  const compiled = compileAction(source.definition.action.normalAction, resources, () => (state, ctx) => {
    calls++;
    return updateUnit(state, { ...getUnit(state, ctx.targetUnitId), position: [2, 0] });
  });
  const result = start(initial, { ...compiled, bind: () => new Map([['primary', [1]]]) }, resources);
  assert.equal(calls, 1);
  assert.deepEqual(getUnit(result, 1).position, [2, 0]);
  assert.deepEqual(getUnit(initial, 1).position, [1, 0]);
  assert.equal('vitality' in getUnit(result, 1), false);
});

test('combat program: ordered segments rebind after damage removes the first target', () => {
  const resources = new CombatResources();
  const source = unit(0, { action: true });
  const initial = battle(source, unit(1, { hp: 7 }), unit(2));
  const compiled = compileAction(source.definition.action.normalAction, resources);
  let observed;
  const result = start(initial, { ...compiled, program: [
    ...compiled.program,
    { type: 'EXECUTE', run: (state, ctx) => {
      observed = { first: getUnit(state, 1), hp: getUnit(state, 2).vitality.hp };
      return { state, value: { bindings: compiled.bind({ source: getUnit(state, 0), battlefield: battlefieldView(state) }) } };
    } }, ...compiled.program,
  ] }, resources);
  assert.deepEqual(observed, { first: undefined, hp: 100 });
  assert.equal(getUnit(result, 2).vitality.hp, 93);
});

test('combat program: live source attack reads the passed version and fixed power remains independent', () => {
  const resources = new CombatResources();
  const initial = battle(unit(0), unit(1));
  const boosted = updateUnit(initial, ({ ...getUnit(initial, 0), offense: setAttackContribution(getUnit(initial, 0).offense, { id: 'bonus', value: [modifier({ addition: 15 })] }) }));
  const live = compileOperation({ type: 'DAMAGE', power: 1, powerSource: 'SOURCE_ATTACK', damageType: 'TRUE' }, resources);
  const result = live(boosted, { sourceUnitId: 0, targetUnitId: 1, tick: 0, call: emptyCall });
  assert.equal(getUnit(result, 1).vitality.hp, 75);
  assert.equal(getUnit(boosted, 1).vitality.hp, 100);
  assert.equal(getUnit(initial, 0).offense.attack.length, 0);
});

test('combat program: missing live source skips current attack while fixed power still settles', () => {
  const resources = new CombatResources();
  const state = battle(unit(1));
  const ctx = { sourceUnitId: 0, targetUnitId: 1, tick: 0, call: emptyCall };
  const live = compileOperation({ type: 'DAMAGE', power: 1, powerSource: 'SOURCE_ATTACK', damageType: 'TRUE' }, resources);
  const fixed = compileOperation({ type: 'DAMAGE', power: 5, damageType: 'TRUE' }, resources);
  assert.equal(live(state, ctx), state);
  assert.equal(getUnit(fixed(state, ctx), 1).vitality.hp, 95);
});

test('combat program: zero HP alone does not invalidate a physically present source attack query', () => {
  const resources = new CombatResources();
  const source = unit(0);
  const initial = battle({ ...source, vitality: { ...source.vitality, hp: 0 } }, unit(1));
  const live = compileOperation({ type: 'DAMAGE', power: 1, powerSource: 'SOURCE_ATTACK', damageType: 'TRUE' }, resources);
  const result = live(initial, { sourceUnitId: 0, targetUnitId: 1, tick: 0, call: emptyCall });
  assert.equal(getUnit(result, 1).vitality.hp, 90);
});

test('combat program: lethal retaliation removes the source before a later unsampled operation', () => {
  const resources = new CombatResources();
  const source = unit(0, { hp: 10, action: actionDefinition(7, { targetGroups: actionDefinition().targetGroups.map(group => ({ ...group, operations: [
    { type: 'DAMAGE', power: 1, powerSource: 'SOURCE_ATTACK', damageType: 'TRUE' },
    { type: 'DAMAGE', power: 1, powerSource: 'SOURCE_ATTACK', damageType: 'TRUE' },
  ] })) }) });
  const target = ({ ...unit(1), vitality: setHook(unit(1).vitality, { id: 'retaliation', stage: 'reaction', priority: 0, enabled: ctx => ctx.request.targetUnitId === ctx.unit.id,
    invoke: (state, ctx, input) => {
      const damage = resources.settleDamage(state, { sourceUnitId: 1, targetUnitId: 0, tick: ctx.tick, damageType: 'TRUE', operands: createDamageOperands(10) }, ctx.call);
      return { state: damage.state, value: undefined };
    },
  }) });
  const result = start(battle(source, target), compileAction(source.definition.action.normalAction, resources), resources);
  assert.equal(getUnit(result, 0), undefined);
  assert.equal(getUnit(result, 1).vitality.hp, 90);
});

test('combat program: Runtime caches compiled definitions across ticks and snapshots', () => {
  let compilations = 0;
  const actor = unit(0, { action: true });
  const resources = new CombatResources();
  const rt = runtime([actor, unit(1)], resources, (definition, services) => { compilations++; return compileAction(definition, services); });
  rt.step();
  const before = rt.snapshot();
  rt.step();
  assert.equal(compilations, 1);
  assert.equal(before.units[0].definition, rt.snapshot().units[0].definition);
  assert.equal(before.units[1].vitality.hp, 93);
});

test('combat program: a throwing callback leaves no changes in the published Runtime', () => {
  const resources = new CombatResources();
  const rt = runtime([unit(0, { action: true }), unit(1)], resources, (definition, services) => ({ ...compileAction(definition, services), program: [
    { type: 'EXECUTE', run: state => { state = updateUnit(state, { ...getUnit(state, 1), position: [3, 0] }); throw new Error('receiver failed'); } },
  ] }));
  const before = rt.snapshot();
  assert.throws(() => rt.step(), /receiver failed/);
  assert.deepEqual(rt.snapshot(), before);
});

test('combat program: Effect expiration removes only its own contribution and keeps baseline status', () => {
  const original = unit(0, { status: { initialFlags: ['INVISIBLE'] } });
  const initial = battle(original);
  const installed = effects.install(initial, original, status, { scopes: [{ type: 'TICK', tick: 1 }] }).state;
  assert.equal(hasStatusFlag(getUnit(installed, 0), 'INVINCIBLE'), true);
  const expired = effects.advance({ ...installed, tick: 1 });
  assert.equal(hasStatusFlag(getUnit(expired, 0), 'INVINCIBLE'), false);
  assert.equal(hasStatusFlag(getUnit(expired, 0), 'INVISIBLE'), true);
  assert.equal(hasStatusFlag(getUnit(installed, 0), 'INVINCIBLE'), true);
});

test('combat program: source retirement ends explicit lifetime dependencies and preserves mere provenance', () => {
  const resources = new CombatResources();
  let state = battle(unit(0), unit(1));
  const sourceOnly = { id: 'source-only', initialize: () => ({}) };
  const owned = { id: 'owned', initialize: () => ({}) };
  state = effects.install(state, getUnit(state, 1), sourceOnly, { source: 0 }).state;
  state = effects.install(state, getUnit(state, 1), owned, { source: 0, scopes: [{ type: 'UNIT', unitId: 0 }] }).state;
  const result = removeUnitWithEffects(state, 0, 'RETREAT', resources, 0);
  assert.deepEqual(getUnit(result, 1).effects.values().map(value => value.definition.id), ['source-only']);
});

test('combat program: readiness gates binding and current targets live only in execution and reports', () => {
  const resources = new CombatResources();
  const actor = unit(0, { action: true });
  const initial = battle(actor, unit(1));
  let bindings = 0;
  const compiled = { ...compileAction(actor.definition.action.normalAction, resources), bind: () => { bindings++; return new Map([['primary', [1]]]); } };
  const started = start(initial, compiled, resources);
  const cooling = start(started, compiled, resources, 1);
  assert.equal(bindings, 1);
  assert.equal(cooling, started);
  assert.equal(getUnit(started, 0).action.readyAtTick, 10);
  assert.equal(getUnit(initial, 0).action.readyAtTick, 0);
  start(cooling, compiled, resources, 10);
  assert.equal(bindings, 2);
  assert.equal('targetUnitId' in getUnit(started, 0).action, false);
});

test('combat program: immediate source removal finishes entered business and prevents successors', () => {
  const resources = new CombatResources();
  const actor = unit(0, { action: true });
  const compiled = compileAction(actor.definition.action.normalAction, resources);
  let successor = false;
  const result = start(battle(actor, unit(1)), { ...compiled, program: [
    { type: 'EXECUTE', run: (state, ctx) => {
      state = effects.install(state, getUnit(state, 1), status, { scopes: [{ type: 'ACTION', executionId: ctx.executionId }] }, ctx.call).state;
      state = removeUnit(state, 0, 'RETREAT');
      assert.equal(hasStatusFlag(getUnit(state, 1), 'INVINCIBLE'), true);
      state = updateUnit(state, { ...getUnit(state, 1), position: [2, 0] });
      return { state, value: undefined };
    } }, { type: 'EXECUTE', run: state => { successor = true; return { state, value: undefined }; } },
  ] }, resources);
  assert.equal(successor, false);
  assert.deepEqual(getUnit(result, 1).position, [2, 0]);
  assert.equal(hasStatusFlag(getUnit(result, 1), 'INVINCIBLE'), false);
  assert.equal(result.events.some(event => event.type === 'ACTION_CANCELLED'), true);
});


test('combat program: a leaving source cannot start another action', () => {
  const resources = new CombatResources();
  const actor = unit(0, { action: true });
  const state = battle({ ...actor, lifecycle: 'LEAVING' }, unit(1));
  const compiled = compileAction(actor.definition.action.normalAction, resources);
  assert.equal(start(state, compiled, resources), state);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.actionExecutions.executions, []);
});
