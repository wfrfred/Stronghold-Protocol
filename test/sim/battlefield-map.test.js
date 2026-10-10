import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createBattlefieldRuntime } from '../../dist/core/tactical/battlefield/runtime.js';

test('battlefield maps require the factory even when structural fields are readonly or frozen', async () => {
  const { default: ts } = await import('typescript');
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-battlefield-map-types-'));
  const sourceModule = path => JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/battlefield/${path}.js`, import.meta.url)));
  const path = join(directory, 'map.mts');
  try {
    writeFileSync(path, `
import { createBattlefieldMap, BattlefieldMap } from ${sourceModule('map/map')};
declare const fields: Pick<BattlefieldMap, 'rows' | 'columns' | 'tiles' | 'markers' | 'blockEdges'>;
// @ts-expect-error Structural fields cannot establish factory ownership.
const structural: BattlefieldMap = fields;
// @ts-expect-error Freezing only the root cannot establish factory ownership.
const shallowFrozen: BattlefieldMap = Object.freeze(fields);
// @ts-expect-error Map queries require a factory-created map.
BattlefieldMap.get(fields, [0, 0]);
const map: BattlefieldMap = createBattlefieldMap(fields.rows, fields.columns, fields.tiles, fields.markers, fields.blockEdges);
BattlefieldMap.get(map, [0, 0]);
// @ts-expect-error Factory-created maps expose readonly nested collections.
map.tiles.push(fields.tiles[0]!);
// @ts-expect-error Map marker coordinates stay readonly.
map.markers[0]!.position[0] = 1;
`);
    const program = ts.createProgram([path], {
      noEmit: true,
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      types: [],
    });
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('battlefield versions share a map whose nested data is isolated from caller mutations', () => {
  const tile = {
    heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL',
    mechanism: { type: 'INFECTION', params: {
      damagePerTick: 10, attackBonusRatio: 0.2, attackSpeedBonus: 20, activeUntilTick: 60,
    } },
  };
  const tiles = [tile];
  const markers = [{ type: 'START', position: [0, 0] }];
  const blockEdges = [{ position: [0, 0], direction: 'RIGHT', blockMask: 'WALK_ONLY' }];
  const map = createBattlefieldMap(1, 1, tiles, markers, blockEdges);
  const field = createBattlefieldRuntime({ map });
  const published = field.snapshot('state');
  const draft = field.snapshot('draft');

  tile.passableMask = 'NONE';
  tile.mechanism.params.damagePerTick = 999;
  tiles.length = 0;
  markers[0].position[0] = 1;
  blockEdges[0].blockMask = 'ALL';

  for (const branch of [field.snapshot('draft'), published, draft]) {
    assert.equal(branch.map, map);
    assert.equal(branch.map.tiles[0].passableMask, 'ALL');
    assert.equal(branch.map.tiles[0].mechanism.params.damagePerTick, 10);
    assert.deepEqual(branch.map.markers[0].position, [0, 0]);
    assert.equal(branch.map.blockEdges[0].blockMask, 'WALK_ONLY');
    assert.equal(branch.navigationMaps.WALK.cells[0].passable, true);
  }
  assert.throws(() => { map.tiles[0].passableMask = 'NONE'; }, TypeError);
  assert.throws(() => { map.tiles[0].mechanism.params.damagePerTick = 999; }, TypeError);
  assert.throws(() => { map.markers[0].position[0] = 1; }, TypeError);
  assert.throws(() => { map.blockEdges.push(blockEdges[0]); }, TypeError);
});
