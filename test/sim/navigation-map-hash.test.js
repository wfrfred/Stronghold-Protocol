import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createBattlefieldRuntime } from '../../dist/core/tactical/battlefield/runtime.js';
import { createNavigationMap, NavigationMap } from '../../dist/core/tactical/battlefield/navigation/map.js';
import { createNavigationModifierDefinition } from '../../dist/core/tactical/battlefield/navigation/modifier.js';
import { projectNavigationMaps, projectStaticNavigationMap } from '../../dist/core/tactical/battlefield/navigation/projection.js';

const cell = (overrides = {}) => ({
  passable: true, moveCost: 1,
  departures: { UP: true, RIGHT: true, DOWN: true, LEFT: true },
  ...overrides,
});
const fields = (overrides = {}) => ({
  rows: 2, columns: 2, pathMotionMode: 'WALK', revision: 0,
  cells: Array.from({ length: 4 }, () => cell()),
  ...overrides,
});
const tile = (overrides = {}) => ({
  heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
  playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
  ...overrides,
});
const flatMap = (rows = 1, columns = 3) => createBattlefieldMap(
  rows, columns, Array.from({ length: rows * columns }, () => tile()),
);
const baselineMaps = map => ({
  WALK: projectStaticNavigationMap(map, 'WALK', 0),
  FLY: projectStaticNavigationMap(map, 'FLY', 0),
});
const modifier = (id, positions, walk = {}, fly = null) => ({
  definition: createNavigationModifierDefinition({
    id,
    WALK: walk === null ? null : { denyPassage: false, deniedDepartures: [], costFloor: 1, ...walk },
    FLY: fly === null ? null : { denyPassage: false, deniedDepartures: [], ...fly },
  }),
  positions,
});

test('navigation content hashes are deterministic, serializable and independent of revision', () => {
  const input = fields();
  const first = createNavigationMap(input);
  const again = createNavigationMap(fields({ revision: 91 }));
  const suppliedHash = createNavigationMap({ ...fields(), contentHash: 0xffff_ffff });

  assert.equal(typeof first.contentHash, 'number');
  assert.ok(Number.isInteger(first.contentHash));
  assert.ok(first.contentHash >= 0 && first.contentHash <= 0xffff_ffff);
  assert.equal(again.contentHash, first.contentHash);
  assert.equal(suppliedHash.contentHash, first.contentHash);
  assert.equal(NavigationMap.sameContent(first, again), true);
  assert.equal(NavigationMap.sameContent(first, first), true);
  assert.equal(JSON.parse(JSON.stringify(first)).contentHash, first.contentHash);

  input.cells[0].passable = false;
  input.cells[1].departures.LEFT = false;
  assert.equal(first.cells[0].passable, true);
  assert.equal(first.cells[1].departures.LEFT, true);
  assert.equal(first.contentHash, again.contentHash);
});

test('navigation hashes include dimensions, motion mode and all cell properties', () => {
  const unchanged = createNavigationMap(fields());
  const different = [
    ['passability', fields({ cells: [cell({ passable: false }), cell(), cell(), cell()] })],
    ['cost', fields({ cells: [cell({ moveCost: 2 }), cell(), cell(), cell()] })],
    ['dimensions', fields({ rows: 1, columns: 4 })],
    ['motion mode', fields({ pathMotionMode: 'FLY' })],
    ...['UP', 'RIGHT', 'DOWN', 'LEFT'].map(direction => [
      `${direction} departure`, fields({ cells: [cell({
        departures: { ...cell().departures, [direction]: false },
      }), cell(), cell(), cell()] }),
    ]),
  ];

  for (const [property, input] of different) {
    const changed = createNavigationMap(input);
    assert.notEqual(changed.contentHash, unchanged.contentHash, property);
    assert.equal(NavigationMap.sameContent(changed, unchanged), false, property);
  }

  const atStart = createNavigationMap(fields({ cells: [cell({ moveCost: 7 }), cell(), cell(), cell()] }));
  const atEnd = createNavigationMap(fields({ cells: [cell(), cell(), cell(), cell({ moveCost: 7 })] }));
  assert.notEqual(atStart.contentHash, atEnd.contentHash, 'cell position');
  assert.equal(NavigationMap.sameContent(atStart, atEnd), false);
});

