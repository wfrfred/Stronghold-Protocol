import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEffectProgram } from '../../dist/core/tactical/effect/instance.js';
import { installEffect } from '../../dist/core/tactical/effect/lifecycle.js';
import { createNumericContribution, resolveNumericValue } from '../../dist/core/tactical/modifier/numeric.js';
import { resolveAttackPower } from '../../dist/core/tactical/combat/attributes.js';
import { createDamageOperands } from '../../dist/core/tactical/combat/contract.js';
import { resolveDamage } from '../../dist/core/tactical/combat/damage.js';
import { resolveHealing } from '../../dist/core/tactical/combat/healing.js';
import { CombatResources } from '../../dist/core/tactical/combat/resources.js';
import {
  absorbBarrier, multiplyAttackScale, multiplyDamage, reduceDamage, replaceAttackScale,
} from '../../dist/core/tactical/combat/rules.js';
import {
  combatWorkChanges, createCombatWork, getCombatUnit,
} from '../../dist/core/tactical/combat/work.js';
import { createDefenseDefinition } from '../../dist/core/tactical/unit/capability/defense.js';
import { createOffenseDefinition } from '../../dist/core/tactical/unit/capability/offense.js';
import {
  createStatusDefinition, initializeStatusState,
} from '../../dist/core/tactical/unit/capability/status.js';

function unit(id, { hp = 5000, maxHp = hp, attack = 100, defense = 0, resistance = 0, flags = [] } = {}) {
  const status = createStatusDefinition({ initialFlags: flags });

  return {
    id, position: [0, 0],
    definition: {
      id: `unit-${id}`, vitality: { maxHp }, status,
      offense: createOffenseDefinition({ attack }),
      defense: createDefenseDefinition({ defense, resistance }),
    },
    vitality: { hp }, status: initializeStatusState(status),
  };
}

function workFor(...units) {
  const values = new Map(units.map(value => [value.id, value]));

  return createCombatWork({
    unitIds: [...values.keys()], getUnit: id => values.get(id),
    blockerOf: () => undefined, blockedBy: () => [],
  });
}

function program(id, initialState = {}) {
  return createEffectProgram({
    id,
    initialize: () => initialState,
    ownState: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`invalid ${id} state`);
      }
      for (const key of Object.keys(initialState)) {
        if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) {
          throw new TypeError(`invalid ${id} ${key}`);
        }
      }
      return value;
    },
  });
}

function attach(resources, owner, descriptor, id, acquiredSequence = id) {
  const instance = resources.effects.create(descriptor.ref, {
    id, acquiredSequence, sourceUnitId: null,
    lifetimeOwner: { type: 'UNIT', unitId: owner.id }, expiresAtTick: null,
  });

  return installEffect(owner, instance);
}

function stateOf(work, resources, ownerId, descriptor, instanceId) {
  const instance = getCombatUnit(work, ownerId).effects.instances.find(value => value.id === instanceId);

  return resources.effects.typedState(instance, descriptor.ref);
}

function request(power, overrides = {}) {
  return {
    sourceUnitId: 1, targetUnitId: 2, damageType: 'PHYSICAL',
    operands: createDamageOperands(power), tick: 12, ...overrides,
  };
}

test('damage pipeline: numeric contributions retain four distinct positions and clamp the direct multiplier', () => {
  const contributions = [
    createNumericContribution({ addition: 10, multiplier: 0.5, finalAddition: 7, finalScaler: 2 }),
    createNumericContribution({ addition: 20, multiplier: 0.5, finalAddition: 3, finalScaler: 0.5 }),
  ];

  assert.equal(resolveNumericValue(100, contributions), 270);
  assert.equal(resolveNumericValue(100, [createNumericContribution({ multiplier: -2, finalAddition: 7, finalScaler: 2 })]), 14);
});

