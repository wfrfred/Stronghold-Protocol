import { fixtureBattle } from "../helpers/unit.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize } from "../helpers/unit.js";
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
  assert.deepEqual(unit.deployable, initializeDeployable(fixtureBattle(0), definition.deployable).value);

  const other = initialize({ id: 1, definition: { id: 'enemy' }, position: [0, 0] });
  assert.equal(hasDeployable(other), false);
});

test('deployable state is initialized before deployment associates a Card', () => {
  const unit = initialize({ id: 0, definition, position: [0, 0] });
  assert.equal(unit.deployable.cardId, null);
  const deployed = { ...unit, deployable: { ...unit.deployable, cardId: 17 } };
  assert.equal(deployed.deployable.cardId, 17);
  assert.equal(unit.deployable.cardId, null);
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
  assert.deepEqual(created.deployable, initializeDeployable(fixtureBattle(0), definition.deployable).value);
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
declare const battle: import(${module('../../src/core/tactical/battle/state.js')}).State;
const unit: Unit & Deployable = initialize(battle, { id: 0, definition, position: [0, 0] }).value;
const cardId: number | null = unit.deployable.cardId;
declare const unknownUnit: Unit & { readonly label: string };
if (hasDeployable(unknownUnit)) {
  const guarded: Unit & Deployable = unknownUnit;
  const label: string = guarded === unknownUnit ? unknownUnit.label : '';
}
// @ts-expect-error deployable state requires a corresponding definition
initialize(battle, { id: 2, definition: { id: 'enemy' }, position: [0, 0], states: {} });
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