test('navigation hashes distinguish the full safe integer cost rather than its low 32 bits', () => {
  const costs = [1, 0x1_0000_0001, 0x2_0000_0001, Number.MAX_SAFE_INTEGER];
  const maps = costs.map(moveCost => createNavigationMap(fields({
    cells: [cell({ moveCost }), cell(), cell(), cell()],
  })));

  assert.equal(new Set(maps.map(map => map.contentHash)).size, costs.length);
  for (let index = 1; index < maps.length; index++) {
    assert.equal(NavigationMap.sameContent(maps[0], maps[index]), false);
  }
});

test('factory, static projection and dynamic projection agree on final navigation content', () => {
  const staticMap = createBattlefieldMap(1, 3, [
    tile(), tile({ terrain: 'HOLE' }), tile({ passableMask: 'FLY_ONLY' }),
  ], [], [{ position: [0, 0], direction: 'RIGHT', blockMask: 'WALK_ONLY' }]);
  const baseline = baselineMaps(flatMap());
  const restrictions = [
    modifier('hole', [[0, 1]], { costFloor: 1_000_000 }),
    modifier('walk-blocked', [[0, 2]], { denyPassage: true }),
    modifier('edge-right', [[0, 0]], { deniedDepartures: ['RIGHT'] }),
    modifier('edge-left', [[0, 1]], { deniedDepartures: ['LEFT'] }),
  ];
  const projected = projectNavigationMaps(baseline, restrictions, baseline).maps;

  for (const mode of ['WALK', 'FLY']) {
    const fromStatic = projectStaticNavigationMap(staticMap, mode, 17);
    const fromFactory = createNavigationMap({ ...fromStatic, revision: 99 });
    assert.deepEqual(projected[mode].cells, fromStatic.cells);
    assert.equal(projected[mode].contentHash, fromStatic.contentHash);
    assert.equal(fromFactory.contentHash, fromStatic.contentHash);
    assert.equal(NavigationMap.sameContent(projected[mode], fromStatic), true);
    assert.equal(NavigationMap.sameContent(fromFactory, projected[mode]), true);
  }
});

test('modifier identity, source, order and intermediate revisions do not affect final hashes', () => {
  const map = flatMap();
  const first = createBattlefieldRuntime({ map });
  const second = createBattlefieldRuntime({ map });
  const registerSources = ids => ids.map(id => ({
    type: 'REGISTER_MECHANISM', mechanism: { id, definition: { id: `source-${id}` }, active: true },
  }));
  const addition = (id, sourceId, projected) => ({
    type: 'ADD_NAVIGATION_MODIFIER', navigationModifier: {
      id, definition: projected.definition,
      source: { type: 'MECHANISM', mechanismId: sourceId },
      active: true, expiresAtTick: null,
      region: { type: 'FIXED', position: projected.positions[0], range: [[0, 0]], direction: 'RIGHT' },
    },
  });
  first.apply(registerSources([1, 2]));
  second.apply(registerSources([7, 8]));
  first.apply([addition(1, 1, modifier('cost-first', [[0, 1]], { costFloor: 17 }))]);
  first.apply([addition(2, 2, modifier('block-second', [[0, 1]], { denyPassage: true }))]);
  second.apply([
    addition(90, 8, modifier('another-block', [[0, 1]], { denyPassage: true })),
    addition(91, 7, modifier('another-cost', [[0, 1]], { costFloor: 17 })),
  ]);

  assert.notEqual(first.navigationMaps.WALK.revision, second.navigationMaps.WALK.revision);
  assert.deepEqual(first.navigationMaps.WALK.cells, second.navigationMaps.WALK.cells);
  assert.equal(first.navigationMaps.WALK.contentHash, second.navigationMaps.WALK.contentHash);
  assert.equal(NavigationMap.sameContent(first.navigationMaps.WALK, second.navigationMaps.WALK), true);
  assert.equal(first.navigationMaps.FLY.contentHash, second.navigationMaps.FLY.contentHash);
});