test('damage pipeline: low HP attack contributions read current work after damage and healing', () => {
  const resources = new CombatResources();
  const lowHp = resources.registerEffect(program('low-hp'), {
    attack: ({ unit: owner, battlefield }) => {
      const current = battlefield.getUnit(owner.id);
      return current.vitality.hp < current.definition.vitality.maxHp / 2
        ? [createNumericContribution({ multiplier: 1 })] : [];
    },
  });
  const source = attach(resources, unit(1, { hp: 750, maxHp: 1000 }), lowHp, 11);
  const original = workFor(source, unit(2));
  const damaged = resolveDamage(original, request(500, { sourceUnitId: 2, targetUnitId: 1 }), resources);
  const healed = resolveHealing(damaged.work, { sourceUnitId: 2, targetUnitId: 1, power: 400, ignoreHealFree: false }, resources, 12);

  assert.equal(resolveAttackPower(source, original, resources), 100);
  assert.equal(getCombatUnit(damaged.work, 1).vitality.hp, 250);
  assert.equal(resolveAttackPower(getCombatUnit(damaged.work, 1), damaged.work, resources), 200);
  assert.equal(getCombatUnit(healed.work, 1).vitality.hp, 650);
  assert.equal(resolveAttackPower(getCombatUnit(healed.work, 1), healed.work, resources), 100);
  assert.equal(getCombatUnit(original, 1).vitality.hp, 750);
});

test('damage pipeline: attack scale multiplication and replacement preserve their execution order', () => {
  const outcomes = [
    [multiplyAttackScale(() => 2), replaceAttackScale(() => 3), 300],
    [replaceAttackScale(() => 3), multiplyAttackScale(() => 2), 600],
  ];

  for (const [first, second, expected] of outcomes) {
    const resources = new CombatResources();
    const descriptor = resources.registerEffect(program('attack-scale'), {
      sourceFormula: [{ priority: 0, apply: first }, { priority: 0, apply: second }],
    });
    const source = attach(resources, unit(1), descriptor, 11);
    const result = resolveDamage(workFor(source, unit(2)), request(100), resources);

    assert.equal(result.report.formulaDamage, expected);
    assert.equal(result.report.hpLoss, expected);
  }
});

test('damage pipeline: fixed penetration precedes proportional penetration for defense and resistance', () => {
  const examples = [
    { damageType: 'PHYSICAL', defense: 200, resistance: 0, fixed: 100, expected: 950 },
    { damageType: 'ARTS', defense: 0, resistance: 80, fixed: 10, expected: 650 },
  ];

  for (const example of examples) {
    const resources = new CombatResources();
    const result = resolveDamage(workFor(unit(1), unit(2, example)), request(1000, {
      damageType: example.damageType,
      operands: { ...createDamageOperands(1000), fixedPenetration: example.fixed, proportionalPenetration: 0.5 },
    }), resources);

    assert.equal(result.report.formulaDamage, example.expected);
  }
});

test('damage pipeline: a 500 barrier before doubling takes 400 HP, while doubling before the barrier takes 900', () => {
  for (const [barrierPriority, scalePriority, expected] of [[100, 0, 400], [0, 100, 900]]) {
    const resources = new CombatResources();
    const barrier = resources.registerEffect(program('barrier', { remainingAmount: 500 }), {
      reception: [{ priority: barrierPriority, apply: absorbBarrier() }],
    });
    const fragile = resources.registerEffect(program('fragile'), {
      reception: [{ priority: scalePriority, apply: multiplyDamage(() => 2) }],
    });
    let target = attach(resources, unit(2), barrier, 21);
    target = attach(resources, target, fragile, 22);
    const result = resolveDamage(workFor(unit(1), target), request(700), resources);

    assert.equal(result.report.formulaDamage, 700);
    assert.equal(result.report.outputDamage, 700);
    assert.equal(result.report.hpDamage, expected);
    assert.equal(result.report.hpLoss, expected);
    assert.equal(getCombatUnit(result.work, 2).vitality.hp, 5000 - expected);
    assert.equal(stateOf(result.work, resources, 2, barrier, 21).remainingAmount, 0);
    assert.deepEqual(result.report.resourceConsumptions, [{ ownerUnitId: 2, instanceId: 21, resource: 'barrier', amount: 500 }]);
    assert.equal(target.effects.instances[0].state.remainingAmount, 500);
  }
});

