import { fixtureBattlefield } from "../helpers/battlefield.js";
import { liveAttack } from "../../dist/core/tactical/unit/capability/offense/contributions.js";
import { liveResistance } from "../../dist/core/tactical/unit/capability/defense/contributions.js";
import { installFixtureEffect } from "../helpers/effects.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEffectDefinition } from "../../dist/core/tactical/unit/capability/effects/definition.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import * as modifier from "../../dist/core/tactical/contribution/value.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import { resolveHealing } from "../../dist/core/tactical/unit/capability/vitality/healing/settlement.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import {
  absorbBarrier,
  composeDamageRules,
  multiplyAttackScale,
  multiplyDamage,
  reduceDamage,
  replaceAttackScale,
} from "../../dist/core/tactical/unit/capability/vitality/damage/rules.js";
import {
  battlefieldView,
  createBattleState,
  getUnit,
} from "../../dist/core/tactical/battle/execution/context.js";
import { createDefenseDefinition } from "../../dist/core/tactical/unit/capability/defense/capability.js";
import { createOffenseDefinition } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { createStatusDefinition } from "../../dist/core/tactical/unit/capability/status/capability.js";

function unit(
  id,
  { hp = 5000, maxHp = hp, attack = 100, defense = 0, resistance = 0, flags = [] } = {},
) {
  const status = createStatusDefinition({ initialFlags: flags });

  const definition = {
    id: `unit-${id}`,
    vitality: { maxHp },
    status,
    offense: createOffenseDefinition({ attack }),
    defense: createDefenseDefinition({ defense, resistance }),
  };
  const initialized = initializeUnit({ id, definition, position: [0, 0] });
  return { ...initialized, vitality: { ...initialized.vitality, hp } };
}

function workFor(...units) {
  const values = new Map(units.map((value) => [value.id, value]));

  return createBattleState(fixtureBattlefield({
    unitIds: [...values.keys()],
    getUnit: (id) => values.get(id),
    blockerOf: () => undefined,
    blockedBy: () => [],
  }));
}

function program(id, initialState = {}) {
  return createEffectDefinition({
    id,
    initialize: () => initialState,
  });
}

function attach(resources, owner, descriptor, id, acquiredSequence = id) {
  const instance = resources.effects.create(descriptor.ref, {
    id,
    acquiredSequence,
    source: null,
    scopes: [{ type: "UNIT", unitId: owner.id }],
  });

  return installFixtureEffect(owner, instance, resources);
}

function stateOf(work, resources, ownerId, descriptor, instanceId) {
  const instance = getUnit(work, ownerId).effects.instances.find(
    (value) => value.id === instanceId,
  );

  return resources.effects.typedState(instance, descriptor.ref);
}

function request(power, overrides = {}) {
  return {
    sourceUnitId: 1,
    targetUnitId: 2,
    damageType: "PHYSICAL",
    operands: createDamageOperands(power),
    tick: 12,
    ...overrides,
  };
}

test("damage pipeline: numeric contributions retain four distinct positions and clamp the direct multiplier", () => {
  const contributions = [
    modifier.create({ addition: 10, multiplier: 0.5, finalAddition: 7, finalScaler: 2 }),
    modifier.create({
      addition: 20,
      multiplier: 0.5,
      finalAddition: 3,
      finalScaler: 0.5,
    }),
  ];

  assert.equal(modifier.apply(100, contributions), 270);
  assert.equal(
    modifier.apply(100, [
      modifier.create({ multiplier: -2, finalAddition: 7, finalScaler: 2 }),
    ]),
    14,
  );
});

