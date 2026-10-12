import assert from 'node:assert/strict';
import { test } from 'node:test';
import { battle, unit } from '../helpers/action-fixture.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { createProjectileDefinition } from '../../dist/core/tactical/battlefield/projectile/definition.js';
import { launchProjectile, getProjectile, replaceProjectile, resolveProjectileAttackPower } from '../../dist/core/tactical/battlefield/projectile/operations.js';
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
import { createEnemyDefinition } from '../../dist/core/tactical/unit/archetype/enemy.js';
import { createRouteDefinition } from '../../dist/core/tactical/unit/capability/locomotion/route/definition.js';
import { compileAction } from '../../dist/core/tactical/unit/capability/action/compile.js';

const contactRange = { type: 'SHAPES', geometry: createShapeGeometry({ shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 0.3 }] }) };
const launchInput = {
  source: 0, traceTarget: 1, position: [0, 0], destination: [1, 0], cachedAtk: 10,
  speedPerTick: 1, contactRange, stopDelayTicks: 0,
};

function program(resources, { id = 'shell', cachedOnly = false, acceptsContact, contact, stop } = {}) {
  return resources.projectiles.register(createProjectileDefinition({
    id, initialize: () => ({ contacts: 0 }),
    acceptsContact: acceptsContact ?? ((_context, target) => target.allegiance?.side === 'ENEMY'),
    contact: contact ?? ((state, context) => resources.settleDamage(state, {
      sourceUnitId: context.projectile.source, targetUnitId: context.targetUnitId, tick: context.tick,
      damageType: 'TRUE', operands: createDamageOperands(cachedOnly ? context.projectile.cachedAtk : resolveProjectileAttackPower(state, context.projectile)),
    }, context.call).state),
    ...(stop === undefined ? {} : { stop }),
  }));
}

function launch(state, resources, definition, overrides = {}, tick = 0) {
  return launchProjectile(state, definition.ref, { ...launchInput, ...overrides }, resources.projectiles, tick);
}

const instances = state => battlefieldView(state).projectileIds.map(id => getProjectile(state, id));
const damageEvents = state => state.events.filter(event => event.type === 'DAMAGE');

function runtime(initialUnits, resources, buildProgram, maxTicks = 20) {
  return new BattleRuntime({ ...createLegacyCombatSpec({ rows: 1, columns: 8, operators: [], enemies: [], maxTicks, seed: 17 }),
    initialUnits: initialUnits.map(value => ({ definition: value.definition, position: value.position })),
    schedule: { type: 'TIMELINE', spawns: [{ definition: createEnemyDefinition({ id: 'future', vitality: { maxHp: 1 }, locomotion: { moveSpeedPerTick: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 } } }),
      route: createRouteDefinition({ pathMotionMode: 'WALK', startPosition: [0, 7], endPosition: [0, 1], spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [], allowDiagonalMove: false, visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true }),
      tick: 100, timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true, notCountInTotal: false }] },
  }, { combat: resources, compileAction: (definition, services) => ({ ...compileAction(definition, services), program: buildProgram(definition, services) }) });
}

function actionLaunch(definition, services, overrides = {}, onLaunch = () => {}) {
  return { type: 'EXECUTE', run: (state, context) => {
    const launched = context.projectiles.launch(state, definition.ref, { ...launchInput, ...overrides });
    onLaunch(launched.value);
    return { state: launched.state, value: { samples: { projectileId: launched.value } } };
  } };
}

test('projectile runtime: actions launch independent state and do not move on the release tick', () => {
  const resources = new CombatResources();
  const shell = program(resources);
  const instant = unit(0, { action: true });
  const deferred = unit(1, { side: 'ALLY', action: true });
  const observed = [];
  const rt = runtime([instant, deferred, unit(2)], resources, definition => {
    const release = actionLaunch(shell, resources, { traceTarget: 2, destination: [2, 0], stopDelayTicks: 1 }, id => observed.push(id));
    return definition === instant.definition.action.normalAction ? [release] : [
      { type: 'WAIT', allowNewAction: false, resolve: () => ({ type: 'FOR_TICKS', ticks: 1 }) },
      { type: 'RELEASE', markerId: 'shell' }, release,
    ];
  });
  const first = rt.step();
  assert.deepEqual(observed, [0]);
  assert.deepEqual(rt.snapshot().projectiles.instances.map(value => value.position), [[0, 0]]);
  assert.deepEqual(damageEvents(first), []);
  rt.step();
  assert.deepEqual(observed, [0, 1]);
  assert.deepEqual(rt.snapshot().projectiles.instances.map(value => value.position), [[1, 0], [0, 0]]);
  assert.equal(rt.snapshot().actionExecution.executions.length, 0);
});

