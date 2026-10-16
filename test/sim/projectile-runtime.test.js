import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { battle, unit, actionDefinition } from '../helpers/action-fixture.js';

import { createDefinition as createProjectileDefinition } from '../../dist/core/tactical/battlefield/projectile/definition.js';
import { all, ref, launchProjectile, getProjectile, replaceProjectile, resolveProjectileAttackPower } from '../../dist/core/tactical/battlefield/projectile/operations.js';
import { advanceProjectiles, stopProjectile } from '../../dist/core/tactical/battlefield/projectile/settlement.js';
import { advanceProjectiles as advanceBattleProjectiles } from '../../dist/core/tactical/battle/steps/projectiles.js';
import { getUnit, updateUnit, removeUnit, registerUnit, battlefieldView } from '../../dist/core/tactical/battle/state.js';
import { createDamageOperands } from '../../dist/core/tactical/unit/capability/vitality/damage/contract.js';
import { createShapeGeometry } from '../../dist/core/tactical/geometry/shape.js';
import { setAttackContribution } from '../../dist/core/tactical/unit/capability/offense/capability.js';
import { create as modifier } from '../../dist/core/tactical/unit/contribution/value.js';
import { transition } from '../../dist/core/tactical/battlefield/state.js';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { createLegacyCombatSpec } from '../../dist/legacy/combat.js';
import { createDefinition } from '../../dist/core/tactical/unit/archetype/enemy.js';
import { createRouteDefinition } from '../../dist/core/tactical/unit/capability/locomotion/route/definition.js';
import * as actions from '../../dist/core/tactical/unit/action/operations.js';
import { setState } from '../../dist/core/tactical/unit/action/action.js';

const contactRange = { type: 'SHAPES', geometry: createShapeGeometry({ shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 0.3 }] }) };
const launchInput = {
  source: 0, traceTarget: 1, position: [0, 0], destination: [1, 0], cachedAtk: 10,
  speedPerTick: 1, contactRange, stopDelayTicks: 0,
};

function program({ id = 'shell', cachedOnly = false, acceptsContact, contact, stop } = {}) {
  return createProjectileDefinition({
    id, initialize: () => ({ contacts: 0 }),
    acceptsContact: acceptsContact ?? ((_context, target) => target.allegiance?.side === 'ENEMY'),
    contact: contact ?? ((state, context) => resolveDamage(state, {
      sourceUnitId: context.projectile.source, targetUnitId: context.targetUnitId, tick: context.tick,
      damageType: 'TRUE', operands: createDamageOperands(cachedOnly ? context.projectile.cachedAtk : resolveProjectileAttackPower(state, context.projectile)),
    }, context.call).state),
    ...(stop === undefined ? {} : { stop }),
  });
}

function launch(state, definition, overrides = {}, tick = 0) {
  return launchProjectile(state, definition, { ...launchInput, ...overrides }, tick);
}

const instances = state => all(state).map(reference => getProjectile(state, reference));
const findProjectile = (state, id) => instances(state).find(projectile => projectile.id === id);
const damageEvents = state => state.events.filter(event => event.type === 'DAMAGE');

function runtime(initialUnits, maxTicks = 20) {
  return new BattleRuntime({ ...createLegacyCombatSpec({ rows: 1, columns: 8, operators: [], enemies: [], maxTicks, seed: 17 }),
    initialUnits: initialUnits.map(value => ({ definition: value.definition, position: value.position })),
    schedule: { type: 'TIMELINE', spawns: [{ definition: createDefinition({ id: 'future', vitality: { maxHp: 1 }, locomotion: { moveSpeedPerTick: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } } }),
      route: createRouteDefinition({ pathMotionMode: 'WALK', startPosition: [0, 7], endPosition: [0, 1], spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [], allowDiagonalMove: false, visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true }),
      tick: 100, timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true, notCountInTotal: false }] },
  });
}