test("damage pipeline: low HP attack contributions read current work after damage and healing", () => {
  const resources = new CombatResources();
  const lowHp = resources.registerEffect(program("low-hp"), {
    contributions: [liveAttack(({ unit: owner, battlefield }) => {
        const current = battlefield.getUnit(owner.id);
        return current.vitality.hp < current.definition.vitality.maxHp / 2
          ? [modifier.create({ multiplier: 1 })]
          : [];
      })],
  });
  const source = attach(resources, unit(1, { hp: 750, maxHp: 1000 }), lowHp, 11);
  const original = workFor(source, unit(2));
  resolveDamage(
    original,
    request(500, { sourceUnitId: 2, targetUnitId: 1 }),
    resources,
  );
  const damagedView = original.battlefield.snapshot("draft");
  resolveHealing(
    original,
    { sourceUnitId: 2, targetUnitId: 1, power: 400, ignoreHealFree: false, tick: 12 },
    resources,
  );

  assert.equal(resolveAttackPower(source.id, battlefieldView(original), resources.computations), 100);
  assert.equal(damagedView.getUnit(1).vitality.hp, 250);
  assert.equal(resolveAttackPower(1, damagedView, resources.computations), 200);
  assert.equal(getUnit(original, 1).vitality.hp, 650);
  assert.equal(resolveAttackPower(1, battlefieldView(original), resources.computations), 100);
  assert.equal(original.battlefield.snapshot("state").getUnit(1).vitality.hp, 750);
});

test("damage pipeline: attack scale multiplication and replacement preserve their execution order", () => {
  const outcomes = [
    [multiplyAttackScale(() => 2), replaceAttackScale(() => 3), 300],
    [replaceAttackScale(() => 3), multiplyAttackScale(() => 2), 600],
  ];

  for (const [first, second, expected] of outcomes) {
    const resources = new CombatResources();
    const descriptor = resources.registerEffect(program("attack-scale"), {
      damage: {
        sourceFormula: { priority: 0, apply: composeDamageRules(first, second) },
      },
    });
    const source = attach(resources, unit(1), descriptor, 11);
    const resultState = workFor(source, unit(2));
const result = resolveDamage(resultState, request(100), resources);

    assert.equal(result.formulaDamage, expected);
    assert.equal(result.hpLoss, expected);
  }
});

test("damage pipeline: fixed penetration precedes proportional penetration for defense and resistance", () => {
  const examples = [
    { damageType: "PHYSICAL", defense: 200, resistance: 0, fixed: 100, expected: 950 },
    { damageType: "ARTS", defense: 0, resistance: 80, fixed: 10, expected: 650 },
    { damageType: "ARTS", defense: 0, resistance: 150, fixed: 10, expected: 550 },
  ];

  for (const example of examples) {
    const resources = new CombatResources();
    const resultState = workFor(unit(1), unit(2, example));
const result = resolveDamage(
      resultState,
      request(1000, {
        damageType: example.damageType,
        operands: {
          ...createDamageOperands(1000),
          fixedPenetration: example.fixed,
          proportionalPenetration: 0.5,
        },
      }),
      resources,
    );

    assert.equal(result.formulaDamage, example.expected);
  }
});

test("damage pipeline: resistance contributions are clamped before fixed and proportional penetration", () => {
  const resources = new CombatResources();
  const resistance = resources.registerEffect(program("resistance"), {
    contributions: [liveResistance(() => [modifier.create({ finalAddition: 70 })])],
  });
  const target = attach(resources, unit(2, { resistance: 80 }), resistance, 21);
  const resultState = workFor(unit(1), target);
const result = resolveDamage(
    resultState,
    request(1000, {
      damageType: "ARTS",
      operands: {
        ...createDamageOperands(1000),
        fixedPenetration: 10,
        proportionalPenetration: 0.5,
      },
    }),
    resources,
  );

  assert.equal(result.formulaDamage, 550);
  assert.equal(result.hpLoss, 550);
  assert.equal(getUnit(resultState, 2).vitality.hp, 4450);
  assert.equal(getUnit(resultState, 2).definition.defense.resistance, 80);
  assert.equal(getUnit(resultState, 2).defense.resistance, target.defense.resistance);
});