test('damage pipeline: fixed reduction and complete barrier absorption consume resources without HP loss', () => {
  const resources = new CombatResources();
  const barrier = resources.registerEffect(program('barrier', { remainingAmount: 800 }), {
    reception: [{ priority: 0, apply: absorbBarrier() }],
  });
  const reduction = resources.registerEffect(program('reduction'), {
    reception: [{ priority: 100, apply: reduceDamage(() => 100) }],
  });
  let target = attach(resources, unit(2), barrier, 21);
  target = attach(resources, target, reduction, 22);
  const result = resolveDamage(workFor(unit(1), target), request(700), resources);

  assert.equal(result.report.hpDamage, 0);
  assert.equal(result.report.hpLoss, 0);
  assert.equal(result.report.cancellation, null);
  assert.equal(result.report.resourceConsumptions[0].amount, 600);
  assert.equal(stateOf(result.work, resources, 2, barrier, 21).remainingAmount, 200);
  assert.equal(getCombatUnit(result.work, 2).vitality.hp, 5000);
  assert.ok(combatWorkChanges(result.work).some(change => change.type === 'UPDATE_UNIT' && change.unit.id === 2));
});

test('damage pipeline: consecutive reception rules read the same instance after its previous consumption', () => {
  const resources = new CombatResources();
  const barrier = resources.registerEffect(program('barrier', { remainingAmount: 500 }), {
    reception: [{ priority: 0, apply: absorbBarrier() }, { priority: 0, apply: absorbBarrier() }],
  });
  const target = attach(resources, unit(2), barrier, 21);
  const result = resolveDamage(workFor(unit(1), target), request(700), resources);

  assert.equal(result.report.hpLoss, 200);
  assert.equal(stateOf(result.work, resources, 2, barrier, 21).remainingAmount, 0);
  assert.deepEqual(result.report.resourceConsumptions, [{ ownerUnitId: 2, instanceId: 21, resource: 'barrier', amount: 500 }]);
});

test('damage pipeline: strongest grouped instance wins without multiplying or deleting suppressed instances', () => {
  const resources = new CombatResources();
  const weak = resources.registerEffect(program('weak'), {
    group: { id: 'fragile', strength: 2 }, reception: [{ priority: 0, apply: multiplyDamage(() => 2) }],
  });
  const strong = resources.registerEffect(program('strong'), {
    group: { id: 'fragile', strength: 3 }, reception: [{ priority: 0, apply: multiplyDamage(() => 3) }],
  });
  let target = attach(resources, unit(2), strong, 21, 20);
  target = attach(resources, target, weak, 22, 10);
  const result = resolveDamage(workFor(unit(1), target), request(100), resources);

  assert.equal(result.report.hpLoss, 300);
  assert.equal(getCombatUnit(result.work, 2).effects.instances.length, 2);
});

test('damage pipeline: grouped effects compete only with participants in the current parameter or reception stage', () => {
  const resources = new CombatResources();
  const attack = resources.registerEffect(program('grouped-attack'), {
    group: { id: 'shared', strength: 100 },
    attack: () => [createNumericContribution({ multiplier: 1 })],
  });
  const weak = resources.registerEffect(program('grouped-weak-reception'), {
    group: { id: 'shared', strength: 1 },
    reception: [{ priority: 0, apply: multiplyDamage(() => 2) }],
  });
  const strong = resources.registerEffect(program('grouped-strong-reception'), {
    group: { id: 'shared', strength: 2 },
    reception: [{ priority: 0, apply: multiplyDamage(() => 3) }],
  });
  let target = attach(resources, unit(2), attack, 21);
  target = attach(resources, target, weak, 22);
  target = attach(resources, target, strong, 23);
  const original = workFor(unit(1), target);
  const result = resolveDamage(original, request(100), resources);

  assert.equal(resolveAttackPower(target, original, resources), 200);
  assert.equal(result.report.hpLoss, 300);
  assert.equal(getCombatUnit(result.work, 2).effects.instances.length, 3);
});