test('projectile runtime: missing trace targets preserve the last destination and query current receivers', () => {
  const resources = new CombatResources();
  const shell = program(resources);
  const initial = battle(unit(0), unit(1), { ...unit(2), position: [1.2, 0] });
  const launched = launch(initial, resources, shell).state;
  const retreated = removeUnit(launched, 1, 'RETREAT');
  const reached = advanceProjectiles(retreated, resources, 1);
  assert.deepEqual(damageEvents(reached).map(event => event.targetUnitId), [2]);
  assert.equal(getUnit(reached, 2).vitality.hp, 90);
  assert.equal(getUnit(initial, 2).vitality.hp, 100);
});

test('projectile runtime: frozen candidate identities read latest eligibility and ignore newly registered units', () => {
  const resources = new CombatResources();
  const observed = [];
  const shell = program(resources, {
    acceptsContact: (_context, target) => target.allegiance?.side === 'ENEMY' && (target.id === 1 || target.vitality.hp < 100),
    contact: (state, context) => {
      observed.push(context.targetUnitId);
      if (context.targetUnitId === 1) {
        state = resources.settleDamage(state, { sourceUnitId: 0, targetUnitId: 2, tick: 1, damageType: 'TRUE', operands: createDamageOperands(1) }, context.call).state;
        state = registerUnit(state, { ...unit(3), position: [1, 0] });
      }
      return resources.settleDamage(state, { sourceUnitId: 0, targetUnitId: context.targetUnitId, tick: 1, damageType: 'TRUE', operands: createDamageOperands(10) }, context.call).state;
    },
  });
  const initial = launch(battle(unit(0), unit(1), { ...unit(2), position: [1.2, 0] }), resources, shell).state;
  const reached = advanceProjectiles(initial, resources, 1);
  assert.deepEqual(observed, [1, 2]);
  assert.equal(getUnit(reached, 2).vitality.hp, 89);
  assert.equal(getUnit(reached, 3).vitality.hp, 100);
  assert.deepEqual(reached.events.filter(event => event.type === 'PROJECTILE_HIT').map(event => event.targetUnitId), [1, 2]);
});

test('projectile runtime: live source attack, cached-only attack and missing-source fallback remain distinct', () => {
  for (const missing of [false, true]) {
    const resources = new CombatResources();
    const live = program(resources, { id: 'live' });
    const cached = program(resources, { id: 'cached', cachedOnly: true });
    let state = launch(battle(unit(0), unit(1)), resources, live).state;
    state = launch(state, resources, cached).state;
    state = updateUnit(state, ({ ...getUnit(state, 0), offense: setAttackContribution(getUnit(state, 0).offense, { id: 'bonus', value: [modifier({ addition: 10 })] }) }));
    if (missing) state = removeUnit(state, 0, 'RETREAT');
    const arrived = advanceProjectiles(state, resources, 1);
    assert.deepEqual(damageEvents(arrived).map(event => event.amount), missing ? [10, 10] : [20, 10]);
  }
});

test('projectile runtime: terminal battle freezes outstanding projectiles without stop callbacks', () => {
  const resources = new CombatResources();
  let stops = 0;
  const shell = program(resources, { stop: state => { stops++; return state; } });
  const rt = runtime([unit(0, { action: true }), unit(1)], resources, () => [actionLaunch(shell, resources, { destination: [100, 0], traceTarget: null })], 1);
  rt.step();
  const snapshot = rt.snapshot();
  assert.equal(snapshot.projectiles.instances.length, 1);
  assert.equal(stops, 0);
  rt.step();
  assert.deepEqual(rt.snapshot(), snapshot);
});

