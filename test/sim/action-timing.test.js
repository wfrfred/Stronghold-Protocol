import { setData } from "../../dist/core/tactical/unit/effect/effect.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { battle, unit, actionDefinition } from '../helpers/action-fixture.js';
import { getUnit, updateUnit, registerUnit, battlefieldView } from '../../dist/core/tactical/battle/state.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { startAction } from '../../dist/core/tactical/unit/capability/action/execution.js';
import { compileAction } from '../../dist/core/tactical/unit/capability/action/compile.js';
import { setAttackSpeedContribution, removeAttackSpeedContribution, setBaseAttackTimeContribution, removeBaseAttackTimeContribution } from '../../dist/core/tactical/unit/capability/action/capability.js';
import { resolveAttackSpeed, resolveBaseAttackTime, resolveActionIntervalTicks } from '../../dist/core/tactical/unit/capability/action/timing.js';
import { copyUnitSnapshot } from '../../dist/core/tactical/unit/snapshot.js';
import { create as modifier } from '../../dist/core/tactical/unit/contribution/value.js';
import * as effects from '../../dist/core/tactical/unit/effect/operations.js';
import { get } from '../../dist/core/tactical/unit/effect/operations.js';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { createLegacyCombatSpec } from '../../dist/legacy/combat.js';
import { createEnemyDefinition } from '../../dist/core/tactical/unit/archetype/enemy.js';
import { createRouteDefinition } from '../../dist/core/tactical/unit/capability/locomotion/route/definition.js';

const ref = { type: 'EFFECT', unitId: 0, effectId: 0 };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
const actor = (baseAttackTimeTicks = 30, recoveryTicks = 0) => unit(0, { action: actionDefinition(1, { baseAttackTimeTicks, recoveryTicks }) });
const target = () => unit(1, { hp: 1e6 });

function refresh(state) {
  const self = get(state, ref);
  state = updateUnit(state, ({ ...getUnit(state, 0), action: setAttackSpeedContribution(getUnit(state, 0).action, { id: 'timing/speed', value: [modifier({ addition: self.data.speed })] }) }));
  return updateUnit(state, ({ ...getUnit(state, 0), action: setBaseAttackTimeContribution(getUnit(state, 0).action, { id: 'timing/time', value: [self.data.time] }) }));
}

function tempo(speed = 100, time = modifier()) {
  return { id: 'timing-buff', initialize: () => ({ speed, time }), onEnable: state => refresh(state),
    onDisable: (state, ctx) => {
      state = updateUnit(state, ({ ...ctx.unit, action: removeAttackSpeedContribution(ctx.unit.action, 'timing/speed') }));
      return updateUnit(state, ({ ...getUnit(state, ctx.unit.id), action: removeBaseAttackTimeContribution(getUnit(state, ctx.unit.id).action, 'timing/time') }));
    },
  };
}
const install = (state, definition, tick = 0, expires = null) => effects.install({ ...state, tick }, getUnit(state, 0), definition, { scopes: expires === null ? [] : [{ type: 'TICK', tick: expires }] }).state;
const edit = (state, change) => refresh(effects.replaceEffect(state, { type: "EFFECT", unitId: 0, effectId: ref.effectId }, setData(get(state, ref), { ...get(state, ref).data, ...change })));
function values(state) {
  const current = getUnit(state, 0);
  const context = { unit: current, battlefield: battlefieldView(state) };
  return [resolveAttackSpeed(current.definition.action, current.action, context), resolveBaseAttackTime(current.definition.action.normalAction, current.action, context), resolveActionIntervalTicks(current.definition.action.normalAction, current.definition.action, current.action, context)];
}
const advance = (state, tick, resources = new CombatResources(), compiled) => startAction({ ...state, tick }, { sourceUnitId: 0, compiled: compiled ?? compileAction(getUnit(state, 0).definition.action.normalAction, resources), tick, mayStart: true }, resources);
const actions = state => state.events.filter(event => event.type === 'ACTION').length;
function spec(source, maxTicks) {
  return { ...createLegacyCombatSpec({ rows: 1, columns: 8, operators: [], enemies: [], maxTicks, seed: 17 }),
    initialUnits: [{ definition: source.definition, position: source.position, effects: source.effects, states: { action: source.action } }, { definition: target().definition, position: [1, 0] }],
    schedule: { type: 'TIMELINE', spawns: [{ definition: createEnemyDefinition({ id: 'future', vitality: { maxHp: 1 }, locomotion: { moveSpeedPerTick: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } } }),
      route: createRouteDefinition({ pathMotionMode: 'WALK', startPosition: [0, 7], endPosition: [0, 1], spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [], allowDiagonalMove: false, visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true }),
      tick: maxTicks + 1, timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true, notCountInTotal: false }] },
  };
}