test("damage pipeline: a 500 barrier before doubling takes 400 HP, while doubling before the barrier takes 900", () => {
  for (const [barrierPriority, scalePriority, expected] of [
    [100, 0, 400],
    [0, 100, 900],
  ]) {
    const resources = new CombatResources();
    const barrier = resources.registerEffect(program("barrier", { remainingAmount: 500 }), {
      damage: {
        reception: { priority: barrierPriority, apply: absorbBarrier() },
      },
    });
    const fragile = resources.registerEffect(program("fragile"), {
      damage: {
        reception: { priority: scalePriority, apply: multiplyDamage(() => 2) },
      },
    });
    let target = attach(resources, unit(2), barrier, 21);
    target = attach(resources, target, fragile, 22);
    const resultState = workFor(unit(1), target);
const result = resolveDamage(resultState, request(700), resources);

    assert.equal(result.formulaDamage, 700);
    assert.equal(result.outputDamage, 700);
    assert.equal(result.hpDamage, expected);
    assert.equal(result.hpLoss, expected);
    assert.equal(getUnit(resultState, 2).vitality.hp, 5000 - expected);
    assert.equal(stateOf(resultState, resources, 2, barrier, 21).remainingAmount, 0);
    assert.deepEqual(result.resourceConsumptions, [
      { ownerUnitId: 2, instanceId: 21, resource: "barrier", amount: 500 },
    ]);
    assert.equal(target.effects.instances[0].state.remainingAmount, 500);
  }
});

test("damage pipeline: fixed reduction and complete barrier absorption consume resources without HP loss", () => {
  const resources = new CombatResources();
  const barrier = resources.registerEffect(program("barrier", { remainingAmount: 800 }), {
    damage: {
      reception: { priority: 0, apply: absorbBarrier() },
    },
  });
  const reduction = resources.registerEffect(program("reduction"), {
    damage: {
      reception: { priority: 100, apply: reduceDamage(() => 100) },
    },
  });
  let target = attach(resources, unit(2), barrier, 21);
  target = attach(resources, target, reduction, 22);
  const resultState = workFor(unit(1), target);
const result = resolveDamage(resultState, request(700), resources);

  assert.equal(result.hpDamage, 0);
  assert.equal(result.hpLoss, 0);
  assert.equal(result.cancellation, null);
  assert.equal(result.resourceConsumptions[0].amount, 600);
  assert.equal(stateOf(resultState, resources, 2, barrier, 21).remainingAmount, 200);
  assert.equal(getUnit(resultState, 2).vitality.hp, 5000);
  assert.notEqual(getUnit(resultState, 2), target);
  assert.equal(resultState.battlefield.snapshot("state").getUnit(2), target);
});

test("damage pipeline: consecutive reception rules read the same instance after its previous consumption", () => {
  const resources = new CombatResources();
  const barrier = resources.registerEffect(program("barrier", { remainingAmount: 500 }), {
    damage: {
      reception: { priority: 0, apply: composeDamageRules(absorbBarrier(), absorbBarrier()) },
    },
  });
  const target = attach(resources, unit(2), barrier, 21);
  const resultState = workFor(unit(1), target);
const result = resolveDamage(resultState, request(700), resources);

  assert.equal(result.hpLoss, 200);
  assert.equal(stateOf(resultState, resources, 2, barrier, 21).remainingAmount, 0);
  assert.deepEqual(result.resourceConsumptions, [
    { ownerUnitId: 2, instanceId: 21, resource: "barrier", amount: 500 },
  ]);
});

test("damage pipeline: strongest grouped instance wins without multiplying or deleting suppressed instances", () => {
  const resources = new CombatResources();
  const weak = resources.registerEffect(program("weak"), {
    damage: {
      group: { id: "fragile", strength: 2 },
      reception: { priority: 0, apply: multiplyDamage(() => 2) },
    },
  });
  const strong = resources.registerEffect(program("strong"), {
    damage: {
      group: { id: "fragile", strength: 3 },
      reception: { priority: 0, apply: multiplyDamage(() => 3) },
    },
  });
  let target = attach(resources, unit(2), weak, 21, 10);
  target = attach(resources, target, strong, 22, 20);
  const resultState = workFor(unit(1), target);
const result = resolveDamage(resultState, request(100), resources);

  assert.equal(result.hpLoss, 300);
  assert.equal(getUnit(resultState, 2).effects.instances.length, 2);
});