test('damage pipeline: one group can independently provide source formula, output and report reaction', () => {
  const resources = new CombatResources();
  const formula = resources.registerEffect(program('grouped-formula'), {
    group: { id: 'shared', strength: 10 },
    sourceFormula: [{ priority: 0, apply: multiplyAttackScale(() => 2) }],
  });
  const output = resources.registerEffect(program('grouped-output'), {
    group: { id: 'shared', strength: 20 },
    output: [{ priority: 0, apply: multiplyDamage(() => 3) }],
  });
  const reaction = resources.registerEffect(program('grouped-reaction', { reports: 0 }), {
    group: { id: 'shared', strength: 30 },
    reaction: [{ priority: 0, apply: context => context.resources.updateEffectState(
      context.work, context.ownerUnitId, context.instance.id, context.instance.programRef,
      { reports: context.instance.state.reports + 1 },
    ) }],
  });
  let source = attach(resources, unit(1), formula, 11);
  source = attach(resources, source, output, 12);
  source = attach(resources, source, reaction, 13);
  const result = resolveDamage(workFor(source, unit(2)), request(100), resources);

  assert.equal(result.report.formulaDamage, 200);
  assert.equal(result.report.outputDamage, 600);
  assert.equal(result.report.hpLoss, 600);
  assert.equal(stateOf(result.work, resources, 1, reaction, 13).reports, 1);
});

test('damage pipeline: priority, acquisition sequence and stable instance order determine reception independently of insertion', () => {
  for (const [firstSequence, expected] of [[10, 900], [20, 1200]]) {
    for (const insertion of [[0, 1, 2], [2, 1, 0]]) {
      const resources = new CombatResources();
      const high = resources.registerEffect(program('high'), {
        reception: [{ priority: 1000, apply: reduceDamage(() => 50) }],
      });
      const first = resources.registerEffect(program('first'), {
        reception: [{ priority: 0, apply: reduceDamage(() => 100) }, { priority: 0, apply: multiplyDamage(() => 3) }],
      });
      const last = resources.registerEffect(program('last'), {
        reception: [{ priority: 0, apply: multiplyDamage(() => 2) }],
      });
      const entries = [[high, 23, 99], [first, 21, firstSequence], [last, 22, 10]];
      let target = unit(2);

      for (const index of insertion) {
        const [descriptor, id, sequence] = entries[index];
        target = attach(resources, target, descriptor, id, sequence);
      }

      assert.equal(resolveDamage(workFor(unit(1), target), request(300), resources).report.hpLoss, expected);
    }
  }
});

test('damage pipeline: lethal protection confirms HP 1 and reports protection without publishing removal', () => {
  const resources = new CombatResources();
  const target = unit(2, { hp: 1000, flags: ['UNDEADABLE'] });
  const result = resolveDamage(workFor(unit(1), target), request(5000), resources);

  assert.equal(getCombatUnit(result.work, 2).vitality.hp, 1);
  assert.equal(result.report.hpLoss, 999);
  assert.equal(result.report.fatalProtection, true);
  assert.equal(result.report.deathOccurred, false);
  assert.equal(result.work.removals.size, 0);
  assert.equal(combatWorkChanges(result.work).some(change => change.type === 'REMOVE_UNIT'), false);
});

test('damage pipeline: absent target reports unexecuted numerical stages rather than fabricated zero calculations', () => {
  const resources = new CombatResources();
  const result = resolveDamage(workFor(unit(1)), request(700), resources);

  assert.equal(result.report.formulaDamage, null);
  assert.equal(result.report.outputDamage, null);
  assert.equal(result.report.hpDamage, null);
  assert.equal(result.report.hpLoss, 0);
  assert.deepEqual(result.report.cancellation, { stage: 'INPUT', reason: 'TARGET_ABSENT' });
  assert.equal(result.work.events.length, 0);
  assert.equal(result.work.removals.size, 0);
});

