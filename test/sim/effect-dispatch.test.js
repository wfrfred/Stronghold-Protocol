import { maxHp } from "../../dist/core/tactical/unit/capability/vitality/contributions.js";
import { combatWorkEvents } from "../../dist/core/tactical/battle/execution/work.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { effectFixtureWork, installFixtureEffect } from "../helpers/effects.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import * as modifier from "../../dist/core/tactical/modifier/value.js";
import { resolveMaxHp } from "../../dist/core/tactical/unit/capability/vitality/query.js";
import { combatWorkView, getCombatUnit } from "../../dist/core/tactical/battle/execution/work.js";
import { compileStatusBinding } from "../../dist/core/tactical/unit/capability/status/binding.js";
import { hasStatusFlag } from "../../dist/core/tactical/unit/capability/status/capability.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { EffectDispatchScope } from "../../dist/core/tactical/unit/capability/effects/dispatch.js";
import { setEffectEnabled } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import { readArknightsHealingRequest } from "../../dist/data/arknights/healing.js";
import { resolveHealing } from "../../dist/core/tactical/unit/capability/vitality/healing/settlement.js";

function unit(id, hp = 1000, flags = []) {
  const initialized = initializeUnit({
    id,
    position: [0, 0],
    definition: {
      id: `dispatch-unit-${id}`,
      vitality: { maxHp: 1000 },
      defense: { defense: 0, resistance: 0 },
      status: { initialFlags: flags },
    },
  });

  return { ...initialized, vitality: { ...initialized.vitality, hp } };
}

function program(id, state = {}) {
  return createEffectProgram({
    id,
    initialize: () => state,
    ownState: (value) => ({ ...value }),
  });
}

function attach(resources, owner, descriptor) {
  const id = owner.effects?.nextInstanceId ?? 0;
  const acquiredSequence = owner.effects?.nextAcquiredSequence ?? 0;
  const instance = resources.effects.create(descriptor.ref, {
    id,
    acquiredSequence,
    source: null,
    scope: { type: "UNIT", unitId: owner.id },
    expiresAtTick: null,
  });

  return installFixtureEffect(owner, instance, resources);
}

function request(power = 100, overrides = {}) {
  return {
    sourceUnitId: null,
    targetUnitId: 2,
    damageType: "TRUE",
    operands: createDamageOperands(power),
    tick: 1,
    ...overrides,
  };
}

function installation(unitId) {
  return { source: null, scope: { type: "UNIT", unitId }, expiresAtTick: null };
}

test("effect dispatch: registered candidate identities freeze while current participation is rechecked", () => {
  for (const operation of ["enable", "finish"]) {
    const resources = new CombatResources();
    const seen = [];
    const b = resources.registerEffect(program("B"), {
      damage: {
        reception: {
          priority: 0,
          apply: (context, pending) => {
            seen.push("B");
            return { value: { ...pending, amount: pending.amount * 2 } };
          },
        },
      },
    });
    const a = resources.registerEffect(program("A"), {
      damage: {
        reception: {
          priority: 100,
          apply: (context, pending) => {
            seen.push("A");
            const address = { unitId: 2, instanceId: 1 };
            if (operation === "enable") {
              context.operations.effects.setEnabled(address, true);
            } else {
              context.operations.effects.finish(address);
            }
            return { value: pending };
          },
        },
      },
    });
    let target = attach(resources, unit(2), a);
    target = attach(resources, target, b);
    let work = effectFixtureWork(target);
    if (operation === "enable") {
      work = setEffectEnabled(work, { unitId: 2, instanceId: 1 }, false, resources, 0);
    }
    const result = resolveDamage(work, request(), resources);

    assert.deepEqual(seen, operation === "enable" ? ["A", "B"] : ["A"]);
    assert.equal(result.report.hpLoss, operation === "enable" ? 200 : 100);
  }
});

