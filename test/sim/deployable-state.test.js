import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize } from '../../dist/core/tactical/unit/initialize.js';
import { assertUnitCapabilityPairing } from '../../dist/core/tactical/unit/capability/catalog.js';
import { createDeploymentProfile, hasDeployable } from '../../dist/core/tactical/unit/capability/deployment.js';
import { createDefinition as createOperator } from '../../dist/core/tactical/unit/archetype/operator.js';
import { unit as actionUnit } from '../helpers/action-fixture.js';

const definition = {
  id: 'deployable',
  deployment: createDeploymentProfile({ buildableType: 'MELEE' }),
};

test('deployment definitions initialize a paired capability without a Card', () => {
  const unit = initialize({ id: 0, definition, position: [0, 0] });
  assert.equal(hasDeployable(unit), true);
  assert.equal(unit.definition.deployment, definition.deployment);
  assert.deepEqual(unit.deployment, { cardId: null });
  assert.doesNotThrow(() => assertUnitCapabilityPairing(unit));

  const other = initialize({ id: 1, definition: { id: 'enemy' }, position: [0, 0] });
  assert.equal(hasDeployable(other), false);
  assert.doesNotThrow(() => assertUnitCapabilityPairing(other));
});

test('prepared deployment state preserves its Card association and requires configuration', () => {
  const deployment = { cardId: 17 };
  const unit = initialize({ id: 0, definition, position: [0, 0], states: { deployment } });
  assert.equal(unit.deployment, deployment);
  assert.equal(unit.deployment.cardId, 17);
  assert.deepEqual(deployment, { cardId: 17 });
  assert.throws(() => initialize({
    id: 1, definition: { id: 'unconfigured' }, position: [0, 0], states: { deployment },
  }), /prepared capability deployment requires configuration/);
  const { deployment: _deployment, ...unpaired } = unit;
  assert.throws(() => assertUnitCapabilityPairing(unpaired), /configuration and state must be paired/);
});

test('operator content factories preserve an optional deployment capability', () => {
  const operator = createOperator({
    ...actionUnit(0, { action: true }).definition,
    blocker: { capacity: 0, geometry: { radius: 0.1 } },
    deployment: definition.deployment,
  });
  const created = initialize({ id: 0, position: [0, 0], definition: operator });
  assert.equal(operator.deployment, definition.deployment);
  assert.equal(hasDeployable(created), true);
  assert.deepEqual(created.deployment, { cardId: null });
});

test('factory inference and the deployment guard retain capability and caller types', async () => {
  const { default: ts } = await import('typescript');
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-deployable-types-'));
  const module = (path) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
  const path = join(directory, 'deployable.mts');
  try {
    writeFileSync(path, `
import { initialize } from ${module('../../src/core/tactical/unit/initialize.js')};
import { hasDeployable, type Deployable } from ${module('../../src/core/tactical/unit/capability/deployment.js')};
import type { Unit } from ${module('../../src/core/tactical/unit/unit.js')};

const definition = { id: 'typed-deployable', deployment: {
  buildableType: 'MELEE' as const, advancedBuildableMask: 1,
} };
const unit: Unit & Deployable = initialize({ id: 0, definition, position: [0, 0] });
const prepared: Unit & Deployable = initialize({
  id: 1, definition, position: [0, 0], states: { deployment: { cardId: 17 } },
});
const cardId: number | null = prepared.deployment.cardId;
declare const unknownUnit: Unit & { readonly label: string };
if (hasDeployable(unknownUnit)) {
  const guarded: Unit & Deployable = unknownUnit;
  const label: string = guarded === unknownUnit ? unknownUnit.label : '';
}
// @ts-expect-error deployment state requires a corresponding definition
initialize({ id: 2, definition: { id: 'enemy' }, position: [0, 0], states: { deployment: { cardId: 17 } } });
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
