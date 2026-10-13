import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize } from '../../dist/core/tactical/unit/initialize.js';
import { assertUnitCapabilityPairing } from '../../dist/core/tactical/unit/capability/catalog.js';
import { createDefinition as createDeployableDefinition, initialize as initializeDeployable, hasDeployable } from '../../dist/core/tactical/unit/capability/deployable/capability.js';
import { createDefinition as createOperator } from '../../dist/core/tactical/unit/archetype/operator.js';
import { unit as actionUnit } from '../helpers/action-fixture.js';

const definition = {
  id: 'deployable',
  deployable: createDeployableDefinition({ cost: 0, redeployTicks: 0, slots: 1, buildableType: 'MELEE' }),
};

test('deployable definitions initialize a paired capability without a Card', () => {
  const unit = initialize({ id: 0, definition, position: [0, 0] });
  assert.equal(hasDeployable(unit), true);
  assert.equal(unit.definition.deployable, definition.deployable);
  assert.deepEqual(unit.deployable, initializeDeployable(definition.deployable));
  assert.doesNotThrow(() => assertUnitCapabilityPairing(unit));

  const other = initialize({ id: 1, definition: { id: 'enemy' }, position: [0, 0] });
  assert.equal(hasDeployable(other), false);
  assert.doesNotThrow(() => assertUnitCapabilityPairing(other));
});

test('prepared deployable state preserves its Card association and requires configuration', () => {
  const deployable = { ...initializeDeployable(definition.deployable), cardId: 17 };
  const unit = initialize({ id: 0, definition, position: [0, 0], states: { deployable } });
  assert.equal(unit.deployable, deployable);
  assert.equal(unit.deployable.cardId, 17);
  assert.deepEqual(deployable, { ...initializeDeployable(definition.deployable), cardId: 17 });
  assert.throws(() => initialize({
    id: 1, definition: { id: 'unconfigured' }, position: [0, 0], states: { deployable },
  }), /prepared capability deployable requires configuration/);
  const { deployable: _deployment, ...unpaired } = unit;
  assert.throws(() => assertUnitCapabilityPairing(unpaired), /configuration and state must be paired/);
});

test('operator content factories preserve an optional deployable capability', () => {
  const operator = createOperator({
    ...actionUnit(0, { action: true }).definition,
    blocker: { capacity: 0, geometry: { radius: 0.1 } },
    deployable: definition.deployable,
  });
  const created = initialize({ id: 0, position: [0, 0], definition: operator });
  assert.equal(operator.deployable, definition.deployable);
  assert.equal(hasDeployable(created), true);
  assert.deepEqual(created.deployable, initializeDeployable(definition.deployable));
});

test('factory inference and the deployable guard retain capability and caller types', async () => {
  const { default: ts } = await import('typescript');
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-deployable-types-'));
  const module = (path) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
  const path = join(directory, 'deployable.mts');
  try {
    writeFileSync(path, `
import { initialize } from ${module('../../src/core/tactical/unit/initialize.js')};
import { initialize as initializeDeployable, hasDeployable, type Deployable } from ${module('../../src/core/tactical/unit/capability/deployable/capability.js')};
import type { Unit } from ${module('../../src/core/tactical/unit/unit.js')};

const definition = { id: 'typed-deployable', deployable: {
  cost: 0, redeployTicks: 0, slots: 1, buildableType: 'MELEE' as const, advancedBuildableMask: 1,
  refund: { rate: 0.5, limit: 'BASE_COST' as const },
} };
const unit: Unit & Deployable = initialize({ id: 0, definition, position: [0, 0] });
const prepared: Unit & Deployable = initialize({
  id: 1, definition, position: [0, 0], states: { deployable: { ...initializeDeployable(definition.deployable), cardId: 17 } },
});
const cardId: number | null = prepared.deployable.cardId;
declare const unknownUnit: Unit & { readonly label: string };
if (hasDeployable(unknownUnit)) {
  const guarded: Unit & Deployable = unknownUnit;
  const label: string = guarded === unknownUnit ? unknownUnit.label : '';
}
// @ts-expect-error deployable state requires a corresponding definition
initialize({ id: 2, definition: { id: 'enemy' }, position: [0, 0], states: { deployable: { ...initializeDeployable(definition.deployable), cardId: 17 } } });
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