test("damage pipeline: grouped effects compete only with participants in the current parameter or reception stage", () => {
  const resources = new CombatResources();
  const attack = resources.registerEffect(program("grouped-attack"), {
    contributions: [liveAttack(() => [modifier.create({ multiplier: 1 })], { group: { id: "shared", strength: 100 } })],
  });
  const weak = resources.registerEffect(program("grouped-weak-reception"), {
    damage: {
      group: { id: "shared", strength: 1 },
      reception: { priority: 0, apply: multiplyDamage(() => 2) },
    },
  });
  const strong = resources.registerEffect(program("grouped-strong-reception"), {
    damage: {
      group: { id: "shared", strength: 2 },
      reception: { priority: 0, apply: multiplyDamage(() => 3) },
    },
  });
  let target = attach(resources, unit(2), attack, 21);
  target = attach(resources, target, weak, 22);
  target = attach(resources, target, strong, 23);
  const original = workFor(unit(1), target);
  const result = resolveDamage(original, request(100), resources);

  assert.equal(resolveAttackPower(target.id, battlefieldView(original), resources.computations), 200);
  assert.equal(result.hpLoss, 300);
  assert.equal(getUnit(original, 2).effects.instances.length, 3);
});

test("damage pipeline: one group can independently provide source formula, output and report reaction", () => {
  const resources = new CombatResources();
  const reactions = [];
  const formula = resources.registerEffect(program("grouped-formula"), {
    damage: {
      group: { id: "shared", strength: 10 },
      sourceFormula: { priority: 0, apply: multiplyAttackScale(() => 2) },
    },
  });
  const output = resources.registerEffect(program("grouped-output"), {
    damage: {
      group: { id: "shared", strength: 20 },
      output: { priority: 0, apply: multiplyDamage(() => 3) },
    },
  });
  const reaction = resources.registerEffect(program("grouped-reaction", { reports: 0 }), {
    damage: {
      group: { id: "shared", strength: 30 },
      reaction: {
        priority: 0,
        apply: (context) => {
          context.operations.effects.update(
            context.ref,
            context.instance.definitionRef,
            (state) => ({ reports: state.reports + 1 }),
          );
          reactions.push("source");
        },
      },
    },
  });
  const targetReaction = resources.registerEffect(program("target-reaction"), {
    damage: {
      reaction: {
        priority: 1000,
        apply: () => {
          reactions.push("target");
        },
      },
    },
  });
  let source = attach(resources, unit(1), formula, 11);
  source = attach(resources, source, output, 12);
  source = attach(resources, source, reaction, 13);
  const target = attach(resources, unit(2), targetReaction, 21);
  const resultState = workFor(source, target);
const result = resolveDamage(resultState, request(100), resources);

  assert.equal(result.formulaDamage, 200);
  assert.equal(result.outputDamage, 600);
  assert.equal(result.hpLoss, 600);
  assert.equal(stateOf(resultState, resources, 1, reaction, 13).reports, 1);
  assert.deepEqual(reactions, ["source", "target"]);
  reactions.length = 0;
  resolveDamage(resultState, request(100, { targetUnitId: 1 }), resources);
  assert.deepEqual(reactions, ["source"]);
  assert.equal(stateOf(resultState, resources, 1, reaction, 13).reports, 2);
});