function actionLaunch(definition, overrides = {}, onLaunch = () => {}) {
  return (state) => {
    const launched = launchProjectile(state, definition, { ...launchInput, ...overrides }, state.tick);
    onLaunch(launched.value.id);
    return launched.state;
  };
}

test('projectile runtime: actions launch independent state and do not move on the release tick', () => {

  const shell = program();
  const observed = [];
  const release = actionLaunch(shell, { traceTarget: 2, destination: [2, 0], stopDelayTicks: 1 }, id => observed.push(id));
  const instant = unit(0, { action: actionDefinition(0, { output: release }) });
  const deferred = unit(1, { side: 'ALLY', action: actionDefinition(0, { windupTicks: 1, markerId: 'shell', output: release }) });
  const rt = runtime([instant, deferred, unit(2)]);
  const first = rt.step();
  assert.deepEqual(observed, [0]);
  assert.deepEqual(rt.snapshot().projectiles.instances.map(value => value.position), [[0, 0]]);
  assert.deepEqual(damageEvents(first), []);
  rt.step();
  assert.deepEqual(observed, [0, 1]);
  assert.deepEqual(rt.snapshot().projectiles.instances.map(value => value.position), [[1, 0], [0, 0]]);
  assert.equal(rt.snapshot().actions.instances.length, 0);
});

test('projectile runtime: missing trace targets preserve the last destination and query current receivers', () => {

  const shell = program();
  const initial = battle(unit(0), unit(1), { ...unit(2), position: [1.2, 0] });
  const launched = launch(initial, shell).state;
  const retreated = removeUnit(launched, 1, 'RETREAT');
  const reached = advanceProjectiles(retreated, 1);
  assert.deepEqual(damageEvents(reached).map(event => event.targetUnitId), [2]);
  assert.equal(getUnit(reached, 2).vitality.hp, 90);
  assert.equal(getUnit(initial, 2).vitality.hp, 100);
});

test('projectile runtime: frozen candidate identities read latest eligibility and ignore newly registered units', () => {

  const observed = [];
  const shell = program({
    acceptsContact: (_context, target) => target.allegiance?.side === 'ENEMY' && (target.id === 1 || target.vitality.hp < 100),
    contact: (state, context) => {
      observed.push(context.targetUnitId);
      if (context.targetUnitId === 1) {
        state = resolveDamage(state, { sourceUnitId: 0, targetUnitId: 2, tick: 1, damageType: 'TRUE', operands: createDamageOperands(1) }, context.call).state;
        state = registerUnit(state, { ...unit(3), position: [1, 0] });
      }
      return resolveDamage(state, { sourceUnitId: 0, targetUnitId: context.targetUnitId, tick: 1, damageType: 'TRUE', operands: createDamageOperands(10) }, context.call).state;
    },
  });
  const initial = launch(battle(unit(0), unit(1), { ...unit(2), position: [1.2, 0] }), shell).state;
  const reached = advanceProjectiles(initial, 1);
  assert.deepEqual(observed, [1, 2]);
  assert.equal(getUnit(reached, 2).vitality.hp, 89);
  assert.equal(getUnit(reached, 3).vitality.hp, 100);
  assert.deepEqual(reached.events.filter(event => event.type === 'PROJECTILE_HIT').map(event => event.targetUnitId), [1, 2]);
});

test('projectile runtime: live source attack, cached-only attack and missing-source fallback remain distinct', () => {
  for (const missing of [false, true]) {

    const live = program({ id: 'live' });
    const cached = program({ id: 'cached', cachedOnly: true });
    let state = launch(battle(unit(0), unit(1)), live).state;
    state = launch(state, cached).state;
    state = updateUnit(state, ({ ...getUnit(state, 0), offense: setAttackContribution(getUnit(state, 0).offense, { id: 'bonus', value: [modifier({ addition: 10 })] }) }));
    if (missing) state = removeUnit(state, 0, 'RETREAT');
    const arrived = advanceProjectiles(state, 1);
    assert.deepEqual(damageEvents(arrived).map(event => event.amount), missing ? [10, 10] : [20, 10]);
  }
});

