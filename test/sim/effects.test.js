import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEffectProgram,
  EffectResources,
} from '../../dist/core/tactical/effect/instance.js';
import {
  expireEffects,
  installEffect,
  removeEffect,
  removeEffectsOwnedByExecution,
  removeEffectsOwnedByUnit,
} from '../../dist/core/tactical/effect/lifecycle.js';
import { copyEffectsState } from '../../dist/core/tactical/unit/capability/effects.js';
import {
  createStatusDefinition,
  hasStatusFlag,
  initializeStatusState,
} from '../../dist/core/tactical/unit/capability/status.js';

function barrierProgram(id = 'barrier') {
  return createEffectProgram({
    id,
    initialize: () => ({ remainingAmount: 500 }),
    ownState: value => {
      if (!value || typeof value !== 'object' || !Number.isFinite(value.remainingAmount) || value.remainingAmount < 0) {
        throw new TypeError('invalid barrier state');
      }
      return value;
    },
  });
}

function metadata(id = 1, overrides = {}) {
  return {
    id, sourceUnitId: 7, lifetimeOwner: { type: 'UNIT', unitId: 9 },
    acquiredSequence: id, expiresAtTick: null, ...overrides,
  };
}

function unit(flags = []) {
  const status = createStatusDefinition({ initialFlags: flags });
  return {
    id: 2, definition: { id: 'unit', status }, position: [0, 0],
    status: initializeStatusState(status),
  };
}

test('effects: instance resources are separate from snapshot facts and restoration validates the program state', () => {
  const resources = new EffectResources();
  const program = resources.register(barrierProgram());
  const instance = resources.create(program.ref, metadata());
  const serialized = JSON.parse(JSON.stringify(instance));
  const restored = resources.restore(serialized);

  assert.deepEqual(instance.programRef, { id: 'barrier' });
  assert.deepEqual(Object.keys(program.ref), ['id']);
  assert.deepEqual(restored, instance);
  assert.equal(restored.programRef, program.ref);
  assert.equal(resources.typedState(restored, program.ref).remainingAmount, 500);
  serialized.state.remainingAmount = -1;
  assert.throws(() => resources.restore(serialized), /invalid barrier/);
  assert.throws(() => resources.restore({ ...serialized, programRef: { id: 'missing' } }), /unregistered/);
});

test('effects: reference and descriptor binding cannot be replaced by a second schema with the same identity', () => {
  const resources = new EffectResources();
  const program = resources.register(barrierProgram());
  const other = barrierProgram();

  assert.equal(resources.register(program), program);
  assert.throws(() => resources.register(other), /duplicate effect program/);
  assert.throws(() => resources.get(other.ref), /unregistered effect program/);
});

test('effects: typed updates isolate external facts, retain unchanged instances and copy shares owned state', () => {
  const resources = new EffectResources();
  const program = resources.register(barrierProgram());
  const instance = resources.create(program.ref, metadata());
  const input = { remainingAmount: 200, details: { applications: [1, 2] } };
  const updated = resources.update(instance, program.ref, input);
  const installed = installEffect(unit(), updated);
  const copy = copyEffectsState(installed.effects);

  input.remainingAmount = 1;
  input.details.applications.push(3);
  assert.equal(instance.state.remainingAmount, 500);
  assert.equal(updated.state.remainingAmount, 200);
  assert.deepEqual(updated.state.details.applications, [1, 2]);
  assert.ok(Object.isFrozen(updated.state.details.applications));
  assert.equal(resources.update(updated, program.ref, updated.state), updated);
  assert.equal(copy.instances, installed.effects.instances);
  assert.equal(copy.instances[0], updated);
});

test('effects: heterogeneous dispatch remains paired and an unrelated typed program cannot update an instance', () => {
  const resources = new EffectResources();
  const barrier = resources.register(barrierProgram());
  const shield = resources.register(createEffectProgram({
    id: 'shield', initialize: () => ({ remainingCharges: 2 }), ownState: value => value,
  }));
  const instance = resources.create(barrier.ref, metadata());

  assert.equal(resources.typedState(instance, shield.ref), undefined);
  assert.throws(() => resources.update(instance, shield.ref, { remainingCharges: 1 }), /matching program/);
  assert.deepEqual(resources.withProgram(instance, (bound, descriptor) => [bound.programRef.id, descriptor.ref.id]), ['barrier', 'barrier']);
});