test('projectile runtime: hit history is published before contact and synchronous stop fallback observes it', () => {
  const resources = new CombatResources();
  const observed = [];
  const shell = program(resources, {
    contact: (state, context) => {
      assert.deepEqual(getProjectile(state, context.projectile.id).hitUnitIds, [1]);
      state = stopProjectile(state, context.projectile.id, resources, context.tick, 'EXPLICIT', context.call);
      observed.push(['successor', getProjectile(state, context.projectile.id)]);
      return state;
    },
    stop: (state, context) => { observed.push(['stop', context.projectile.hitUnitIds]); return state; },
  });
  const initial = launch(battle(unit(0), unit(1)), resources, shell).state;
  const arrived = advanceProjectiles(initial, resources, 1);
  assert.deepEqual(observed, [['stop', [1]], ['successor', undefined]]);
  assert.deepEqual(instances(arrived), []);
  assert.deepEqual(arrived.events.map(event => event.type), ['PROJECTILE_REACHED', 'PROJECTILE_STOPPED', 'PROJECTILE_HIT']);
});

test('projectile runtime: immutable copies replay arrival and stop without mutating samples', () => {
  const resources = new CombatResources();
  const shell = program(resources);
  const initial = launch(battle(unit(0), unit(1)), resources, shell, { stopDelayTicks: 1 }).state;
  const arrived = advanceProjectiles(initial, resources, 1);
  assert.deepEqual(advanceProjectiles(initial, resources, 1), arrived);
  assert.equal(getProjectile(initial, 0).position[0], 0);
  assert.equal(getProjectile(arrived, 0).progress.type, 'WAITING_TO_STOP');
  const stopped = advanceProjectiles(arrived, resources, 2);
  assert.deepEqual(instances(stopped), []);
  assert.equal(getProjectile(arrived, 0).progress.type, 'WAITING_TO_STOP');
  assert.equal(damageEvents(stopped).length, 1);
});

test('projectile runtime: a stop callback exception exposes no partial result or input mutation', () => {
  const resources = new CombatResources();
  const shell = program(resources, { stop: (state, context) => {
    state = resources.settleDamage(state, { sourceUnitId: 0, targetUnitId: 1, tick: context.tick, damageType: 'TRUE', operands: createDamageOperands(10) }, context.call).state;
    throw new Error('stop failed');
  } });
  const initial = launch(battle(unit(0), unit(1)), resources, shell).state;
  assert.throws(() => advanceProjectiles(initial, resources, 1), /stop failed/);
  assert.equal(getUnit(initial, 1).vitality.hp, 100);
  assert.equal(getProjectile(initial, 0).progress.type, 'FLYING');
  assert.deepEqual(initial.events, []);
});

test('projectile runtime: ordered launches share immutable payloads and preserve input ID allocation', () => {
  const resources = new CombatResources();
  const shell = program(resources);
  const input = { ...launchInput, source: null, traceTarget: null, destination: [100, 0], initialState: { contacts: 0, history: [1] } };
  const initial = battle();
  let state = initial;
  for (let index = 0; index < 32; index++) {
    const launched = launchProjectile(state, shell.ref, input, resources.projectiles, 0);
    assert.equal(launched.value, index);
    state = launched.state;
  }
  assert.equal(initial.execution.nextProjectileId, 0);
  assert.deepEqual(instances(initial), []);
  assert.equal(state.execution.nextProjectileId, 32);
  assert.equal(getProjectile(state, 0).state, input.initialState);
  assert.equal(getProjectile(state, 0).contactRange, input.contactRange);
  const advanced = advanceProjectiles(state, resources, 1);
  assert.equal(instances(advanced).every(value => value.position[0] === 1), true);
  assert.equal(instances(state).every(value => value.position[0] === 0), true);
  assert.equal(advanceProjectiles(advanced, resources, 1), advanced);
});

test('projectile runtime: a retained pure launch function operates on explicit immutable branches', () => {
  const resources = new CombatResources();
  const shell = program(resources);
  const initial = battle();
  const first = launch(initial, resources, shell);
  const sibling = launch(initial, resources, shell);
  assert.equal(first.value, 0);
  assert.deepEqual(sibling, first);
  assert.deepEqual(instances(initial), []);
  const second = launch(first.state, resources, shell);
  assert.equal(second.value, 1);
  assert.equal(first.state.execution.nextProjectileId, 1);
});

