import assert from "node:assert/strict";
import { test } from "node:test";
import { effectFixtureWork, installFixtureEffect } from "../helpers/effects.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { createBattleState, getUnit } from "../../dist/core/tactical/battle/execution/context.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import {
  damageUnit,
  resolveDamage,
} from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import {
  healUnit,
  resolveHealing,
} from "../../dist/core/tactical/unit/capability/vitality/healing/settlement.js";

function unit(id, flags = []) {
  const initialized = initializeUnit({
    id,
    position: [0, 0],
    definition: {
      id: `settlement-${id}`,
      vitality: { maxHp: 1000 },
      defense: { defense: 0, resistance: 0 },
      status: { initialFlags: flags },
    },
  });

  return { ...initialized, vitality: { ...initialized.vitality, hp: 200 } };
}

function program(id) {
  return createEffectProgram({
    id,
    initialize: () => ({ uses: 0 }),
    ownState: (value) => ({ ...value }),
  });
}

function attach(resources, owner, descriptor) {
  const instance = resources.effects.create(descriptor.ref, {
    id: owner.effects?.nextInstanceId ?? 0,
    acquiredSequence: owner.effects?.nextAcquiredSequence ?? 0,
    source: null,
    scopes: [],
  });

  return installFixtureEffect(owner, instance, resources);
}

function damageRequest(power = 40) {
  return {
    sourceUnitId: 1,
    targetUnitId: 2,
    damageType: "TRUE",
    operands: createDamageOperands(power),
    tick: 1,
  };
}

function healingRequest(power = 40) {
  return { sourceUnitId: 1, targetUnitId: 2, power, ignoreHealFree: true };
}

test("settlement invariants: invalid final damage leaves the published battlefield intact and permits discarding the draft", () => {
  for (const invalid of [-1, NaN, Infinity]) {
    const resources = new CombatResources();
    let malformed = true;
    let reactions = 0;
    const descriptor = resources.registerEffect(program("invalid-damage"), {
      damage: {
        reception: {
          priority: 0,
          apply: (context, pending) => {
            context.operations.effects.update(context.ref, descriptor.ref, (current) => ({
              ...current,
              uses: current.uses + 1,
            }));
            context.operations.heal(healingRequest(10));

            return { value: { ...pending, amount: malformed ? invalid : 30 } };
          },
        },
        reaction: {
          priority: 0,
          apply: () => {
            reactions += 1;
          },
        },
      },
    });
    const target = attach(resources, unit(2), descriptor);
    const original = effectFixtureWork(unit(1), target);

    assert.throws(() => resolveDamage(original, damageRequest(), resources), RangeError);
    assert.equal(original.battlefield.snapshot("state").getUnit(2).vitality.hp, 200);
    assert.equal(original.battlefield.snapshot("state").getUnit(2).effects.instances[0].state.uses, 0);
    original.battlefield.drop();
    assert.equal(getUnit(original, 2).vitality.hp, 200);
    assert.equal(reactions, 0);

    malformed = false;
    const validState = createBattleState(original.battlefield);
    const valid = resolveDamage(validState, damageRequest(), resources);
    assert.equal(getUnit(validState, 2).vitality.hp, 180);
    assert.equal(getUnit(validState, 2).effects.instances[0].state.uses, 1);
    assert.equal(valid.hpLoss, 30);
    assert.equal(reactions, 1);
  }
});

test("settlement invariants: invalid final healing rejects after synchronous damage and the operation draft can be discarded", () => {
  for (const invalid of [-1, NaN, Infinity]) {
    const resources = new CombatResources();
    let malformed = true;
    let reactions = 0;
    const descriptor = resources.registerEffect(program("invalid-healing"), {
      healing: {
        reception: {
          priority: 0,
          apply: (context, pending) => {
            context.operations.effects.update(context.ref, descriptor.ref, (current) => ({
              ...current,
              uses: current.uses + 1,
            }));
            context.operations.damage(damageRequest(10));

            return { value: { ...pending, amount: malformed ? invalid : 30 } };
          },
        },
        reaction: {
          priority: 0,
          apply: () => {
            reactions += 1;
          },
        },
      },
    });
    const target = attach(resources, unit(2), descriptor);
    const original = effectFixtureWork(unit(1), target);

    assert.throws(() => resolveHealing(original, { ...healingRequest(), tick: 1 }, resources), RangeError);
    assert.equal(original.battlefield.snapshot("state").getUnit(2).vitality.hp, 200);
    assert.equal(original.battlefield.snapshot("state").getUnit(2).effects.instances[0].state.uses, 0);
    original.battlefield.drop();
    assert.equal(getUnit(original, 2).vitality.hp, 200);
    assert.equal(reactions, 0);

    malformed = false;
    const validState = createBattleState(original.battlefield);
    const valid = resolveHealing(validState, { ...healingRequest(), tick: 1 }, resources);
    assert.equal(getUnit(validState, 2).vitality.hp, 220);
    assert.equal(getUnit(validState, 2).effects.instances[0].state.uses, 1);
    assert.equal(valid.amount, 30);
    assert.equal(reactions, 1);
  }
});