test("damage pipeline: priority, acquisition sequence and stable instance order determine reception independently of insertion", () => {
  for (const [firstSequence, expected] of [
    [10, 900],
    [20, 1200],
  ]) {
    for (const insertion of [
      [0, 1, 2],
      [2, 1, 0],
    ]) {
      const resources = new CombatResources();
      const high = resources.registerEffect(program("high"), {
        damage: {
          reception: { priority: 1000, apply: reduceDamage(() => 50) },
        },
      });
      const first = resources.registerEffect(program("first"), {
        damage: {
          reception: {
            priority: 0,
            apply: composeDamageRules(
              reduceDamage(() => 100),
              multiplyDamage(() => 3),
            ),
          },
        },
      });
      const last = resources.registerEffect(program("last"), {
        damage: {
          reception: { priority: 0, apply: multiplyDamage(() => 2) },
        },
      });
      const entries = [
        [high, 99],
        [first, firstSequence],
        [last, firstSequence === 10 ? 11 : 10],
      ];
      const chronological = [...entries].sort((left, right) => left[1] - right[1]);
      let target = unit(2);

      for (const [id, [descriptor, sequence]] of chronological.entries()) {
        target = attach(resources, target, descriptor, id, sequence);
      }
      target = {
        ...target,
        effects: {
          ...target.effects,
          instances: insertion.map((index) =>
            target.effects.instances.find(
              (instance) => instance.definitionRef === entries[index][0].ref,
            ),
          ),
        },
      };

      assert.equal(
        resolveDamage(workFor(unit(1), target), request(300), resources).hpLoss,
        expected,
      );
    }
  }
});

test("damage pipeline: lethal protection confirms HP 1 and reports protection without publishing removal", () => {
  const resources = new CombatResources();
  const target = unit(2, { hp: 1000, flags: ["UNDEADABLE"] });
  const resultState = workFor(unit(1), target);
const result = resolveDamage(resultState, request(5000), resources);

  assert.equal(getUnit(resultState, 2).vitality.hp, 1);
  assert.equal(result.hpLoss, 999);
  assert.equal(result.fatalProtection, true);
  assert.equal(result.deathOccurred, false);
  assert.equal(resultState.removedUnits.length, 0);
  assert.deepEqual(resultState.removedUnits, []);
});

test("damage pipeline: absent target reports unexecuted numerical stages rather than fabricated zero calculations", () => {
  const resources = new CombatResources();
  const resultState = workFor(unit(1));
const result = resolveDamage(resultState, request(700), resources);

  assert.equal(result.formulaDamage, null);
  assert.equal(result.outputDamage, null);
  assert.equal(result.hpDamage, null);
  assert.equal(result.hpLoss, 0);
  assert.deepEqual(result.cancellation, { stage: "INPUT", reason: "TARGET_ABSENT" });
  assert.equal(resultState.events.length, 0);
  assert.equal(resultState.removedUnits.length, 0);
});

test("damage pipeline: invincibility skips reception resources and still gives reactions a frozen cancellation report", () => {
  const resources = new CombatResources();
  const barrier = resources.registerEffect(
    program("barrier", { remainingAmount: 500, rejected: 0 }),
    {
      damage: {
        reception: {
          priority: 0,
          apply: (context, pending) => {
            context.operations.effects.update(
              context.ref,
              context.instance.definitionRef,
              (state) => ({
                ...state,
                rejected: state.rejected + Number(pending.cancellation?.reason === "INVINCIBLE"),
              }),
            );
            return absorbBarrier()(context, pending);
          },
        },
      },
    },
  );
  const observer = resources.registerEffect(
    program("cancel-observer", {
      reports: 0,
      formula: 0,
      output: 0,
      hpStageComputed: 0,
      canceled: 0,
      frozen: 0,
    }),
    {
      damage: {
        output: { priority: 0, apply: multiplyDamage(() => 2) },
        reaction: {
          priority: 0,
          apply: (context, report) => {
            context.operations.effects.update(
              context.ref,
              context.instance.definitionRef,
              (state) => ({
                reports: state.reports + 1,
                formula: report.formulaDamage,
                output: report.outputDamage,
                hpStageComputed: Number(report.hpDamage !== null),
                canceled: Number(report.cancellation?.reason === "INVINCIBLE"),
                frozen: Number(Object.isFrozen(report)),
              }),
            );
          },
        },
      },
    },
  );
  const source = attach(resources, unit(1), observer, 11);
  const target = attach(resources, unit(2, { flags: ["INVINCIBLE"] }), barrier, 21);
  const resultState = workFor(source, target);
const result = resolveDamage(resultState, request(700), resources);

  assert.equal(result.formulaDamage, 700);
  assert.equal(result.outputDamage, 1400);
  assert.equal(result.hpDamage, null);
  assert.equal(result.hpLoss, 0);
  assert.deepEqual(result.resourceConsumptions, []);
  assert.deepEqual(result.cancellation, { stage: "RECEPTION", reason: "INVINCIBLE" });
  assert.equal(getUnit(resultState, 2).vitality.hp, 5000);
  assert.equal(stateOf(resultState, resources, 2, barrier, 21).remainingAmount, 500);
  assert.equal(stateOf(resultState, resources, 2, barrier, 21).rejected, 1);
  assert.deepEqual(stateOf(resultState, resources, 1, observer, 11), {
    reports: 1,
    formula: 700,
    output: 1400,
    hpStageComputed: 0,
    canceled: 1,
    frozen: 1,
  });
  assert.ok(Object.isFrozen(result));
  assert.throws(() => {
    result.hpLoss = 1;
  }, TypeError);
});