test('projectile runtime: stop callbacks see peer progress while prior input snapshots remain stable', () => {
  const resources = new CombatResources();
  const observed = [];
  const shell = program(resources, { stop: (state, context) => {
    observed.push({ id: context.projectile.id, first: getProjectile(state, 0)?.progress.type, second: getProjectile(state, 1)?.progress.type });
    const current = getProjectile(state, context.projectile.id);
    state = replaceProjectile(state, { ...current, state: { contacts: current.state.contacts + 1 } });
    assert.equal(getProjectile(state, context.projectile.id).state.contacts, 1);
    return state;
  } });
  let initial = launch(battle(), resources, shell, { source: null, traceTarget: null }).state;
  initial = launch(initial, resources, shell, { source: null, traceTarget: null, destination: [100, 0] }).state;
  const progressed = advanceProjectiles(initial, resources, 1);
  assert.deepEqual(observed, [{ id: 0, first: 'STOPPED', second: 'FLYING' }]);
  assert.deepEqual(instances(progressed).map(value => [value.id, value.position]), [[1, [1, 0]]]);
  const stopped = stopProjectile(progressed, 1, resources, 1);
  assert.deepEqual(observed[1], { id: 1, first: undefined, second: 'STOPPED' });
  assert.deepEqual(instances(stopped), []);
  assert.equal(getProjectile(initial, 0).progress.type, 'FLYING');
  assert.equal(getProjectile(progressed, 1).state.contacts, 0);
});

test('projectile runtime: ordered command stops complete before survivors advance', () => {
  const resources = new CombatResources();
  const observed = [];
  const shell = program(resources, { stop: (state, context) => { observed.push(context.projectile.id); return state; } });
  let state = battle();
  for (let index = 0; index < 4; index++) state = launch(state, resources, shell, { source: null, traceTarget: null, destination: [100, 0] }).state;
  const initial = state;
  state = advanceBattleProjectiles(state, 1, [2, 2, 999, 0].map(projectileId => ({ type: 'STOP_PROJECTILE', projectileId })), resources);
  assert.deepEqual(observed, [2, 0]);
  assert.deepEqual(state.events.map(event => event.projectileId), [2, 0]);
  assert.deepEqual(instances(state).map(value => [value.id, value.position]), [[1, [1, 0]], [3, [1, 0]]]);
  assert.equal(instances(initial).every(value => value.position[0] === 0), true);
});

test('projectile Battlefield transitions: rejected batches cannot alter input facts or navigation maps', () => {
  const resources = new CombatResources();
  const shell = program(resources);
  const initial = launch(battle(), resources, shell).state;
  const projectile = getProjectile(initial, 0);
  assert.throws(() => transition(initial.battlefield, [
    { type: 'UPDATE_PROJECTILE', projectile: { ...projectile, position: [1, 0] } },
    { type: 'REMOVE_PROJECTILE', projectileId: 999 },
  ]), /unknown projectile/);
  assert.equal(getProjectile(initial, 0), projectile);
  assert.equal(transition(initial.battlefield, []).state.navigationMaps, initial.battlefield.navigationMaps);
});

test('projectile runtime: command stop callbacks see same-tick launches and a failing Tick is not published', () => {
  const scenario = failing => {
    const resources = new CombatResources();
    const observed = [];
    const shell = program(resources, { stop: (state, context) => {
      observed.push([context.projectile.id, getUnit(state, 1).vitality.hp, getProjectile(state, 3)?.progress.type]);
      state = resources.settleDamage(state, { sourceUnitId: 0, targetUnitId: 1, tick: context.tick, damageType: 'TRUE', operands: createDamageOperands(1) }, context.call).state;
      if (failing && context.projectile.id === 1) throw new Error('second stop failed');
      return state;
    } });
    const rt = runtime([unit(0, { action: true }), unit(1)], resources, () => [
      ...Array.from({ length: 3 }, () => actionLaunch(shell, resources, { traceTarget: null, destination: [100, 0] })),
      { type: 'WAIT', allowNewAction: false, resolve: () => ({ type: 'FOR_TICKS', ticks: 1 }) },
      actionLaunch(shell, resources, { traceTarget: null, destination: [100, 0] }),
    ]);
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