test("effect dispatch: nested finalization preserves the entered callback continuation and its latest samples", () => {
  const resources = new CombatResources();
  const observed = [];
  const descriptor = resources.registerEffect(program("self-ending", { count: 0 }), {
    damage: {
      reception: {
        priority: 0,
        apply: (context, pending) => {
          if (context.request.operands.power === 1) {
            context.operations.effects.update(
              context.address,
              context.instance.programRef,
              (state) => ({ count: state.count + 1 }),
            );
            context.operations.effects.finish(context.address);
            return {
              value: {
                ...pending,
                amount: 0,
                cancellation: { stage: "RECEPTION", reason: "NESTED_FINISH" },
              },
            };
          }
          const nested = context.operations.damage(request(1));
          assert.equal(context.facts.getEffect(context.address), undefined);
          const healing = context.operations.heal({
            sourceUnitId: null,
            targetUnitId: 2,
            power: 20,
            ignoreHealFree: true,
          });
          observed.push([
            context.instance.finished,
            context.instance.participating,
            context.instance.state.count,
            nested.hpLoss,
            healing.amount,
          ]);
          return { value: { ...pending, amount: pending.amount / 2 } };
        },
      },
    },
  });
  const result = resolveDamage(
    effectFixtureWork(attach(resources, unit(2, 500), descriptor)),
    request(),
    resources,
  );

  assert.deepEqual(observed, [[true, false, 1, 0, 20]]);
  assert.equal(result.report.hpLoss, 50);
  assert.equal(getCombatUnit(result.work, 2).vitality.hp, 470);
  assert.deepEqual(getCombatUnit(result.work, 2).effects.instances, []);
});

test("effect dispatch: healing retains selected rules while nested candidates and current eligibility stay consistent", () => {
  for (const operation of ["enable", "finish"]) {
    const resources = new CombatResources();
    const calls = [];
    const added = resources.registerEffect(program("added-healing"), {
      healing: {
        reception: {
          priority: -1,
          apply: (context, pending) => {
            calls.push(["added", context.request.power]);
            return { value: { ...pending, amount: pending.amount + 5 } };
          },
        },
      },
    });
    const follower = resources.registerEffect(program("following-healing", { calls: 0 }), {
      healing: {
        reception: {
          priority: 0,
          apply: (context, pending) => {
            calls.push(["follower", context.request.power, context.instance.state.calls]);
            context.operations.effects.update(context.address, follower.ref, (state) => ({
              calls: state.calls + 1,
            }));
            return { value: { ...pending, amount: pending.amount * 2 } };
          },
        },
      },
    });
    const first = resources.registerEffect(program("first-healing"), {
      healing: {
        reception: {
          priority: 100,
          apply: (context, pending) => {
            calls.push(["first", context.request.power]);
            if (context.request.power === 10) {
              const address = { unitId: 2, instanceId: 1 };
              if (operation === "enable") {
                context.operations.effects.setEnabled(address, true);
              } else {
                context.operations.effects.finish(address);
              }
              context.operations.effects.install(2, added.ref, installation(2));
              context.operations.heal({ sourceUnitId: null, targetUnitId: 2, power: 1 });
            }
            return { value: pending };
          },
        },
      },
    });
    let target = attach(resources, unit(2, 500), first);
    target = attach(resources, target, follower);
    let work = effectFixtureWork(target);
    if (operation === "enable") {
      work = setEffectEnabled(work, { unitId: 2, instanceId: 1 }, false, resources, 0);
    }
    const lookups = [];
    const services = {
      ...resources,
      healing: {
        get: instance => {
          lookups.push(instance.id);
          return resources.healing.get(instance);
        },
      },
    };
    const healed = resolveHealing(work, {
      sourceUnitId: null, targetUnitId: 2, power: 10,
    }, services, 1);

    assert.deepEqual(calls, operation === "enable"
      ? [["first", 10], ["first", 1], ["follower", 1, 0], ["follower", 10, 1]]
      : [["first", 10], ["first", 1]]);
    assert.deepEqual(lookups, operation === "enable" ? [0, 1, 0, 1, 2] : [0, 1, 0, 2]);
    assert.equal(healed.amount, operation === "enable" ? 20 : 10);
    assert.equal(getCombatUnit(healed.work, 2).vitality.hp, operation === "enable" ? 522 : 511);
    calls.length = 0;
    const subsequent = resolveHealing(healed.work, {
      sourceUnitId: null, targetUnitId: 2, power: 1,
    }, resources, 2);

    assert.deepEqual(calls, operation === "enable"
      ? [["first", 1], ["follower", 1, 2], ["added", 1]]
      : [["first", 1], ["added", 1]]);
    assert.equal(subsequent.amount, operation === "enable" ? 7 : 6);
    assert.equal(getCombatUnit(work, 2).vitality.hp, 500);
  }
});

