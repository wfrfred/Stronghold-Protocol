import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { getUnit, updateUnit } from '../../dist/core/tactical/battle/state.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createInput as createRouteDefinition } from '../../dist/core/tactical/battle/creation/route.js';
import { createDefinition as createEnemy } from '../../dist/core/tactical/unit/archetype/enemy.js';

const map = createBattlefieldMap(2, 4, Array.from({ length: 8 }, () => ({
  heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
  playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
})));
const route = createRouteDefinition({
  pathMotionMode: 'WALK', startPosition: [1, 3], endPosition: [1, 0],
  spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: 1000 }],
  allowDiagonalMove: false, visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true,
});
const spawn = (definition, tick = 0) => ({
  tick, definition, route, alwaysCheckCurrentPoint: true, notCountInTotal: false,
  timing: { waveStartedAtTick: tick, fragmentStartedAtTick: tick },
});
const input = (fields = {}) => ({
  map, schedule: { type: 'TIMELINE', spawns: [] }, initialUnits: [], predefines: [],
  initialMechanisms: [], maxTicks: 30, routeMoveMultiplier: 1,
  rngState: 123, ...fields,
});
const markEntered = (trace, id) => ({
  id, vitality: { maxHp: 100, defense: 0, resistance: 0 },
  onEnter(state, unitId) {
    const unit = getUnit(state, unitId);
    trace.push([id, unitId, unit.vitality.hp]);
    return updateUnit(state, { ...unit, vitality: { ...unit.vitality, hp: 75 } });
  },
});

test('initial entry callbacks see the whole registered batch and preceding callbacks', () => {
  const trace = [];
  const first = { ...markEntered(trace, 'first'), onEnter(state, unitId) {
    assert.equal(getUnit(state, 1).vitality.hp, 100);
    const other = getUnit(state, 1);
    return updateUnit(state, { ...other, vitality: { ...other.vitality, hp: 60 } });
  } };
  const second = markEntered(trace, 'second');
  const runtime = new BattleRuntime(input({ initialUnits: [
    { definition: first, position: [0, 0] },
    { definition: second, position: [1, 0] },
  ] }));
  assert.deepEqual(trace, [['second', 1, 60]]);
  assert.equal(runtime.snapshot().units[1].vitality.hp, 75);
  assert.equal(second.vitality.maxHp, 100);
});

test('factory-created enemies enter after spawning and keep immutable old snapshots', () => {
  const trace = [];
  const definition = createEnemy({ ...markEntered(trace, 'spawned'), locomotion: {
    halfBodyWidth: 0, speed: 0, minSpeed: 0,
    steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
  } });
  const runtime = new BattleRuntime(input({ schedule: { type: 'TIMELINE', spawns: [spawn(definition)] } }));
  const before = runtime.snapshot();
  runtime.step();
  runtime.step();
  assert.deepEqual(trace, [['spawned', 0, 100]]);
  assert.equal(runtime.snapshot().units[0].vitality.hp, 75);
  assert.deepEqual(before.units, []);
});

test('predefined appearances and deployment initialize once; relocation does not re-enter', () => {
  const trace = [];
  const deployable = { ...markEntered(trace, 'deployed'), occupancy: {}, deployable: { cost: 0, redeployTicks: 0, slots: 1, buildableType: 'ALL', advancedBuildableMask: 1, refund: { rate: 0.5, limit: 'BASE_COST' } } };
  const runtime = new BattleRuntime(input({ deployment: {
    definition: { initialDp: 0, maxDp: 99, dpRecoveryTicks: null, slotLimit: null },
    cards: [{ unit: deployable }],
  }, predefines: [{
    id: 9, alias: null, initiallyPresent: true,
    creation: { type: 'UNIT', definition: markEntered(trace, 'predefined'), position: [2, 0] },
  }], schedule: { type: 'TIMELINE', spawns: [spawn(createEnemy({
    id: 'later', vitality: { maxHp: 100, defense: 0, resistance: 0 }, locomotion: {
      halfBodyWidth: 0, speed: 0, minSpeed: 0,
      steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
    },
  }), 1000)] } }));
  runtime.step([{ type: 'DEPLOY_UNIT', cardId: 0, tilePosition: [0, 0], playerSide: 'SIDE_A' }]);
  const before = runtime.snapshot();
  runtime.step([{ type: 'RELOCATE_UNIT', unitId: 1, tilePosition: [0, 1], playerSide: 'SIDE_A' }]);
  runtime.step([{ type: 'REMOVE_PREDEFINED', definitionId: 9, reason: 'SCRIPT' },
    { type: 'APPEAR_PREDEFINED', definitionId: 9 }]);
  assert.deepEqual(trace, [['predefined', 0, 100], ['deployed', 1, 100], ['predefined', 2, 100]]);
  assert.equal(before.units.find(unit => unit.id === 1).vitality.hp, 75);
  assert.deepEqual(before.units.find(unit => unit.id === 1).position, [0, 0]);
  assert.deepEqual(runtime.snapshot().units.find(unit => unit.id === 1).position, [1, 0]);
});

test('unit initialization exposes callable optional callbacks and selected capability state', async () => {
  const { default: ts } = await import('typescript');
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-entry-types-'));
  const module = JSON.stringify(fileURLToPath(new URL('../../src/core/tactical/unit/initialize.js', import.meta.url)));
  const path = join(directory, 'entry.mts');
  try {
    writeFileSync(path, `
import { initialize } from ${module};
declare const battle: import(${JSON.stringify(fileURLToPath(new URL('../../src/core/tactical/battle/state.js', import.meta.url)))}).State;
const unit = initialize(battle, { id: 0, position: [0, 0], definition: {
  id: 'typed-content', vitality: { maxHp: 100, defense: 0, resistance: 0 },
  onEnter: (state: import(${JSON.stringify(fileURLToPath(new URL('../../src/core/tactical/battle/state.js', import.meta.url)))}).State, _id: number) => state,
} }).value;
if (unit.definition.onEnter !== undefined) {
  const state: Parameters<typeof unit.definition.onEnter>[0] = battle;
  unit.definition.onEnter(state, unit.id);
}
const hp: number = unit.vitality.hp;
`);
    const program = ts.createProgram([path], {
      noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true, skipLibCheck: true, types: [],
    });
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