test('effects: program ownership excludes behavior, accessors, cycles and sparse state arrays', () => {
  const resources = new EffectResources();
  const program = resources.register(barrierProgram());
  const instance = resources.create(program.ref, metadata());
  const cycle = {};
  cycle.self = cycle;
  const sparse = new Array(2);
  const accessor = Object.defineProperty({}, 'value', { get: () => assert.fail('accessor executed') });

  for (const invalid of [() => 1, cycle, sparse, accessor, new Map()]) {
    assert.throws(() => resources.update(instance, program.ref, { remainingAmount: 500, invalid }), TypeError);
  }
});

test('effects: installation and removal keep effect identity and status contributions atomic', () => {
  const resources = new EffectResources();
  const program = resources.register(barrierProgram());
  const original = unit();
  const first = installEffect(original, resources.create(program.ref, metadata(1)), ['INVINCIBLE']);
  const second = installEffect(first, resources.create(program.ref, metadata(2)), ['INVINCIBLE']);
  const removed = removeEffect(second, 1);
  const cleared = removeEffect(removed, 2);

  assert.equal(original.effects, undefined);
  assert.equal(hasStatusFlag(original, 'INVINCIBLE'), false);
  assert.equal(first.effects.instances[0].statusContributionId, '@effect/1');
  assert.equal(hasStatusFlag(removed, 'INVINCIBLE'), true);
  assert.equal(removed.effects.instances[0].id, 2);
  assert.equal(hasStatusFlag(cleared, 'INVINCIBLE'), false);
  assert.deepEqual(cleared.status.contributions, original.status.contributions);
  assert.equal(removeEffect(cleared, 99), cleared);
});

test('effects: installing flags requires existing Status and baseline facts survive effect removal', () => {
  const resources = new EffectResources();
  const program = resources.register(barrierProgram());
  const instance = resources.create(program.ref, metadata());
  const bare = { id: 2, definition: { id: 'bare' }, position: [0, 0] };
  const baseline = unit(['INVINCIBLE']);

  assert.throws(() => installEffect(bare, instance, ['INVINCIBLE']), /existing Status/);
  assert.equal(bare.effects, undefined);
  assert.equal(installEffect(bare, instance).effects.instances[0], instance);
  assert.equal(hasStatusFlag(removeEffect(installEffect(baseline, instance, ['INVINCIBLE']), 1), 'INVINCIBLE'), true);
  assert.throws(() => resources.restore({ ...instance, statusContributionId: '@baseline' }), /match/);
});

test('effects: expiration is independent of source and lifetime owner cleanup does not filter by source', () => {
  const resources = new EffectResources();
  const program = resources.register(barrierProgram());
  let current = unit();
  const values = [
    metadata(1, { sourceUnitId: 9, lifetimeOwner: { type: 'UNIT', unitId: 7 }, expiresAtTick: 5 }),
    metadata(2, { sourceUnitId: 7, lifetimeOwner: { type: 'EXECUTION', unitId: 9, executionId: 10 } }),
    metadata(3, { sourceUnitId: 7, lifetimeOwner: { type: 'EXECUTION', unitId: 9, executionId: 11 } }),
    metadata(4, { sourceUnitId: 9, lifetimeOwner: null }),
  ];

  for (const value of values) {
    current = installEffect(current, resources.create(program.ref, value), ['HEAL_FREE']);
  }

  assert.equal(expireEffects(current, 4), current);
  assert.deepEqual(expireEffects(current, 5).effects.instances.map(effect => effect.id), [2, 3, 4]);
  assert.deepEqual(removeEffectsOwnedByExecution(current, 9, 10).effects.instances.map(effect => effect.id), [1, 3, 4]);
  assert.deepEqual(removeEffectsOwnedByUnit(current, 9).effects.instances.map(effect => effect.id), [1, 4]);
});