test("effect dispatch: ordinary facts see new participating UIDs while current and nested dispatch candidates stay frozen", () => {
  const resources = new CombatResources();
  const calls = [];
  const c = resources.registerEffect(program("new-C"), {
    damage: {
      output: {
        priority: 0,
        apply: (context, pending) => {
          calls.push("C-output");
          return { value: pending };
        },
      },
      reception: {
        priority: 0,
        apply: (context, pending) => {
          calls.push("C-reception");
          return { value: pending };
        },
      },
    },
  });
  const d = resources.registerEffect(program("new-D"), {
    damage: {
      reception: {
        priority: 0,
        apply: (context, pending) => {
          calls.push("D-reception");
          return { value: pending };
        },
      },
    },
  });
  const a = resources.registerEffect(program("A", { entered: false }), {
    damage: {
      reception: {
        priority: 100,
        apply: (context, pending) => {
          if (context.instance.state.entered) {
            return { value: pending };
          }
          context.operations.effects.update(context.address, context.instance.programRef, () => ({
            entered: true,
          }));
          const installed = context.operations.effects.install(2, c.ref, installation(2));
          context.operations.effects.install(3, d.ref, installation(3));
          assert.equal(installed.type, "INSTALLED");
          assert.equal(context.facts.getEffect(installed.address).programRef.id, "new-C");
          assert.equal(context.facts.getUnit(2).effects.instances.length, 2);
          assert.equal(
            context.facts.participating(2).some((instance) => instance.programRef.id === "new-C"),
            true,
          );
          context.operations.damage(request(1, { sourceUnitId: 2, targetUnitId: 3 }));
          context.operations.damage(request(1));
          return { value: pending };
        },
      },
    },
  });
  const initial = effectFixtureWork(attach(resources, unit(2), a), unit(3));
  const result = resolveDamage(initial, request(10), resources);

  assert.deepEqual(calls, ["D-reception"]);
  assert.equal(getCombatUnit(result.work, 2).vitality.hp, 989);
  assert.equal(getCombatUnit(result.work, 3).vitality.hp, 999);
  resolveDamage(result.work, request(1), resources);
  assert.deepEqual(calls, ["D-reception", "C-reception"]);
});

test("effect dispatch: exceptional exits release candidates before retry on the same execution scope", () => {
  const resources = new CombatResources();
  const scope = new EffectDispatchScope();
  let fail = true;
  const descriptor = resources.registerEffect(program("fails-once", { attempts: 0 }), {
    damage: {
      reception: {
        priority: 0,
        apply: (context, pending) => {
          context.operations.effects.update(
            context.address,
            context.instance.programRef,
            (state) => ({ attempts: state.attempts + 1 }),
          );
          if (fail) {
            throw new Error("dispatch failed");
          }
          return { value: pending };
        },
      },
    },
  });
  const owner = attach(resources, unit(2), descriptor);
  const original = effectFixtureWork(owner);
  assert.throws(() => resolveDamage(original, request(), resources, scope), /dispatch failed/);
  assert.equal(getCombatUnit(original, 2).effects.instances[0].state.attempts, 0);
  fail = false;
  const later = resources.registerEffect(program("after-exception"), {
    damage: {
      reception: {
        priority: 0,
        apply: (context, pending) => ({
          value: { ...pending, amount: pending.amount * 2 },
        }),
      },
    },
  });
  const retry = resolveDamage(
    effectFixtureWork(attach(resources, owner, later)),
    request(),
    resources,
    scope,
  );

  assert.equal(retry.report.hpLoss, 200);
  assert.equal(getCombatUnit(retry.work, 2).effects.instances[0].state.attempts, 1);
  const address = { unitId: 2, instanceId: 0 };
  const initialInstance = owner.effects.instances[0];
  let exitedReader;
  assert.throws(
    () =>
      scope.withInstance(address, initialInstance, (reader) => {
        exitedReader = reader;
        throw new Error("instance frame failed");
      }),
    /instance frame failed/,
  );
  const finalized = resources.effects.restore(initialInstance.programRef, {
    ...initialInstance,
    state: { attempts: 99 },
    participating: false,
    finished: true,
  });
  scope.retainFinalizedInstance(address, finalized);
  assert.equal(exitedReader(), initialInstance);
});