test('dynamic projection hashes final restrictions and restores content after A to B to A prime', () => {
  const baseline = baselineMaps(flatMap());
  const originalHashes = { WALK: baseline.WALK.contentHash, FLY: baseline.FLY.contentHash };
  const restrictions = [
    modifier('large-cost', [[0, 1]], { costFloor: 0x1_0000_0001 }, { deniedDepartures: ['UP'] }),
    modifier('masked-cost', [[0, 1]], { costFloor: 3 }),
    modifier('walk-edge', [[0, 0]], { deniedDepartures: ['RIGHT'] }),
  ];
  const changed = projectNavigationMaps(baseline, restrictions, baseline).maps;
  const reordered = projectNavigationMaps(baseline, restrictions.slice().reverse(), baseline).maps;
  const restored = projectNavigationMaps(baseline, [], changed, restrictions).maps;

  for (const mode of ['WALK', 'FLY']) {
    assert.notEqual(changed[mode].contentHash, originalHashes[mode]);
    assert.equal(changed[mode].contentHash, reordered[mode].contentHash);
    assert.equal(changed[mode].contentHash, createNavigationMap(changed[mode]).contentHash);
    assert.notEqual(restored[mode], baseline[mode]);
    assert.equal(restored[mode].revision, 2);
    assert.equal(restored[mode].contentHash, originalHashes[mode]);
    assert.equal(NavigationMap.sameContent(restored[mode], baseline[mode]), true);
    assert.equal(baseline[mode].contentHash, originalHashes[mode]);
    assert.equal(baseline[mode].cells[1].moveCost, 1);
  }

  const maximumCost = [modifier('maximum-cost', [[0, 1]], { costFloor: Number.MAX_SAFE_INTEGER })];
  const maximum = projectNavigationMaps(baseline, maximumCost, changed, restrictions).maps.WALK;
  assert.equal(maximum.cells[1].moveCost, Number.MAX_SAFE_INTEGER);
  assert.equal(maximum.contentHash, createNavigationMap(maximum).contentHash);
});

test('matching hashes cannot make different navigation content equivalent', () => {
  const original = createNavigationMap(fields());
  const changed = createNavigationMap(fields({ cells: [cell({ passable: false }), cell(), cell(), cell()] }));
  const collision = Object.freeze({ ...changed, contentHash: original.contentHash });

  assert.equal(collision.contentHash, original.contentHash);
  assert.equal(NavigationMap.sameContent(original, collision), false);
  assert.equal(NavigationMap.sameContent(collision, original), false);
  assert.equal(NavigationMap.sameContent(original, collision), false);
});

test('content comparison does not retain stale answers for mutable or shallow-frozen maps', () => {
  const original = createNavigationMap(fields());
  for (const shallowFrozen of [false, true]) {
    const mutable = structuredClone(original);
    if (shallowFrozen) Object.freeze(mutable);
    assert.equal(NavigationMap.sameContent(original, mutable), true);

    mutable.cells[0].moveCost = 2;
    assert.equal(NavigationMap.sameContent(original, mutable), false);
    mutable.cells[0].moveCost = 1;
    assert.equal(NavigationMap.sameContent(original, mutable), true);

    mutable.cells[1].departures.DOWN = false;
    assert.equal(NavigationMap.sameContent(original, mutable), false);
    mutable.cells[1].departures.DOWN = true;
    assert.equal(NavigationMap.sameContent(original, mutable), true);

    mutable.cells[2] = cell({ passable: false });
    assert.equal(NavigationMap.sameContent(original, mutable), false);
  }
});