test('effects: TypeScript preserves invariant program state references and typed combat hook inference', async () => {
  const { default: ts } = await import('typescript');
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-effect-types-'));
  const sourceModule = name => JSON.stringify(fileURLToPath(
    new URL(`../../src/core/tactical/${name}.js`, import.meta.url)));
  const imports = `
import { createEffectProgram, EffectResources, type EffectProgram, type EffectProgramRef } from ${sourceModule('effect/instance')};
import { CombatResources, type DamageRuleContext } from ${sourceModule('combat/resources')};
import type { PendingDamage } from ${sourceModule('combat/contract')};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
interface BarrierState { readonly remainingAmount: number; }
interface ShieldState { readonly remainingCharges: number; }
interface SpecializedBarrierState extends BarrierState { readonly category: 'arts'; }
function ownBarrierState(value: unknown): BarrierState {
  if (value === null || typeof value !== 'object' || !('remainingAmount' in value)
      || typeof value.remainingAmount !== 'number' || !Number.isFinite(value.remainingAmount)) {
    throw new TypeError('invalid barrier state');
  }
  return Object.freeze({ remainingAmount: value.remainingAmount });
}
const barrier = createEffectProgram({
  id: 'barrier', initialize: (): BarrierState => ({ remainingAmount: 500 }), ownState: ownBarrierState,
});
const resources = new EffectResources();
resources.register(barrier);
const instance = resources.create(barrier.ref, {
  id: 1, sourceUnitId: null, lifetimeOwner: null, acquiredSequence: 0, expiresAtTick: null,
});
`;
  const compile = (name, source) => {
    const path = join(directory, `${name}.mts`);
    writeFileSync(path, imports + source);
    const program = ts.createProgram([path], {
      noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
      skipLibCheck: true, types: [],
    });

    return ts.getPreEmitDiagnostics(program).map(diagnostic => ({
      file: diagnostic.file?.fileName,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }));
  };

  try {
    assert.deepEqual(compile('positive', `
type InferredReference = Assert<Equal<typeof barrier.ref, EffectProgramRef<BarrierState>>>;
type InferredState = Assert<Equal<typeof instance.state, BarrierState>>;
const descriptor = resources.get(barrier.ref);
type InferredDescriptor = Assert<Equal<typeof descriptor, EffectProgram<BarrierState>>>;
const updated = resources.update(instance, barrier.ref, { remainingAmount: 200 });
type UpdatedState = Assert<Equal<typeof updated.state, BarrierState>>;
const current = resources.typedState(updated, barrier.ref);
type OptionalState = Assert<Equal<typeof current, BarrierState | undefined>>;
resources.withProgram(instance, (bound, program) => resources.update(bound, program.ref, bound.state).id);
const combat = new CombatResources();
combat.registerEffect(barrier, {
  reception: [{ priority: 0, apply: (context, pending) => {
    const amount: number = context.instance.state.remainingAmount;
    const work = context.resources.updateEffectState(
      context.work, context.ownerUnitId, context.instance.id, context.instance.programRef,
      { remainingAmount: Math.max(0, amount - pending.amount) },
    );
    return { work, value: pending };
  } }],
  reaction: [{ priority: 0, apply: (context, report) => {
    const amount: number = context.instance.state.remainingAmount;
    const hpLoss: number = report.hpLoss;
    return context.resources.updateEffectState(
      context.work, context.ownerUnitId, context.instance.id, context.instance.programRef,
      { remainingAmount: amount + hpLoss },
    );
  } }],
});
`), []);

    for (const [name, source, errors] of [
      ['references', `
declare const specializedRef: EffectProgramRef<SpecializedBarrierState>;
const incompatible: EffectProgramRef<ShieldState> = barrier.ref;
const cannotWiden: EffectProgramRef<BarrierState> = specializedRef;
const cannotNarrow: EffectProgramRef<SpecializedBarrierState> = barrier.ref;
const cannotForge: EffectProgramRef<ShieldState> = { id: 'barrier' };
`, 4],
      ['state-update', `resources.update(instance, barrier.ref, { remainingCharges: 2 });`, 1],
      ['combat-hook', `
const combat = new CombatResources();
combat.registerEffect(barrier, {
  reception: [{ priority: 0, apply: (context: DamageRuleContext<ShieldState>, pending: PendingDamage) => ({ work: context.work, value: pending }) }],
});
`, 1],
    ]) {
      const diagnostics = compile(name, source);
      const ownErrors = diagnostics.filter(diagnostic => diagnostic.file === join(directory, `${name}.mts`));

      assert.equal(ownErrors.length, errors,
        `${name} must reject every mismatched state binding: ${JSON.stringify(diagnostics)}`);
      assert.equal(diagnostics.length, ownErrors.length,
        `${name} must not rely on unrelated compilation failures: ${JSON.stringify(diagnostics)}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