test('projectile runtime: terminal battle freezes outstanding projectiles without stop callbacks', () => {

  let stops = 0;
  const shell = program({ stop: state => { stops++; return state; } });
  const rt = runtime([unit(0, { action: actionDefinition(0, { output: actionLaunch(shell, { destination: [100, 0], traceTarget: null }) }) }), unit(1)], 1);
  rt.step();
  const snapshot = rt.snapshot();
  assert.equal(snapshot.projectiles.instances.length, 1);
  assert.equal(stops, 0);
  rt.step();
  assert.deepEqual(rt.snapshot(), snapshot);
});

test('projectile runtime: hit history is published before contact and synchronous stop fallback observes it', () => {

  const observed = [];
  const shell = program({
    contact: (state, context) => {
      assert.deepEqual(getProjectile(state, ref(context.projectile)).hitUnitIds, [1]);
      state = stopProjectile(state, ref(context.projectile), context.tick, 'EXPLICIT', context.call);
      observed.push(['successor', getProjectile(state, ref(context.projectile))]);
      return state;
    },
    stop: (state, context) => { observed.push(['stop', context.projectile.hitUnitIds]); return state; },
  });
  const initial = launch(battle(unit(0), unit(1)), shell).state;
  const arrived = advanceProjectiles(initial, 1);
  assert.deepEqual(observed, [['stop', [1]], ['successor', undefined]]);
  assert.deepEqual(instances(arrived), []);
  assert.deepEqual(arrived.events.map(event => event.type), ['PROJECTILE_REACHED', 'PROJECTILE_STOPPED', 'PROJECTILE_HIT']);
});

test('projectile runtime: immutable copies replay arrival and stop without mutating samples', () => {

  const shell = program();
  const initial = launch(battle(unit(0), unit(1)), shell, { stopDelayTicks: 1 }).state;
  const arrived = advanceProjectiles(initial, 1);
  assert.deepEqual(advanceProjectiles(initial, 1), arrived);
  assert.equal(findProjectile(initial, 0).position[0], 0);
  assert.equal(findProjectile(arrived, 0).progress.type, 'WAITING_TO_STOP');
  const stopped = advanceProjectiles(arrived, 2);
  assert.deepEqual(instances(stopped), []);
  assert.equal(findProjectile(arrived, 0).progress.type, 'WAITING_TO_STOP');
  assert.equal(damageEvents(stopped).length, 1);
});

test('projectile runtime: a stop callback exception exposes no partial result or input mutation', () => {

  const shell = program({ stop: (state, context) => {
    state = resolveDamage(state, { sourceUnitId: 0, targetUnitId: 1, tick: context.tick, damageType: 'TRUE', operands: createDamageOperands(10) }, context.call).state;
    throw new Error('stop failed');
  } });
  const initial = launch(battle(unit(0), unit(1)), shell).state;
  assert.throws(() => advanceProjectiles(initial, 1), /stop failed/);
  assert.equal(getUnit(initial, 1).vitality.hp, 100);
  assert.equal(findProjectile(initial, 0).progress.type, 'FLYING');
  assert.deepEqual(initial.events, []);
});

test('projectile runtime: ordered launches share immutable payloads and preserve input ID allocation', () => {

  const shell = program();
  const input = { ...launchInput, source: null, traceTarget: null, destination: [100, 0], initialState: { contacts: 0, history: [1] } };
  const initial = battle();
  let state = initial;
  for (let index = 0; index < 32; index++) {
    const launched = launchProjectile(state, shell, input, 0);
    assert.equal(launched.value.id, index);
    state = launched.state;
  }
  assert.equal(initial.execution.nextProjectileId, 0);
  assert.deepEqual(instances(initial), []);
  assert.equal(state.execution.nextProjectileId, 32);
  assert.equal(findProjectile(state, 0).state, input.initialState);
  assert.equal(findProjectile(state, 0).contactRange, input.contactRange);
  const advanced = advanceProjectiles(state, 1);
  assert.equal(instances(advanced).every(value => value.position[0] === 1), true);
  assert.equal(instances(state).every(value => value.position[0] === 0), true);
  assert.equal(advanceProjectiles(advanced, 1), advanced);
});