test('action timing: ASPD floor, interval cap and BAT algebra remain distinct', () => {
  const initial = battle(actor(), target());
  let state = install(initial, tempo(-200, modifier({ addition: -6, multiplier: 0.5, finalAddition: 3, finalScaler: 0.5 })));
  assert.deepEqual(values(state), [20, 19.5, 97.5]);
  state = edit(state, { speed: 900 });
  assert.deepEqual(values(state), [1000, 19.5, 3.25]);
  state = edit(state, { time: modifier({ addition: -100 }) });
  assert.deepEqual(values(state), [1000, 0, 1]);
  assert.deepEqual(values(initial), [100, 30, 30]);
});

test('action timing: lifecycle updates both slots while snapshots preserve shared immutable inputs', () => {
  const initial = battle(actor(), target());
  const installed = install(initial, tempo(100, modifier({ finalScaler: 0.5 })));
  assert.deepEqual(values(installed), [200, 15, 7.5]);
  const snapshot = copyUnitSnapshot(getUnit(installed, 0));
  assert.equal(snapshot.action, getUnit(installed, 0).action);
  const disabled = effects.setEnabled(installed, ref, false);
  assert.deepEqual(values(disabled), [100, 30, 30]);
  const enabled = effects.setEnabled(disabled, ref, true);
  assert.deepEqual(values(enabled), [200, 15, 7.5]);
  const ended = effects.end(enabled, ref);
  assert.deepEqual(values(ended), [100, 30, 30]);
  assert.equal(snapshot.action.attackSpeed.length, 1);
  assert.equal(getUnit(ended, 0).action.attackSpeed.length, 0);
  assert.deepEqual(values(installed), [200, 15, 7.5]);
});

test('action timing: speed-up and slow-down preserve completed cooldown percentage', () => {
  const initial = advance(battle(actor(), target()), 0);
  let state = advance(install(initial, tempo(), 15), 15);
  close(getUnit(state, 0).action.readyAtTick, 22.5);
  state = advance(effects.setEnabled(state, ref, false), 18);
  close(getUnit(state, 0).action.readyAtTick, 27);
  state = advance(state, 26);
  assert.equal(actions(state), 1);
  state = advance(state, 27);
  assert.equal(actions(state), 2);
  assert.equal(getUnit(initial, 0).action.readyAtTick, 30);
});

test('action timing: BAT updates change cooldown without rescaling recovery', () => {
  const initial = advance(battle(actor(30, 20), target()), 0);
  const changed = advance(install(initial, tempo(0, modifier({ finalScaler: 0.5 })), 10), 10);
  close(getUnit(changed, 0).action.readyAtTick, 20);
  assert.equal(getUnit(changed, 0).action.recoveryUntilTick, 20);
  assert.equal(getUnit(initial, 0).action.readyAtTick, 30);
});