test("effect dispatch: Damage and Healing borrowed facts and operations close after every callback exit", () => {
  for (const domain of ["damage", "healing"]) {
    for (const fails of [false, true]) {
      const resources = new CombatResources();
      let escaped;
      const descriptor = resources.registerEffect(program("borrowed", { calls: 0 }), {
        [domain]: {
          reception: {
            priority: 0,
            apply: (context, pending) => {
              escaped = context;
              context.operations.effects.update(
                context.address,
                context.instance.programRef,
                (state) => ({ calls: state.calls + 1 }),
              );
              if (fails) {
                throw new Error("hook failed");
              }
              return { value: pending };
            },
          },
        },
      });
      const original = effectFixtureWork(attach(resources, unit(2, 500), descriptor));
      const healRequest = { sourceUnitId: null, targetUnitId: 2, power: 100 };
      const settle = () =>
        domain === "damage"
          ? resolveDamage(original, request(), resources)
          : resolveHealing(original, healRequest, resources, 1);
      let result;
      if (fails) {
        assert.throws(settle, /hook failed/);
      } else {
        result = settle();
      }

      for (const call of [
        () => escaped.instance,
        () => escaped.facts.getUnit(2),
        () => escaped.facts.getEffect(escaped.address),
        () => escaped.facts.participating(2),
        () => escaped.facts.maxHp(2),
        () => escaped.operations.effects.install(2, descriptor.ref, installation(2)),
        () => escaped.operations.effects.update(escaped.address, descriptor.ref, (state) => state),
        () => escaped.operations.effects.setEnabled(escaped.address, false),
        () => escaped.operations.effects.finish(escaped.address),
        () =>
          escaped.operations.effects.attachParent(escaped.address, {
            unitId: 2,
            instanceId: 99,
          }),
        () => escaped.operations.damage(request()),
        () => escaped.operations.heal(healRequest),
      ]) {
        assert.throws(call, /no longer active/);
      }
      assert.equal(getCombatUnit(original, 2).vitality.hp, 500);
      assert.equal(getCombatUnit(original, 2).effects.instances[0].state.calls, 0);
      if (result !== undefined) {
        assert.equal(getCombatUnit(result.work, 2).vitality.hp, domain === "damage" ? 400 : 600);
        assert.equal(getCombatUnit(result.work, 2).effects.instances[0].state.calls, 1);
      }
    }
  }
});

test("effect dispatch: domain cancellation retains prefix transitions and stops candidates only when explicitly requested", () => {
  for (const stopDispatch of [false, true]) {
    const resources = new CombatResources();
    let followups = 0;
    const cancel = resources.registerEffect(program("cancel", { used: false }), {
      damage: {
        reception: {
          priority: 100,
          apply: (context, pending) => {
            context.operations.effects.update(context.address, context.instance.programRef, () => ({
              used: true,
            }));
            return {
              value: {
                ...pending,
                amount: 0,
                cancellation: { stage: "RECEPTION", reason: "SHIELD" },
              },
              stopDispatch,
            };
          },
        },
      },
    });
    const follower = resources.registerEffect(program("follower"), {
      damage: {
        reception: {
          priority: 0,
          apply: (context, pending) => {
            followups++;
            return { value: pending };
          },
        },
      },
    });
    let owner = attach(resources, unit(2), cancel);
    owner = attach(resources, owner, follower);
    const result = resolveDamage(effectFixtureWork(owner), request(), resources);

    assert.equal(result.report.hpLoss, 0);
    assert.equal(result.report.cancellation.reason, "SHIELD");
    assert.equal(getCombatUnit(result.work, 2).effects.instances[0].state.used, true);
    assert.equal(followups, stopDispatch ? 0 : 1);
  }
});