test('damage pipeline: invincibility skips reception resources and still gives reactions a frozen cancellation report', () => {
  const resources = new CombatResources();
  const barrier = resources.registerEffect(program('barrier', { remainingAmount: 500 }), {
    reception: [{ priority: 0, apply: absorbBarrier() }],
  });
  const observer = resources.registerEffect(program('cancel-observer', {
    reports: 0, formula: 0, output: 0, hpStageComputed: 0, canceled: 0, frozen: 0,
  }), {
    output: [{ priority: 0, apply: multiplyDamage(() => 2) }],
    reaction: [{ priority: 0, apply: (context, report) => context.resources.updateEffectState(
      context.work, context.ownerUnitId, context.instance.id, context.instance.programRef,
      {
        reports: context.instance.state.reports + 1,
        formula: report.formulaDamage,
        output: report.outputDamage,
        hpStageComputed: Number(report.hpDamage !== null),
        canceled: Number(report.cancellation?.reason === 'INVINCIBLE'),
        frozen: Number(Object.isFrozen(report)),
      },
    ) }],
  });
  const source = attach(resources, unit(1), observer, 11);
  const target = attach(resources, unit(2, { flags: ['INVINCIBLE'] }), barrier, 21);
  const result = resolveDamage(workFor(source, target), request(700), resources);

  assert.equal(result.report.formulaDamage, 700);
  assert.equal(result.report.outputDamage, 1400);
  assert.equal(result.report.hpDamage, null);
  assert.equal(result.report.hpLoss, 0);
  assert.deepEqual(result.report.resourceConsumptions, []);
  assert.deepEqual(result.report.cancellation, { stage: 'RECEPTION', reason: 'INVINCIBLE' });
  assert.equal(getCombatUnit(result.work, 2).vitality.hp, 5000);
  assert.equal(stateOf(result.work, resources, 2, barrier, 21).remainingAmount, 500);
  assert.deepEqual(stateOf(result.work, resources, 1, observer, 11), {
    reports: 1, formula: 700, output: 1400, hpStageComputed: 0, canceled: 1, frozen: 1,
  });
  assert.ok(Object.isFrozen(result.report));
  assert.throws(() => { result.report.hpLoss = 1; }, TypeError);
});

test('damage pipeline: nested reaction damage and healing preserve latest HP and consumed instance state', () => {
  const resources = new CombatResources();
  const barrier = resources.registerEffect(program('source-barrier', { remainingAmount: 30 }), {
    reception: [{ priority: 0, apply: absorbBarrier() }],
  });
  const reaction = resources.registerEffect(program('once', {
    remainingCharges: 1, observedSourceHp: 0, observedTargetHp: 0,
  }), {
    reaction: [
      { priority: 100, apply: (context, report) => {
        if (context.instance.state.remainingCharges === 0 || report.request.sourceUnitId !== context.ownerUnitId) {
          return context.work;
        }
        const consumed = context.resources.updateEffectState(context.work, context.ownerUnitId, context.instance.id, context.instance.programRef, {
          ...context.instance.state, remainingCharges: 0,
        });
        const reflected = resolveDamage(consumed, request(40, {
          sourceUnitId: report.request.targetUnitId, targetUnitId: context.ownerUnitId,
        }), context.resources);

        return resolveHealing(reflected.work, {
          sourceUnitId: context.ownerUnitId, targetUnitId: report.request.targetUnitId,
          power: 10, ignoreHealFree: false,
        }, context.resources, report.request.tick).work;
      } },
      { priority: 0, apply: (context, report) => {
        if (report.request.sourceUnitId !== context.ownerUnitId) {
          return context.work;
        }

        return context.resources.updateEffectState(context.work, context.ownerUnitId, context.instance.id, context.instance.programRef, {
          ...context.instance.state,
          observedSourceHp: getCombatUnit(context.work, context.ownerUnitId).vitality.hp,
          observedTargetHp: getCombatUnit(context.work, report.request.targetUnitId).vitality.hp,
        });
      } },
    ],
  });
  let source = attach(resources, unit(1, { hp: 800, maxHp: 1000 }), barrier, 11);
  source = attach(resources, source, reaction, 12);
  const original = workFor(source, unit(2, { hp: 1000 }));
  const result = resolveDamage(original, request(100), resources);

  assert.equal(result.report.hpLoss, 100);
  assert.equal(getCombatUnit(result.work, 1).vitality.hp, 790);
  assert.equal(getCombatUnit(result.work, 2).vitality.hp, 910);
  assert.equal(stateOf(result.work, resources, 1, barrier, 11).remainingAmount, 0);
  assert.deepEqual(stateOf(result.work, resources, 1, reaction, 12), {
    remainingCharges: 0, observedSourceHp: 790, observedTargetHp: 910,
  });
  assert.deepEqual(result.work.events.map(event => [event.type, event.sourceUnitId, event.targetUnitId, event.amount]), [
    ['DAMAGE', 1, 2, 100], ['DAMAGE', 2, 1, 10], ['HEAL', 1, 2, 10],
  ]);
  assert.equal(getCombatUnit(original, 1).vitality.hp, 800);
  assert.equal(stateOf(original, resources, 1, reaction, 12).remainingCharges, 1);
});