test('projectile runtime: a retained pure launch function operates on explicit immutable branches', () => {

  const shell = program();
  const initial = battle();
  const first = launch(initial, shell);
  const sibling = launch(initial, shell);
  assert.equal(first.value.id, 0);
  assert.deepEqual(sibling, first);
  assert.deepEqual(instances(initial), []);
  const second = launch(first.state, shell);
  assert.equal(second.value.id, 1);
  assert.equal(first.state.execution.nextProjectileId, 1);
});

test('projectile runtime: stop callbacks see peer progress while prior input snapshots remain stable', () => {

  const observed = [];
  const shell = program({ stop: (state, context) => {
    observed.push({ id: context.projectile.id, first: findProjectile(state, 0)?.progress.type, second: findProjectile(state, 1)?.progress.type });
    const current = getProjectile(state, ref(context.projectile));
    state = replaceProjectile(state, { ...current, state: { contacts: current.state.contacts + 1 } });
    assert.equal(getProjectile(state, ref(context.projectile)).state.contacts, 1);
    return state;
  } });
  let initial = launch(battle(), shell, { source: null, traceTarget: null }).state;
  initial = launch(initial, shell, { source: null, traceTarget: null, destination: [100, 0] }).state;
  const progressed = advanceProjectiles(initial, 1);
  assert.deepEqual(observed, [{ id: 0, first: 'STOPPED', second: 'FLYING' }]);
  assert.deepEqual(instances(progressed).map(value => [value.id, value.position]), [[1, [1, 0]]]);
  const stopped = stopProjectile(progressed, ref(findProjectile(progressed, 1)), 1);
  assert.deepEqual(observed[1], { id: 1, first: undefined, second: 'STOPPED' });
  assert.deepEqual(instances(stopped), []);
  assert.equal(findProjectile(initial, 0).progress.type, 'FLYING');
  assert.equal(findProjectile(progressed, 1).state.contacts, 0);
});

test('projectile runtime: ordered command stops complete before survivors advance', () => {

  const observed = [];
  const shell = program({ stop: (state, context) => { observed.push(context.projectile.id); return state; } });
  let state = battle();
  for (let index = 0; index < 4; index++) state = launch(state, shell, { source: null, traceTarget: null, destination: [100, 0] }).state;
  const initial = state;
  state = advanceBattleProjectiles(state, 1, [2, 2, 999, 0].map(projectileId => ({ type: 'STOP_PROJECTILE', projectileId })));
  assert.deepEqual(observed, [2, 0]);
  assert.deepEqual(state.events.map(event => event.projectileId), [2, 0]);
  assert.deepEqual(instances(state).map(value => [value.id, value.position]), [[1, [1, 0]], [3, [1, 0]]]);
  assert.equal(instances(initial).every(value => value.position[0] === 0), true);
});

test('projectile storage: rejected edits preserve input facts and navigation maps', () => {
  const shell = createProjectileDefinition({ id: 'shell', initialize: () => ({}), acceptsContact: () => false });
  const launched = launchProjectile(battle(), shell, launchInput, 0);
  const initial = launched.state;
  const projectile = getProjectile(initial, launched.value);
  const changed = replaceProjectile(initial, { ...projectile, position: [1, 0] });
  assert.throws(() => changed.battlefield.projectiles.remove(999), /unknown projectile/);
  assert.strictEqual(findProjectile(initial, 0), projectile);
  assert.strictEqual(changed.battlefield.navigationMaps, initial.battlefield.navigationMaps);
  assert.strictEqual(changed.battlefield.spatial, initial.battlefield.spatial);
  assert.strictEqual(transition(initial.battlefield, []).state.navigationMaps, initial.battlefield.navigationMaps);
});