test("damage pipeline: nested reaction damage and healing preserve latest HP and consumed instance state", () => {
  const resources = new CombatResources();
  const barrier = resources.registerEffect(program("source-barrier", { remainingAmount: 30 }), {
    damage: {
      reception: { priority: 0, apply: absorbBarrier() },
    },
  });
  const reaction = resources.registerEffect(
    program("once", {
      remainingCharges: 1,
      observedSourceHp: 0,
      observedTargetHp: 0,
    }),
    {
      damage: {
        reaction: {
          priority: 100,
          apply: (context, report) => {
            if (report.request.sourceUnitId !== context.ownerUnitId) {
              return;
            }
            if (context.instance.state.remainingCharges > 0) {
              context.operations.effects.update(
                context.ref,
                context.instance.definitionRef,
                (state) => ({
                  ...state,
                  remainingCharges: 0,
                }),
              );
              context.operations.damage(
                request(40, {
                  sourceUnitId: report.request.targetUnitId,
                  targetUnitId: context.ownerUnitId,
                }),
              );
              context.operations.heal({
                sourceUnitId: context.ownerUnitId,
                targetUnitId: report.request.targetUnitId,
                power: 10,
                ignoreHealFree: false,
              });
            }
            context.operations.effects.update(
              context.ref,
              context.instance.definitionRef,
              (state) => ({
                ...state,
                observedSourceHp: context.facts.getUnit(context.ownerUnitId).vitality.hp,
                observedTargetHp: context.facts.getUnit(report.request.targetUnitId).vitality.hp,
              }),
            );
          },
        },
      },
    },
  );
  let source = attach(resources, unit(1, { hp: 800, maxHp: 1000 }), barrier, 11);
  source = attach(resources, source, reaction, 12);
  const original = workFor(source, unit(2, { hp: 1000 }));
  const result = resolveDamage(original, request(100), resources);

  assert.equal(result.hpLoss, 100);
  assert.equal(getUnit(original, 1).vitality.hp, 790);
  assert.equal(getUnit(original, 2).vitality.hp, 910);
  assert.equal(stateOf(original, resources, 1, barrier, 11).remainingAmount, 0);
  assert.deepEqual(stateOf(original, resources, 1, reaction, 12), {
    remainingCharges: 0,
    observedSourceHp: 790,
    observedTargetHp: 910,
  });
  assert.deepEqual(
    original.events.map((event) => [
      event.type,
      event.sourceUnitId,
      event.targetUnitId,
      event.amount,
    ]),
    [
      ["DAMAGE", 1, 2, 100],
      ["DAMAGE", 2, 1, 10],
      ["HEAL", 1, 2, 10],
    ],
  );
  assert.equal(original.battlefield.snapshot("state").getUnit(1).vitality.hp, 800);
  assert.equal(original.battlefield.snapshot("state").getUnit(1).effects.instances.find(instance => instance.id === 12).state.remainingCharges, 1);
});