test("effect dispatch: shield cancellation completes nested healing before return and finalizes after the entered callback", () => {
  const resources = new CombatResources();
  const observed = [];
  const recharge = resources.registerEffect(program("recharge"));
  const shield = resources.registerEffect(program("shield", { charges: 1 }), {
    damage: {
      reception: {
        priority: 0,
        apply: (context, pending) => {
          context.operations.effects.update(
            context.address,
            context.instance.programRef,
            (state) => ({ charges: state.charges - 1 }),
          );
          const healing = context.operations.heal({
            sourceUnitId: 2,
            targetUnitId: 2,
            power: 20,
            ignoreHealFree: true,
          });
          context.operations.effects.finish(context.address);
          observed.push({
            amount: healing.amount,
            hp: context.facts.getUnit(2).vitality.hp,
            finished: context.facts.getEffect(context.address).finished,
            recharge: context.facts
              .getUnit(2)
              .effects.instances.some((instance) => instance.programRef.id === "recharge"),
          });
          return {
            value: {
              ...pending,
              amount: 0,
              cancellation: { stage: "RECEPTION", reason: "SHIELD" },
            },
          };
        },
      },
    },
    lifecycle: {
      finalize: (context) => {
        context.effects.install(2, recharge.ref, installation(2));
      },
    },
  });

  const original = effectFixtureWork(attach(resources, unit(2, 500, ["HEAL_FREE"]), shield));
  const result = resolveDamage(original, request(), resources);

  assert.deepEqual(observed, [{ amount: 20, hp: 520, finished: true, recharge: false }]);
  assert.equal(result.report.hpLoss, 0);
  assert.equal(getCombatUnit(result.work, 2).vitality.hp, 520);
  assert.deepEqual(
    getCombatUnit(result.work, 2).effects.instances.map((instance) => instance.programRef.id),
    ["recharge"],
  );
  assert.deepEqual(
    combatWorkEvents(result.work).map((event) => [event.type, event.amount]),
    [
      ["HEAL", 20],
      ["DAMAGE", 0],
    ],
  );
  assert.equal(getCombatUnit(original, 2).vitality.hp, 500);
});

test("effect dispatch: true damage, skipped modifier reception and invincibility are independent protocol facts", () => {
  for (const [skipModifierEvents, considerInvincibility] of [
    [false, true],
    [true, true],
    [true, false],
  ]) {
    const resources = new CombatResources();
    const seen = [];
    const targetRules = resources.registerEffect(program("target-rules"), {
      damage: {
        targetFormula: {
          priority: 0,
          apply: (context, operands) => {
            seen.push("formula");
            return { value: { ...operands, attackScale: 3 } };
          },
        },
        reception: {
          priority: 0,
          apply: (context, pending) => {
            seen.push("normal");
            return { value: pending };
          },
        },
        skippedReception: {
          priority: 0,
          apply: (context, pending) => {
            seen.push("skipped");
            return { value: { ...pending, amount: pending.amount + 1 } };
          },
        },
        reaction: {
          priority: 0,
          apply: () => {
            seen.push("reaction");
          },
        },
      },
    });
    const target = attach(resources, unit(2, 1000, ["INVINCIBLE"]), targetRules);
    const result = resolveDamage(
      effectFixtureWork(target),
      request(100, { receptionPolicy: { skipModifierEvents, considerInvincibility } }),
      resources,
    );

    assert.equal(result.report.formulaDamage, 300);
    assert.equal(result.report.hpLoss, considerInvincibility ? 0 : 301);
    assert.equal(seen.includes("normal"), !skipModifierEvents);
    assert.equal(seen.includes("reaction"), !skipModifierEvents);
    assert.equal(seen.includes("skipped"), skipModifierEvents);
  }
});