test('projectile definitions: shared identity needs no registration and each launch initializes its own state', () => {
  const definition = createProjectileDefinition({
    id: 'shared-shell', initialize: () => ({ charges: 2 }), acceptsContact: () => false,
  });
  const initial = battle();
  const first = launchProjectile(initial, definition, launchInput, 0);
  const second = launchProjectile(first.state, definition, launchInput, 0);
  const firstProjectile = getProjectile(second.state, first.value);
  const secondProjectile = getProjectile(second.state, second.value);
  assert.strictEqual(firstProjectile.definition, definition);
  assert.strictEqual(secondProjectile.definition, definition);
  assert.notStrictEqual(firstProjectile.state, secondProjectile.state);
  const changed = replaceProjectile(second.state, { ...firstProjectile, state: { charges: 1 } });
  assert.deepEqual(getProjectile(changed, first.value).state, { charges: 1 });
  assert.deepEqual(getProjectile(changed, second.value).state, { charges: 2 });
  assert.deepEqual(firstProjectile.state, { charges: 2 });
  assert.equal(initial.battlefield.projectiles.size, 0);
});

test('projectile references read current state and expire after their instance stops', () => {
  const definition = createProjectileDefinition({
    id: 'retained-reference', initialize: () => ({ charges: 2 }), acceptsContact: () => false,
  });
  const launched = launchProjectile(battle(), definition, launchInput, 0);
  const initial = getProjectile(launched.state, launched.value);
  const changed = replaceProjectile(launched.state, { ...initial, state: { charges: 1 } });
  assert.deepEqual(launched.value, { id: initial.id });
  assert.deepEqual(getProjectile(changed, launched.value).state, { charges: 1 });
  assert.deepEqual(getProjectile(launched.state, launched.value).state, { charges: 2 });
  assert.deepEqual(battlefieldView(changed).getProjectile(launched.value).state, { charges: 1 });
  const candidates = all(changed);
  const stopped = stopProjectile(changed, launched.value, 1);
  const replacement = launchProjectile(stopped, definition, launchInput, 1);
  assert.equal(getProjectile(replacement.state, launched.value), undefined);
  assert.equal(getProjectile(replacement.state, candidates[0]), undefined);
  assert.notEqual(replacement.value.id, launched.value.id);
  assert.deepEqual(getProjectile(replacement.state, replacement.value).state, { charges: 2 });
});

test('projectile definitions: heterogeneous callbacks retain pairing and equal names do not replace identity', () => {
  const observations = [];
  const charges = createProjectileDefinition({
    id: 'same-name', initialize: () => ({ charges: 2 }), acceptsContact: (_context, target) => target.id === 1,
    contact: (state, context) => {
      observations.push(['charges', context.projectile.state.charges]);
      return replaceProjectile(state, { ...context.projectile, state: { charges: 1 } });
    },
    stop: (state, context) => { observations.push(['charges-stop', context.projectile.state.charges]); return state; },
  });
  const label = createProjectileDefinition({
    id: 'same-name', initialize: () => ({ label: 'arrow' }), acceptsContact: (_context, target) => target.id === 1,
    contact: (state, context) => { observations.push(['label', context.projectile.state.label]); return state; },
    stop: (state, context) => { observations.push(['label-stop', context.projectile.state.label]); return state; },
  });
  const first = launchProjectile(battle(unit(0), unit(1)), charges, launchInput, 0);
  const second = launchProjectile(first.state, label, launchInput, 0);
  assert.equal(second.state.battlefield.projectiles.get(first.value.id, label), undefined);
  assert.equal(second.state.battlefield.projectiles.get(second.value.id, charges), undefined);
  assert.throws(() => replaceProjectile(second.state, {
    ...getProjectile(second.state, first.value), definition: label, state: { label: 'replacement' },
  }), /definition cannot change/);
  const arrived = advanceProjectiles(second.state, 1);
  assert.deepEqual(observations, [['charges', 2], ['charges-stop', 1], ['label', 'arrow'], ['label-stop', 'arrow']]);
  assert.deepEqual(instances(arrived), []);
  assert.strictEqual(getProjectile(second.state, first.value).definition, charges);
  assert.deepEqual(getProjectile(second.state, first.value).state, { charges: 2 });
});

