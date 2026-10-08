import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BattlefieldRuntime, createBattlefieldRuntime } from '../../dist/core/tactical/battlefield/runtime.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { copyUnitSnapshot } from '../../dist/core/tactical/unit/snapshot.js';
import { configuredCapabilities } from '../../dist/core/tactical/unit/capability/catalog.js';
import { createActionCapabilityDefinition } from '../../dist/core/tactical/unit/capability/action/capability.js';

const map = () => createBattlefieldMap(1, 3, Array.from({ length: 3 }, () => createTile({
  heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
  playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
})));

const definition = () => ({
  id: 'paired-capabilities',
  vitality: { maxHp: 100 },
  offense: { attack: 10 },
  defense: { defense: 20, resistance: 10 },
  action: createActionCapabilityDefinition({ normalAction: {
    triggerBindingId: 'primary', baseAttackTimeTicks: 3, recoveryTicks: 0, followUps: [],
    targetGroups: [{ id: 'primary', operations: [{ type: 'DAMAGE', power: 10, damageType: 'PHYSICAL' }],
      targeting: { type: 'DAMAGE', scope: { type: 'RANGE', geometry: {
        type: 'SHAPES', geometry: { shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 1 }] },
      } }, canTargetAir: false, includeBlockingRelations: false, preferBlockingRelations: false,
        ignoreTargetFree: false, ignoreInvisible: false, maxTargets: 1 },
    }],
  } }),
  elemental: { receiver: 'CHARACTER', maxEp: 1000, recoveryPerTick: 0,
    elementResistance: 0, damageResistance: 0, immune: false,
    burstDurationsTicks: { NEURAL: 300, EROSION: 300, BURN: 300, NECROSIS: 450 } },
  skill: { id: 'paired-skill', activation: 'MANUAL', spRecovery: 'TIME', spCost: 10, initialSp: 0, durationTicks: 30 },
  allegiance: { side: 'ALLY' },
  spatial: { layer: 'GROUND' },
  hit: { geometry: { shapes: [{ type: 'CIRCLE', offset: [0, 0], radius: 0.25 }] } },
  status: { initialFlags: [] },
  blocker: { capacity: 1, geometry: { radius: 0.5 } },
  blockable: { weight: 1 },
  locomotion: { moveSpeedPerTick: 0.1, steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 } },
});

const modes = [
  ['public apply', () => createBattlefieldRuntime({ map: map() }), 'apply'],
  ['custom copier apply', () => createBattlefieldRuntime({ map: map() }, unit => ({ ...unit })), 'apply'],
  ['internal owned commit', () => BattlefieldRuntime.create({ map: map() }, copyUnitSnapshot), 'commitOwned'],
];

for (const [name, create, operation] of modes) {
  test(`battlefield ${name} rejects unpaired configured capabilities atomically at registration`, () => {
    const runtime = create();
    const unit = initializeUnit({ id: 1, definition: definition(), position: [0, 0] });
    const maps = runtime.navigationMaps;
    for (const key of Object.keys(configuredCapabilities)) {
      const missingState = { ...unit };
      delete missingState[key];
      const missingDefinition = { ...unit.definition };
      delete missingDefinition[key];
      const missingConfiguration = { ...unit, definition: missingDefinition };
      for (const invalid of [missingState, missingConfiguration, { ...unit, [key]: undefined }]) {
        assert.throws(() => runtime[operation]([
          { type: 'REGISTER_UNIT', unit: { ...unit, id: 2 } },
          { type: 'REGISTER_UNIT', unit: invalid },
        ]), new RegExp(`capability ${key} configuration and state must be paired`));
        assert.deepEqual(runtime.unitIds, []);
        assert.equal(runtime.navigationMaps, maps);
        assert.deepEqual(runtime.unitsAt([0, 0]), []);
      }
    }
    runtime[operation]([{ type: 'REGISTER_UNIT', unit }]);
    assert.equal(runtime.getUnit(1).definition, unit.definition);
    assert.deepEqual(runtime.unitsAt([0, 0]).map(value => value.id), [1]);
  });

  test(`battlefield ${name} preserves configured capability composition on update`, () => {
    const runtime = create();
    const unit = initializeUnit({ id: 1, definition: definition(), position: [0, 0] });
    const bare = initializeUnit({ id: 2, definition: { id: 'bare' }, position: [2, 0] });
    runtime[operation]([{ type: 'REGISTER_UNIT', unit }, { type: 'REGISTER_UNIT', unit: bare }]);
    const maps = runtime.navigationMaps;
    for (const key of Object.keys(configuredCapabilities)) {
      const missingState = { ...unit };
      delete missingState[key];
      for (const invalid of [missingState, { ...unit, [key]: undefined }, { ...bare, [key]: unit[key] }]) {
        assert.throws(() => runtime[operation]([
          { type: 'SET_POSITION_AND_RELEASE_BLOCKING', unitId: 1, position: [1, 0] },
          { type: 'UPDATE_UNIT', unit: invalid },
        ]), new RegExp(`capability ${key} state cannot be added or removed during update`));
        assert.deepEqual(runtime.getUnit(1).position, [0, 0]);
        assert.deepEqual(runtime.unitIds, [1, 2]);
        assert.equal(runtime.navigationMaps, maps);
      }
    }
    const updated = { ...unit, action: { ...unit.action, readyAtTick: 7, recoveryUntilTick: 8 },
      spatialPresence: { present: false }, occupancy: { claims: [] } };
    runtime[operation]([{ type: 'UPDATE_UNIT', unit: updated }]);
    assert.deepEqual(runtime.getUnit(1).action, updated.action);
    assert.deepEqual(runtime.unitsAt([0, 0]), []);
    const restored = { ...updated };
    delete restored.spatialPresence;
    delete restored.occupancy;
    runtime[operation]([{ type: 'UPDATE_UNIT', unit: restored }]);
    assert.deepEqual(runtime.unitsAt([0, 0]).map(value => value.id), [1]);
  });
}

test('unit snapshots copy partial composition without enforcing battlefield registration', () => {
  const unit = initializeUnit({ id: 1, definition: definition(), position: [0, 0] });
  const partial = { id: unit.id, definition: unit.definition, position: unit.position };
  assert.deepEqual(copyUnitSnapshot(partial), partial);
});

test('Unit with an acting definition and no action state remains statically legal', async () => {
  const { default: ts } = await import('typescript');
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-registration-types-'));
  const sourceModule = name => JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)));
  const path = join(directory, 'missing-action.mts');
  try {
    writeFileSync(path, `
import type { Unit } from ${sourceModule('unit/unit')};
import type { ActingUnitDefinition } from ${sourceModule('unit/capability/action/capability')};
import type { ImmutableData } from ${sourceModule('../common/immutable-data')};
import type { BattlefieldMap } from ${sourceModule('battlefield/map/map')};
import { createBattlefieldRuntime } from ${sourceModule('battlefield/runtime')};
declare const definition: ImmutableData<ActingUnitDefinition>;
declare const map: BattlefieldMap;
const unit: Unit<ActingUnitDefinition> = { id: 1, definition, position: [0, 0] };
const battlefield = createBattlefieldRuntime({ map });
battlefield.apply([{ type: 'REGISTER_UNIT', unit }]);
const custom = createBattlefieldRuntime({ map }, (unit: Unit<ActingUnitDefinition>) => ({ ...unit }));
custom.apply([{ type: 'REGISTER_UNIT', unit }]);
`);
    const program = ts.createProgram([path], {
      noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
      skipLibCheck: true, types: [],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    assert.deepEqual(diagnostics, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