test("effect dispatch: healing observes reception rejection without retrospectively revoking an admitted heal", () => {
  const resources = new CombatResources();
  let calls = 0;
  const reactions = [];
  const blockHealing = resources.registerEffect(program("added-heal-free"), {
    bindings: [compileStatusBinding(["HEAL_FREE"])],
  });
  const descriptor = resources.registerEffect(
    program("healing-rule", { receipts: 0, rejected: 0 }),
    {
      healing: {
        reaction: {
          priority: 0,
          apply: () => {
            reactions.push("target");
          },
        },
        reception: {
          priority: 0,
          apply: (context, pending) => {
            calls++;
            context.operations.effects.update(
              context.address,
              context.instance.programRef,
              (state) => ({
                receipts: state.receipts + 1,
                rejected: state.rejected + Number(pending.cancellation !== null),
              }),
            );
            if (context.request.power === 30 && pending.cancellation === null) {
              context.operations.effects.install(2, blockHealing.ref, installation(2));
            }
            return { value: { ...pending, amount: pending.amount * 2 } };
          },
        },
      },
    },
  );
  const sourceObserver = resources.registerEffect(program("healing-source-observer"), {
    healing: {
      reaction: {
        priority: 1000,
        apply: () => {
          reactions.push("source");
        },
      },
    },
  });

  const original = effectFixtureWork(attach(resources, unit(2, 500, ["HEAL_FREE"]), descriptor));
  const rejected = resolveHealing(
    original,
    { sourceUnitId: null, targetUnitId: 2, power: 20, ignoreHealFree: false },
    resources,
    1,
  );
  const received = resolveHealing(
    original,
    { sourceUnitId: null, targetUnitId: 2, power: 20, ignoreHealFree: true },
    resources,
    1,
  );
  const skipped = resolveHealing(
    original,
    {
      sourceUnitId: null,
      targetUnitId: 2,
      power: 20,
      ignoreHealFree: false,
      skipModifierEvents: true,
    },
    resources,
    1,
  );

  assert.equal(rejected.amount, 0);
  assert.equal(received.amount, 40);
  assert.equal(skipped.amount, 0);
  assert.equal(skipped.report.cancellation.reason, "HEAL_FREE");
  const permittedSkip = resolveHealing(
    original,
    {
      sourceUnitId: null,
      targetUnitId: 2,
      power: 20,
      ignoreHealFree: true,
      skipModifierEvents: true,
    },
    resources,
    1,
  );
  assert.equal(permittedSkip.amount, 20);
  assert.equal(permittedSkip.report.cancellation, null);
  assert.equal(calls, 2);
  assert.deepEqual(getCombatUnit(rejected.work, 2).effects.instances[0].state, {
    receipts: 1,
    rejected: 1,
  });
  assert.deepEqual(getCombatUnit(original, 2).effects.instances[0].state, {
    receipts: 0,
    rejected: 0,
  });

  reactions.length = 0;
  const initiallyAllowed = effectFixtureWork(
    attach(resources, unit(1), sourceObserver),
    attach(resources, unit(2, 500), descriptor),
  );
  const admitted = resolveHealing(
    initiallyAllowed,
    { sourceUnitId: 1, targetUnitId: 2, power: 30, ignoreHealFree: false },
    resources,
    1,
  );
  assert.deepEqual(reactions, ["target", "source"]);
  const next = resolveHealing(
    admitted.work,
    { sourceUnitId: 1, targetUnitId: 2, power: 30, ignoreHealFree: false },
    resources,
    2,
  );

  assert.equal(hasStatusFlag(getCombatUnit(admitted.work, 2), "HEAL_FREE"), true);
  assert.equal(admitted.amount, 60);
  assert.equal(next.amount, 0);
  assert.equal(getCombatUnit(next.work, 2).vitality.hp, 560);
  assert.equal(calls, 4);
  reactions.length = 0;
  resolveHealing(
    admitted.work,
    { sourceUnitId: 2, targetUnitId: 2, power: 1, ignoreHealFree: true },
    resources,
    3,
  );
  assert.deepEqual(reactions, ["target"]);
  for (const _ignoreHealFree of [false, true]) {
    for (const _skipModifierEvent of [false, true]) {
      const mapped = readArknightsHealingRequest(
        {
          $type: "Torappu.Battle.Action.Nodes+HealViaMaxHpRatio",
          _ignoreHealFree,
          _skipModifierEvent,
        },
        { sourceUnitId: null, targetUnitId: 2, power: 20 },
      );
      const resolution = resolveHealing(original, mapped, resources, 1);
      assert.equal(mapped.ignoreHealFree, _ignoreHealFree || _skipModifierEvent);
      assert.equal(mapped.skipModifierEvents, _skipModifierEvent);
      assert.equal(resolution.amount, _skipModifierEvent ? 20 : _ignoreHealFree ? 40 : 0);
    }
  }
});

