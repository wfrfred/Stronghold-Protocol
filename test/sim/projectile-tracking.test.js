import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBattle, initialize } from '../helpers/unit.js';
import { registerUnit, removeUnit, updateUnit, getUnit } from '../../dist/core/tactical/battle/state.js';
import * as projectiles from '../../dist/core/tactical/battlefield/projectile/operations.js';
import { advance } from '../../dist/core/tactical/battlefield/projectile/advance.js';
import { ref } from '../../dist/core/tactical/unit/query.js';
import { createArrow } from '../../dist/content/tactical/enemies/crossbowman.js';
import * as tracking from '../../dist/content/tactical/projectiles/tracking.js';

function setup() {
  const source = initialize({ id: 0, position: [0, 0], definition: {
    id: 'source', offense: { attack: 40 },
  } });
  const target = initialize({ id: 1, position: [1, 0], definition: {
    id: 'target', vitality: { maxHp: 1000, defense: 0, resistance: 0 },
    spatialPresence: {}, targetable: { restrictions: [{ id: 'hidden', value: {
      kind: Symbol('hidden'), allows: () => false,
    } }] },
  } });
  const battle = registerUnit(registerUnit(fixtureBattle(), source), target);
  const state = {
    source: ref(source), target: ref(target), destination: target.position,
    cachedAtk: 20, speedPerTick: 1, stopDelayTicks: 0, stopAtTick: null,
    hitAttempted: false, launchedAtTick: 0,
  };
  return { battle, source, target, state };
}

function step(battle, tick) {
  return advance({ ...battle, tick }, battle.battlefield.projectiles.values().map(projectiles.ref).toArray());
}

test('locked arrow hit uses identity without requiring targetability, hitbox or spatial presence', () => {
  const fixture = setup();
  const launched = projectiles.create(fixture.battle, createArrow(), { position: [0, 0], state: fixture.state });
  const hidden = updateUnit(launched.state, {
    ...fixture.target, position: [10, 0], spatialPresence: { present: false },
  });
  const after = step(hidden, 1);

  assert.equal(getUnit(after, 1).vitality.hp, 960);
  assert.equal(after.battlefield.projectiles.size, 0);
  assert.deepEqual(after.events.filter(event => event.type.startsWith('PROJECTILE_')).map(event => event.type), [
    'PROJECTILE_REACHED', 'PROJECTILE_HIT', 'PROJECTILE_STOPPED',
  ]);
  assert.deepEqual(after.events.find(event => event.type === 'PROJECTILE_REACHED').position, [1, 0]);
  assert.ok(after.events.findIndex(event => event.type === 'PROJECTILE_HIT') < after.events.findIndex(event => event.type === 'DAMAGE'));
  assert.equal(getUnit(fixture.battle, 1).vitality.hp, 1000);
});

test('dispel skips the ordinary arrow fallback hit while explicit stop performs it once', () => {
  const fixture = setup();
  const launched = projectiles.create(fixture.battle, createArrow(), { position: [0, 0], state: fixture.state });
  const dispelled = projectiles.stop(launched.state, launched.value, 'DISPEL');
  const stopped = projectiles.stop(launched.state, launched.value);

  assert.equal(getUnit(dispelled, 1).vitality.hp, 1000);
  assert.equal(getUnit(stopped, 1).vitality.hp, 960);
  assert.equal(dispelled.events.some(event => event.type === 'PROJECTILE_HIT'), false);
  assert.equal(stopped.events.filter(event => event.type === 'PROJECTILE_HIT').length, 1);
  assert.strictEqual(projectiles.stop(stopped, launched.value), stopped);
});

test('tracking commits its hit attempt before content can synchronously stop the same projectile', () => {
  const fixture = setup();
  const observed = [];
  const hit = (battle, self) => tracking.hit(battle, self, (current, marked) => {
    observed.push([marked.state.hitAttempted, projectiles.get(current, projectiles.ref(marked)).state.hitAttempted]);
    return projectiles.stop(current, projectiles.ref(marked));
  });
  const definition = {
    id: 'reentrant-arrow', tracking: true,
    onAdvance: (battle, self) => tracking.advance(battle, self, hit),
    onTerminate: (battle, self, reason) => reason === 'DISPEL' ? battle : hit(battle, self),
  };
  const launched = projectiles.create(fixture.battle, definition, { position: [0, 0], state: fixture.state });
  const after = step(launched.state, 1);

  assert.deepEqual(observed, [[true, true]]);
  assert.equal(after.events.filter(event => event.type === 'PROJECTILE_HIT').length, 1);
  assert.equal(after.events.filter(event => event.type === 'PROJECTILE_STOPPED').length, 1);
  assert.equal(after.battlefield.projectiles.size, 0);
});

test('delayed tracking keeps the instance active after arrival without repeating the hit', () => {
  const fixture = setup();
  const launched = projectiles.create(fixture.battle, createArrow(), {
    position: [0, 0], state: { ...fixture.state, stopDelayTicks: 2 },
  });
  const reached = step(launched.state, 1);
  const waiting = step(reached, 2);
  const ended = step(waiting, 3);

  assert.equal(projectiles.get(reached, launched.value).lifecycle, 'ACTIVE');
  assert.equal(projectiles.get(reached, launched.value).state.stopAtTick, 3);
  assert.equal(projectiles.get(waiting, launched.value).lifecycle, 'ACTIVE');
  assert.equal(projectiles.get(ended, launched.value), undefined);
  assert.equal(ended.events.filter(event => event.type === 'PROJECTILE_HIT').length, 1);
  assert.equal(getUnit(ended, 1).vitality.hp, 960);
});

test('tracking reads current source attack and falls back to its launch sample after removal', () => {
  const fixture = setup();
  const launched = projectiles.create(fixture.battle, createArrow(), { position: [0, 0], state: fixture.state });
  const self = projectiles.get(launched.state, launched.value);

  assert.equal(tracking.attackPower(launched.state, self), 40);
  const withoutSource = removeUnit(launched.state, fixture.source.id);
  assert.equal(tracking.attackPower(withoutSource, self), 20);
  const after = step(withoutSource, 1);
  assert.equal(getUnit(after, 1).vitality.hp, 980);
});

test('a missing locked target does not redirect its arrow to another nearby unit', () => {
  const fixture = setup();
  const launched = projectiles.create(fixture.battle, createArrow(), { position: [0, 0], state: fixture.state });
  const other = initialize({ id: 2, position: [1, 0], definition: {
    id: 'nearby', vitality: { maxHp: 100, defense: 0, resistance: 0 },
  } });
  const withoutTarget = registerUnit(removeUnit(launched.state, fixture.target.id), other);
  const after = step(withoutTarget, 1);

  assert.equal(getUnit(after, 2).vitality.hp, 100);
  assert.equal(after.events.some(event => event.type === 'PROJECTILE_HIT'), false);
  assert.equal(after.battlefield.projectiles.size, 0);
});

test('tracking presentation projects its own snapshot data and leaves unrelated programs opaque', () => {
  const fixture = setup();
  const launched = projectiles.create(fixture.battle, createArrow(), { position: [0, 0], state: fixture.state });
  const snapshot = launched.state.battlefield.projectiles.snapshot()[0];

  assert.deepEqual(tracking.project(snapshot), {
    id: launched.value.id, source: 0, traceTarget: 1, position: [0, 0], destination: [1, 0], launchedAtTick: 0,
  });
  assert.equal(tracking.project({ ...snapshot, definition: { id: 'unrelated' }, state: {} }), undefined);
});