test("settlement invariants: cancelled damage cannot publish nonfinite formula or output values", () => {
  for (const stage of ["sourceFormula", "output", "reception"]) {
    for (const invalid of [NaN, Infinity]) {
      const resources = new CombatResources();
      let reactions = 0;
      let repaired = false;
      const bad = resources.registerEffect(program("nonfinite-report"), {
        damage: {
          [stage]: {
            priority: 100,
            apply: (context, value) => ({
              value:
                stage === "sourceFormula"
                  ? { ...value, power: invalid }
                  : {
                      ...value,
                      amount: invalid,
                      cancellation: { stage: "RECEPTION", reason: "BLOCKED" },
                    },
            }),
          },
          reaction: {
            priority: 0,
            apply: () => {
              reactions += 1;
            },
          },
        },
      });
      const repair = resources.registerEffect(program("repair-after-output"), {
        damage: {
          reception: {
            priority: 0,
            apply: (context, pending) => {
              repaired = true;

              return { value: { ...pending, amount: 0 } };
            },
          },
        },
      });
      let source = unit(1);
      let target = unit(2);

      if (stage === "reception") {
        target = attach(resources, target, bad);
      } else {
        source = attach(resources, source, bad);
        target = attach(resources, target, repair);
      }

      const original = effectFixtureWork(source, target);
      assert.throws(() => resolveDamage(original, damageRequest(), resources), RangeError);
      assert.equal(getUnit(original, 2).vitality.hp, 200);
      assert.deepEqual(original.events, []);
      assert.equal(reactions, 0);
      assert.equal(repaired, false);
    }
  }
});

test("settlement invariants: signed intermediate modifiers can resolve to valid final amounts", () => {
  const resources = new CombatResources();
  const output = resources.registerEffect(program("signed-output"), {
    damage: {
      output: {
        priority: 0,
        apply: (context, pending) => ({ value: { ...pending, amount: -40 } }),
      },
    },
  });
  const signed = resources.registerEffect(program("signed-reception"), {
    damage: {
      reception: {
        priority: 100,
        apply: (context, pending) => ({ value: { ...pending, amount: -20 } }),
      },
    },
    healing: {
      reception: {
        priority: 100,
        apply: (context, pending) => ({ value: { ...pending, amount: -20 } }),
      },
    },
  });
  const restored = resources.registerEffect(program("restored-reception"), {
    damage: {
      reception: {
        priority: 0,
        apply: (context, pending) => ({ value: { ...pending, amount: 30 } }),
      },
    },
    healing: {
      reception: {
        priority: 0,
        apply: (context, pending) => ({ value: { ...pending, amount: 30 } }),
      },
    },
  });
  const source = attach(resources, unit(1), output);
  let target = attach(resources, unit(2), signed);
  target = attach(resources, target, restored);
  const original = effectFixtureWork(source, target);
  const damaged = resolveDamage(original, damageRequest(), resources);
  const healedState = effectFixtureWork(source, target);
  const healed = resolveHealing(healedState, { ...healingRequest(), tick: 1 }, resources);

  assert.equal(damaged.outputDamage, -40);
  assert.equal(damaged.hpDamage, 30);
  assert.equal(getUnit(original, 2).vitality.hp, 170);
  assert.equal(healed.amount, 30);
  assert.equal(getUnit(healedState, 2).vitality.hp, 230);
});

test("settlement invariants: zero amounts stay valid and source healing normalization is preserved", () => {
  const resources = new CombatResources();
  const original = effectFixtureWork(unit(1), unit(2));
  const damaged = resolveDamage(original, damageRequest(0), resources);
  const healed = resolveHealing(original, { ...healingRequest(0), tick: 1 }, resources);
  const normalized = resolveHealing(original, { ...healingRequest(-10), tick: 1 }, resources);

  assert.equal(damaged.hpDamage, 0);
  assert.equal(damaged.hpLoss, 0);
  assert.equal(healed.amount, 0);
  assert.equal(normalized.amount, 0);
  assert.equal(getUnit(original, 2).vitality.hp, 200);
  assert.equal(damageUnit(unit(2), 0, "TRUE").amount, 0);
  assert.equal(healUnit(unit(2), 0).amount, 0);

  for (const invalid of [NaN, Infinity]) {
    assert.throws(
      () => resolveHealing(original, { ...healingRequest(invalid), tick: 1 }, resources),
      RangeError,
    );
  }
});

test("settlement invariants: cancelled healing still rejects a nonfinite final hook amount", () => {
  const resources = new CombatResources();
  const descriptor = resources.registerEffect(program("invalid-cancelled-healing"), {
    healing: {
      reception: {
        priority: 0,
        apply: (context, pending) => ({
          value: { ...pending, amount: NaN, cancellation: { reason: "BLOCKED" } },
        }),
      },
    },
  });
  const original = effectFixtureWork(unit(1), attach(resources, unit(2), descriptor));

  assert.throws(() => resolveHealing(original, { ...healingRequest(), tick: 1 }, resources), RangeError);
  assert.equal(getUnit(original, 2).vitality.hp, 200);
  assert.deepEqual(original.events, []);
});

test("settlement invariants: public vitality transitions cannot bypass amount validation", () => {
  for (const target of [unit(2), unit(2, ["INVINCIBLE", "HEAL_FREE"])]) {
    for (const invalid of [-1, NaN, Infinity, -Infinity]) {
      assert.throws(() => damageUnit(target, invalid, "TRUE"), RangeError);
      assert.throws(() => healUnit(target, invalid), RangeError);
      assert.throws(() => healUnit(target, 10, true, invalid), RangeError);
      assert.equal(target.vitality.hp, 200);
    }
  }
});