test('projectile runtime: command stop callbacks see same-tick launches and a failing Tick is not published', () => {
  const scenario = failing => {

    const observed = [];
    const shell = program({ stop: (state, context) => {
      observed.push([context.projectile.id, getUnit(state, 1).vitality.hp, findProjectile(state, 3)?.progress.type]);
      state = resolveDamage(state, { sourceUnitId: 0, targetUnitId: 1, tick: context.tick, damageType: 'TRUE', operands: createDamageOperands(1) }, context.call).state;
      if (failing && context.projectile.id === 1) throw new Error('second stop failed');
      return state;
    } });
    const definition = {
      id: 'launch-sequence', intervalTicks: 10, speed: 100,
      start: state => ({ state, value: { emitted: false } }),
      step(state, self) {
        const count = self.state.emitted ? 1 : 3;
        for (let index = 0; index < count; index++) state = actionLaunch(shell, { traceTarget: null, destination: [100, 0] })(state);
        state = actions.replace(state, setState(self, { emitted: true }));
        return { state, value: self.state.emitted };
      },
    };
    const rt = runtime([unit(0, { action: definition }), unit(1)]);
    rt.step();
    return { rt, observed };
  };
  const commands = [3, 3, 999, 1, 0].map(projectileId => ({ type: 'STOP_PROJECTILE', projectileId }));
  const failed = scenario(true);
  const before = failed.rt.snapshot();
  assert.throws(() => failed.rt.step(commands), /second stop failed/);
  assert.deepEqual(failed.rt.snapshot(), before);
  const control = scenario(false);
  control.rt.step(commands);
  assert.deepEqual(control.observed, [[3, 100, 'STOPPED'], [1, 99, undefined], [0, 98, undefined]]);
  assert.equal(control.rt.snapshot().units.find(value => value.id === 1).vitality.hp, 97);
  assert.deepEqual(control.rt.snapshot().projectiles.instances.map(value => value.id), [2]);
});

test('projectile callbacks: nested launches and peer stops survive the outer stop', () => {
  const observations = [];
  const child = createProjectileDefinition({ id: 'child', initialize: () => ({ child: true }), acceptsContact: () => false });
  const input = { ...launchInput, source: null, traceTarget: null, destination: [100, 0] };
  const parent = createProjectileDefinition({
    id: 'parent', initialize: () => ({}), acceptsContact: () => false,
    stop: (state, context) => {
      observations.push(context.projectile.id);
      if (context.projectile.id !== 0) return state;
      const launched = launchProjectile(state, child, input, context.tick);
      return stopProjectile(launched.state, ref(findProjectile(launched.state, 1)), context.tick, 'EXPLICIT', context.call);
    },
  });
  const first = launchProjectile(battle(), parent, input, 0);
  const initial = launchProjectile(first.state, parent, input, 0).state;
  const stopped = stopProjectile(initial, first.value, 1);
  assert.deepEqual(observations, [0, 1]);
  assert.deepEqual(instances(stopped).map(value => value.id), [2]);
  assert.strictEqual(findProjectile(stopped, 2).definition, child);
  assert.equal(stopped.execution.nextProjectileId, 3);
  assert.deepEqual(instances(initial).map(value => value.id), [0, 1]);
  assert.equal(initial.execution.nextProjectileId, 2);
});