test('action timing: live contributions read the input version rather than installation samples', () => {
  const definition = { id: 'live-timing', initialize: () => ({}), onEnable: (state, ctx) => {
    state = updateUnit(state, ({ ...ctx.unit, action: setAttackSpeedContribution(ctx.unit.action, { id: 'live/speed', value: ({ unit }) => [modifier({ addition: unit.vitality.hp })] }) }));
    return updateUnit(state, ({ ...getUnit(state, 0), action: setBaseAttackTimeContribution(getUnit(state, 0).action, { id: 'live/time', value: ({ unit }) => [modifier({ addition: unit.vitality.hp / 10 })] }) }));
  } };
  const installed = install(battle(actor(), target()), definition);
  assert.deepEqual(values(installed), [200, 40, 20]);
  const current = getUnit(installed, 0);
  const damaged = updateUnit(installed, { ...current, vitality: { ...current.vitality, hp: 50 } });
  assert.deepEqual(values(damaged), [150, 35, 35 / 1.5]);
  assert.deepEqual(values(installed), [200, 40, 20]);
});

test('action timing: delayed targeting resumes without accumulating missed attacks', () => {
  const source = actor(4.5);
  const initial = advance(battle(source), 0);
  assert.equal(getUnit(initial, 0), source);
  let state = advance(registerUnit(initial, target()), 101);
  assert.equal(getUnit(state, 0).action.readyAtTick, 105.5);
  state = advance(state, 101);
  assert.equal(actions(state), 1);
});

test('action timing: 600 ASPD preserves fractional 30 Hz cadence across pure state transitions', () => {
  const initial = install(battle(actor(27), target()), tempo(500));
  assert.deepEqual(values(initial), [600, 27, 4.5]);
  const run = () => {
    let state = initial;
    for (let tick = 0; tick < 1200; tick++) state = advance(state, tick);
    return state;
  };
  const actual = run();
  const ticks = actual.events.filter(event => event.type === 'ACTION').map(event => event.tick);
  assert.equal(ticks.length, Math.ceil(1200 / 4.5));
  assert.deepEqual(ticks.slice(0, 8), [0, 5, 9, 14, 18, 23, 27, 32]);
  assert.deepEqual(run(), actual);
});

test('action timing: tempo expiry preserves an accepted WAIT and recovery deadline', () => {
  const installed = install(battle(actor(30, 8), target()), tempo(), 0, 2);
  const resources = new CombatResources();
  const rt = new BattleRuntime(spec(getUnit(installed, 0), 35), { combat: resources, compileAction: (definition, ports) => {
    const compiled = compileAction(definition, ports);
    return { ...compiled, program: [{ type: 'WAIT', allowNewAction: false, resolve: () => ({ type: 'UNTIL_TICK', targetTick: 5 }) }, ...compiled.program] };
  } });
  rt.step();
  const accepted = rt.snapshot();
  assert.equal(accepted.units[0].action.readyAtTick, 15);
  assert.equal(accepted.units[0].action.recoveryUntilTick, 8);
  rt.step(); rt.step();
  const expired = rt.snapshot();
  assert.equal(expired.units[0].action.readyAtTick, 28);
  assert.equal(expired.units[0].action.recoveryUntilTick, 8);
  assert.equal(expired.actionExecution.executions[0].wait.targetTick, 5);
  const events = [];
  while (rt.snapshot().tickIndex <= 5) events.push(...rt.step().events);
  assert.equal(events.find(event => event.type === 'DAMAGE').tick, 5);
});

test('action timing: a failed Tick never publishes recomputed cooldown', () => {
  const installed = install(battle(actor(), target()), tempo(), 0, 15);
  const resources = new CombatResources();
  let fail = false;
  const rt = new BattleRuntime(spec(getUnit(installed, 0), 40), { combat: resources, compileAction: (definition, ports) => {
    const compiled = compileAction(definition, ports);
    return { ...compiled, bind: context => { if (fail) throw new Error('timing failed'); return compiled.bind(context); } };
  } });
  rt.step();
  while (rt.snapshot().tickIndex < 15) rt.step();
  const before = rt.snapshot();
  fail = true;
  assert.throws(() => rt.step(), /timing failed/);
  assert.deepEqual(rt.snapshot(), before);
});