test("effect registration: domain facets coexist and expose the complete healing protocol", () => {
  const resources = new CombatResources();
  const descriptor = resources.registerEffect(
    program("dual-receiver", {
      damage: 0,
      output: 0,
      reception: 0,
      skipped: 0,
      reactions: 0,
      initialized: false,
    }),
    {
      contributions: [maxHp(() => [modifier.create({ finalAddition: 50 })])],
      bindings: [compileStatusBinding(["INVISIBLE"])],
      lifecycle: {
        start: (context) =>
          context.effects.update(context.address, context.instance.programRef, (state) => ({
            ...state,
            initialized: true,
          })),
      },
      damage: {
        reception: {
          priority: 0,
          apply: (context, pending) => {
            context.operations.effects.update(
              context.address,
              context.instance.programRef,
              (state) => ({ ...state, damage: state.damage + 1 }),
            );
            return { value: { ...pending, amount: pending.amount * 2 } };
          },
        },
      },
      healing: {
        output: {
          priority: 0,
          apply: (context, pending) => {
            context.operations.effects.update(
              context.address,
              context.instance.programRef,
              (state) => ({ ...state, output: state.output + 1 }),
            );
            return { value: { ...pending, amount: pending.amount + 5 } };
          },
        },
        reception: {
          priority: 0,
          apply: (context, pending) => {
            context.operations.effects.update(
              context.address,
              context.instance.programRef,
              (state) => ({ ...state, reception: state.reception + 1 }),
            );
            return { value: { ...pending, amount: pending.amount * 2 } };
          },
        },
        skippedReception: {
          priority: 0,
          apply: (context, pending) => {
            context.operations.effects.update(
              context.address,
              context.instance.programRef,
              (state) => ({ ...state, skipped: state.skipped + 1 }),
            );
            return { value: { ...pending, amount: pending.amount + 1 } };
          },
        },
        reaction: {
          priority: 0,
          apply: (context) => {
            context.operations.effects.update(
              context.address,
              context.instance.programRef,
              (state) => ({ ...state, reactions: state.reactions + 1 }),
            );
          },
        },
      },
    },
  );
  const initial = effectFixtureWork(attach(resources, unit(2, 500), descriptor));
  assert.equal(hasStatusFlag(getCombatUnit(initial, 2), "INVISIBLE"), true);
  assert.equal(resolveMaxHp(2, combatWorkView(initial)), 1050);
  assert.equal(getCombatUnit(initial, 2).vitality.hp, 525);
  const damaged = resolveDamage(initial, request(100, { sourceUnitId: 2 }), resources);
  const healed = resolveHealing(
    damaged.work,
    { sourceUnitId: 2, targetUnitId: 2, power: 10, ignoreHealFree: false },
    resources,
    1,
  );
  const skipped = resolveHealing(
    healed.work,
    {
      sourceUnitId: 2,
      targetUnitId: 2,
      power: 10,
      ignoreHealFree: false,
      skipModifierEvents: true,
    },
    resources,
    2,
  );

  assert.equal(damaged.report.hpLoss, 200);
  assert.equal(healed.amount, 30);
  assert.equal(skipped.amount, 11);
  assert.equal(getCombatUnit(skipped.work, 2).vitality.hp, 366);
  assert.deepEqual(getCombatUnit(skipped.work, 2).effects.instances[0].state, {
    damage: 1,
    output: 1,
    reception: 1,
    skipped: 1,
    reactions: 1,
    initialized: true,
  });
});
