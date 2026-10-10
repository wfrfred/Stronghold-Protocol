import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBattlefield } from '../helpers/battlefield.js';
import {
  appendEvents, battlefieldView, createBattleState, getUnit,
  registerUnit, removeUnit, updateUnit, updateUnits,
} from '../../dist/core/tactical/battle/execution/context.js';

const unit = (id, position = [0, 0]) => ({ id, definition: { id: `unit-${id}` }, position });

function fixture(...units) {
  return createBattleState(fixtureBattlefield(units));
}

test('battle state: nested updates and removals are immediately visible through the battlefield draft', () => {
  const first = unit(1);
  const second = unit(2);
  const state = fixture(first, second);
  const published = state.battlefield.snapshot('state');
  const moved = { ...second, position: [3, 0] };
  updateUnit(state, moved);
  removeUnit(state, 1, 'SCRIPT');
  const view = battlefieldView(state);
  assert.equal(view.getUnit(2), moved);
  assert.equal(view.getUnit(1), undefined);
  assert.deepEqual(view.unitIds, [2]);
  assert.equal(published.getUnit(1), first);
  assert.equal(published.getUnit(2), second);
  assert.deepEqual(state.removedUnits, [{ unitId: 1, reason: 'SCRIPT', unit: first }]);
});

test('battle state: publishing accepts the already advanced state and drop discards subsequent drafts', () => {
  const first = unit(1);
  const state = fixture(first);
  const moved = { ...first, position: [1, 0] };
  updateUnit(state, moved);
  state.battlefield.apply();
  const published = state.battlefield.snapshot('state');
  const spawned = unit(8);
  registerUnit(state, spawned);
  removeUnit(state, 1, 'DEATH');
  assert.deepEqual(state.battlefield.unitIds, [8]);
  state.battlefield.drop();
  assert.equal(getUnit(state, 1), moved);
  assert.equal(getUnit(state, 8), undefined);
  assert.equal(published.getUnit(1), moved);
});

test('battle state: no-op updates and missing removals do not create registration or removal facts', () => {
  const first = initializeUnit({ id: 1, position: [0, 0], definition: { id: "vitality", vitality: { maxHp: 100 } } });
  const state = fixture(first);
  updateUnit(state, first);
  removeUnit(state, 99);
  appendEvents(state, []);
  assert.deepEqual(state.registeredUnitIds, []);
  assert.deepEqual(state.removedUnits, []);
  const zeroHp = { ...first, vitality: { hp: 0 } };
  updateUnit(state, zeroHp);
  assert.equal(getUnit(state, 1), zeroHp);
  assert.deepEqual(state.removedUnits, []);
});

test('battle state: a batch updates the common draft while snapshots and forks remain isolated', () => {
  const first = unit(1);
  const second = unit(2);
  const state = fixture(first, second);
  const snapshot = state.battlefield.snapshot('draft');
  const fork = state.battlefield.fork();
  const moved = { ...first, position: [3, 0] };
  const spawned = unit(8);
  updateUnits(state, [moved, second, spawned]);
  assert.equal(getUnit(state, 1), moved);
  assert.equal(getUnit(state, 8), spawned);
  assert.equal(snapshot.getUnit(1), first);
  assert.equal(snapshot.getUnit(8), undefined);
  assert.equal(fork.getUnit(1), first);
  assert.equal(fork.getUnit(8), undefined);
  assert.deepEqual(state.registeredUnitIds, [8]);
});

test('battle state: nested operations share event accumulation and the latest execution state', () => {
  const state = fixture(unit(1));
  const first = { type: 'ACTION', sourceUnitId: 1, targetUnitId: 2, tick: 3 };
  const second = { ...first, targetUnitId: 3 };
  const supplied = [first];
  appendEvents(state, supplied);
  supplied.push(second);
  const execution = { ...state.execution, rngState: 123, nextUnitId: 4 };
  state.execution = execution;
  appendEvents(state, [second]);
  assert.deepEqual(state.events, [first, second]);
  assert.equal(state.execution, execution);
});

test('battle state: repeated identities in a batch use the final value and register each new identity once', () => {
  const first = unit(1);
  const state = fixture(first);
  const moved = { ...first, position: [2, 0] };
  const spawned = unit(8);
  const changedSpawned = { ...spawned, position: [3, 0] };
  updateUnits(state, [moved, spawned, first, changedSpawned]);
  assert.equal(getUnit(state, 1), first);
  assert.equal(getUnit(state, 8), changedSpawned);
  assert.deepEqual(state.registeredUnitIds, [8]);
});
