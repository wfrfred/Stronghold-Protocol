import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createEffectSourceProgramRef } from '../../dist/core/tactical/battlefield/effect-source/program.js';
import { createEnemyDefinition } from '../../dist/core/tactical/unit/archetype/enemy.js';
import { ownUnitDefinition } from '../../dist/core/tactical/unit/unit.js';
import { createNavigationModifierDefinition } from '../../dist/core/tactical/battlefield/navigation/modifier.js';
import { createRouteDefinition } from '../../dist/core/tactical/unit/capability/locomotion/route/definition.js';

test('runtime accepts the battle contract Input directly with factory-owned maps and creation references', async () => {
  const { default: ts } = await import('typescript');
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-battle-input-types-'));
  const sourceModule = path => JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/${path}.js`, import.meta.url)));
  const path = join(directory, 'input.mts');
  try {
    writeFileSync(path, `
import type { Input, Command, Event, Result, Snapshot, Step } from ${sourceModule('battle/contract')};
import { BattleRuntime } from ${sourceModule('battle/runtime')};
import type { BattlefieldMap } from ${sourceModule('battlefield/map/map')};
import type { NavigationModifier } from ${sourceModule('battlefield/navigation/modifier')};
declare const input: Input;
declare const rawMap: Pick<BattlefieldMap, 'rows' | 'columns' | 'tiles' | 'markers' | 'blockEdges'>;
declare const runtimeModifier: NavigationModifier;
const runtime = new BattleRuntime(input);
new BattleRuntime(Object.freeze(input));
const commands: readonly Command[] = [];
const step: Step = runtime.step(commands);
const events: readonly Event[] = step.events;
const result: Result | null = step.result;
const snapshot: Snapshot = runtime.snapshot();
// @ts-expect-error Map ownership still requires the domain factory's brand.
new BattleRuntime({ ...input, map: rawMap });
${['initialUnits', 'initialMechanisms', 'initialNavigationModifiers'].map((field, index) => `
const { ${field}: omitted${index}, ...without${index} } = input;
// @ts-expect-error Every initial collection must be supplied explicitly.
new BattleRuntime(without${index});
`).join('')}
${['nextUnitId', 'nextNavigationRequestId', 'nextMechanismId', 'nextNavigationModifierId'].map(field => `
// @ts-expect-error Instance identity allocation belongs to the runtime.
new BattleRuntime({ ...input, ${field}: 100 });
`).join('')}
// @ts-expect-error Runtime instance sources carry IDs rather than creation indices.
new BattleRuntime({ ...input, initialNavigationModifiers: [runtimeModifier] });
// @ts-expect-error Runtime source state cannot replace a creation reference.
new BattleRuntime({ ...input, initialMechanisms: [{ definition: { id: 'source' }, effectSource: { programRef: { id: 'program' }, state: {}, sourceUnitId: 10 } }] });
new BattleRuntime({ ...input, initialMechanisms: [{ definition: { id: 'source' }, effectSource: { programRef: { id: 'program' }, state: {}, sourceUnitIndex: 0 } }] });
new BattleRuntime({ ...input, initialNavigationModifiers: [{ definition: runtimeModifier.definition, source: { type: 'UNIT', unitIndex: 0 }, region: { type: 'FOLLOW_UNIT', unitIndex: 1, range: [[0, 0]], direction: 'RIGHT' } }] });
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

const restriction = (id, costFloor) => createNavigationModifierDefinition({
  id, WALK: { denyPassage: false, deniedDepartures: [], costFloor }, FLY: null,
});
const fixed = column => ({ type: 'FIXED', position: [0, column], range: [[0, 0]], direction: 'RIGHT' });
const attached = (id, costFloor) => ({ definition: restriction(id, costFloor), range: [[0, 0]], direction: 'RIGHT' });
const placement = (id, column, navigationModifiers = []) => ({
  definition: ownUnitDefinition({ id, vitality: { maxHp: 100 } }), position: [column, 0], navigationModifiers,
});

function fixture({ spawnTick = 100 } = {}) {
  const tile = {
    heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
  };
  const map = createBattlefieldMap(1, 8, Array.from({ length: 8 }, () => tile));
  const resources = new CombatResources();
  const ref = createEffectSourceProgramRef('initial-source');
  resources.effectSources.register({
    ref,
    initialize: () => ({ quota: { remaining: 0 }, marks: [] }),
    ownState: state => state,
    selectInitial: () => [],
    install: () => undefined,
  });
  const enemy = createEnemyDefinition({
    id: 'scheduled-enemy', vitality: { maxHp: 100 },
    locomotion: {
      moveSpeedPerTick: 0,
      steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
    },
  });
  const route = createRouteDefinition({
    pathMotionMode: 'WALK', startPosition: [0, 7], endPosition: [0, 7],
    spawnOffset: [0, 0], spawnRandomRange: [0.3, 0.3],
    checkpoints: [{ type: 'WAIT_FOR_TICKS', durationTicks: 100 }],
    allowDiagonalMove: false, visitEveryTileCenter: false,
    visitEveryNodeCenter: false, visitEveryCheckPoint: true,
  });
  const fields = {
    map,
    schedule: { type: 'TIMELINE', spawns: [{
      definition: enemy, route, tick: spawnTick,
      timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
      alwaysCheckCurrentPoint: true, notCountInTotal: false,
    }] },
    initialUnits: [
      placement('placed-a', 0, [attached('unit-navigation', 2)]),
      placement('placed-b', 1),
    ],
    initialMechanisms: [
      {
        definition: { id: 'source-mechanism' },
        effectSource: {
          programRef: ref, state: { quota: { remaining: 3 }, marks: [1, 2] }, sourceUnitIndex: 1,
        },
      },
      { definition: { id: 'plain-mechanism' } },
    ],
    initialNavigationModifiers: [
      { definition: restriction('mechanism-navigation', 3), source: { type: 'MECHANISM', mechanismIndex: 1 }, region: fixed(4) },
      {
        definition: restriction('followed-navigation', 6), source: { type: 'UNIT', unitIndex: 1 },
        region: { type: 'FOLLOW_UNIT', unitIndex: 0, range: [[0, 0]], direction: 'RIGHT' },
      },
    ],
    predefines: [
      {
        id: 100, alias: 'present-mechanism', initiallyPresent: true,
        creation: { type: 'MECHANISM', definition: { id: 'predefined-mechanism' }, navigationModifiers: [
          { definition: restriction('predefined-mechanism-navigation', 4), region: fixed(5) },
        ] },
      },
      {
        id: 101, alias: 'present-unit', initiallyPresent: true,
        creation: { type: 'UNIT', ...placement('predefined-unit', 2, [attached('predefined-unit-navigation', 5)]) },
      },
      {
        id: 102, alias: 'later-mechanism', initiallyPresent: false,
        creation: { type: 'MECHANISM', definition: { id: 'later-mechanism' }, navigationModifiers: [
          { definition: restriction('later-mechanism-navigation', 8), region: fixed(6) },
        ] },
      },
      {
        id: 103, alias: 'later-unit', initiallyPresent: false,
        creation: { type: 'UNIT', ...placement('later-unit', 3, [attached('later-unit-navigation', 7)]) },
      },
    ],
    maxTicks: 4,
    routeMoveMultiplier: 1,
    rngState: 17,
  };
  return { fields, resources, ref };
}

test('runtime allocates initial IDs, resolves creation references, and never reuses predefined instance IDs', () => {
  const { fields, resources, ref } = fixture();
  const input = fields;
  const runtime = new BattleRuntime(input, { combat: resources });
  const initial = runtime.snapshot();

  assert.equal(initial.units[0].definition, fields.initialUnits[0].definition);
  assert.equal(initial.mechanisms[1].definition, fields.initialMechanisms[1].definition);
  assert.equal(initial.navigationModifiers[1].definition, fields.initialNavigationModifiers[0].definition);
  assert.deepEqual(initial.units.map(unit => unit.id), [0, 1, 2]);
  assert.deepEqual(initial.mechanisms.map(mechanism => mechanism.id), [0, 1, 2]);
  assert.deepEqual(initial.navigationModifiers.map(modifier => modifier.id), [0, 1, 2, 3, 4]);
  assert.deepEqual(initial.execution, {
    rngState: 17, nextUnitId: 3, nextNavigationRequestId: 0,
    nextMechanismId: 3, nextNavigationModifierId: 5,
  });
  assert.deepEqual(initial.navigationModifiers[1].source, { type: 'MECHANISM', mechanismId: 1 });
  assert.deepEqual(initial.navigationModifiers[2].source, { type: 'UNIT', unitId: 1 });
  assert.deepEqual(initial.navigationModifiers[2].region, {
    type: 'FOLLOW_UNIT', unitId: 0, range: [[0, 0]], direction: 'RIGHT',
  });
  assert.equal(initial.mechanisms[0].effectSource.sourceUnitId, 1);
  assert.equal(initial.mechanisms[0].effectSource.programRef, ref);
  assert.equal(initial.mechanisms[0].effectSource.initialized, true);

  runtime.step([
    { type: 'APPEAR_PREDEFINED', definitionId: 102 },
    { type: 'APPEAR_PREDEFINED', definitionId: 103 },
  ]);
  const appeared = runtime.snapshot();
  assert.deepEqual(appeared.units.map(unit => unit.id), [0, 1, 2, 3]);
  assert.deepEqual(appeared.mechanisms.map(mechanism => mechanism.id), [0, 1, 2, 3]);
  assert.deepEqual(appeared.navigationModifiers.map(modifier => modifier.id), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(appeared.predefinedPresence.filter(binding => binding.definitionId >= 102), [
    { definitionId: 102, source: { type: 'MECHANISM', mechanismId: 3 } },
    { definitionId: 103, source: { type: 'UNIT', unitId: 3 } },
  ]);

  runtime.step([
    { type: 'REMOVE_PREDEFINED', definitionId: 102, reason: 'SCRIPT' },
    { type: 'REMOVE_PREDEFINED', definitionId: 103, reason: 'SCRIPT' },
    { type: 'APPEAR_PREDEFINED', definitionId: 102 },
    { type: 'APPEAR_PREDEFINED', definitionId: 103 },
  ]);
  const replaced = runtime.snapshot();
  assert.deepEqual(replaced.units.map(unit => unit.id), [0, 1, 2, 4]);
  assert.deepEqual(replaced.mechanisms.map(mechanism => mechanism.id), [0, 1, 2, 4]);
  assert.deepEqual(replaced.navigationModifiers.map(modifier => modifier.id), [0, 1, 2, 3, 4, 7, 8]);
  assert.equal(replaced.execution.nextUnitId, 5);
  assert.equal(replaced.execution.nextMechanismId, 5);
  assert.equal(replaced.execution.nextNavigationModifierId, 9);
});

for (const scenario of [
  {
    name: 'modifier source unit',
    change: fields => { fields.initialNavigationModifiers[0].source = { type: 'UNIT', unitIndex: 2 }; },
    message: /unknown initial unit index: 2/,
  },
  {
    name: 'modifier source mechanism',
    change: fields => { fields.initialNavigationModifiers[0].source.mechanismIndex = 2; },
    message: /unknown initial mechanism index: 2/,
  },
  {
    name: 'followed unit',
    change: fields => { fields.initialNavigationModifiers[1].region.unitIndex = 2; },
    message: /unknown initial followed unit index: 2/,
  },
  {
    name: 'mechanism source unit',
    change: fields => { fields.initialMechanisms[0].effectSource.sourceUnitIndex = 2; },
    message: /unknown initial unit index: 2/,
  },
]) {
  test(`runtime rejects an unknown initial ${scenario.name} reference during initialization`, () => {
    const { fields, resources } = fixture();
    scenario.change(fields);
    assert.throws(() => new BattleRuntime(fields, { combat: resources }), scenario.message);
  });
}

test('one battle input replays allocations, seeded spawning and navigation deterministically', () => {
  const { fields, resources } = fixture({ spawnTick: 0 });
  const input = fields;
  const runtimes = [new BattleRuntime(input, { combat: resources }), new BattleRuntime(input, { combat: resources })];
  const commands = [
    { type: 'APPEAR_PREDEFINED', definitionId: 102 },
    { type: 'APPEAR_PREDEFINED', definitionId: 103 },
  ];
  const initial = runtimes[0].snapshot();
  for (let tick = 0; tick < input.maxTicks; tick++) {
    const outputs = runtimes.map(runtime => runtime.step(tick === 0 ? commands : []));
    assert.deepEqual(outputs[0], outputs[1]);
    assert.deepEqual(runtimes[0].snapshot(), runtimes[1].snapshot());
    assert.deepEqual(runtimes[0].navigationMaps, runtimes[1].navigationMaps);
  }
  const final = runtimes[0].snapshot();
  const spawned = final.units.find(unit => unit.definition.id === 'scheduled-enemy');
  assert.equal(spawned.id, 4);
  assert.notDeepEqual(spawned.position, [7, 0]);
  assert.notEqual(final.execution.rngState, input.rngState);
  assert.equal(initial.execution.rngState, input.rngState);
  assert.equal(runtimes[0].result.reason, 'TIME_LIMIT');
  assert.equal(runtimes[0].result.spawnedCount, 1);
});
