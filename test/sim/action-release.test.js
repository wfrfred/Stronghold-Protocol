import assert from "node:assert/strict";
import { test } from "node:test";
import { getUnit, transitionUnit } from "../../dist/core/tactical/battle/execution/context.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { createActionDefinition, setBeforeReleaseHook, removeBeforeReleaseHook } from "../../dist/core/tactical/unit/capability/action/capability.js";
import { beforeActionRelease } from "../../dist/core/tactical/unit/capability/action/release.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { find, get } from "../../dist/core/tactical/unit/effect/query.js";
import { effectFixtureWork, definition } from "../helpers/effects.js";

const action = createActionDefinition({
  triggerBindingId: 'primary', baseAttackTimeTicks: 30, recoveryTicks: 0,
  targetGroups: [{ id: 'primary', targeting: {
    type: 'DAMAGE', scope: { type: 'BLOCKER' }, canTargetAir: true,
    includeBlockingRelations: false, preferBlockingRelations: false,
    ignoreTargetFree: false, ignoreInvisible: false, maxTargets: 1,
  }, operations: [{ type: 'DAMAGE', power: 1, damageType: 'TRUE' }] }], followUps: [],
});

function actor() {
  return initializeUnit({ id: 0, definition: {
    id: 'release-actor', action: { normalAction: action }, vitality: { maxHp: 1000 },
  }, position: [0, 0] });
}
function releaseEffect(id, initialState, run) {
  const program = definition(id, initialState, {
    onInstall(context) {
      const ref = context.ref;
      transitionUnit(context.battle, ref.unitId, unit => setBeforeReleaseHook(unit, {
        id: `release/${ref.effectId}`,
        enabled: context => find(context.unit, program, ref.effectId)?.status === "ACTIVE",
        invoke: context => run(context, find(context.unit, program, ref.effectId), ref, program),
      }));
    },
    onEnd(context) {
      transitionUnit(context.battle, context.ref.unitId, unit => removeBeforeReleaseHook(unit, `release/${context.ref.effectId}`));
    },
  });
  return program;
}

function attach(work, program, input = {}) {
  return effects.install(work, getUnit(work, 0), program, input);
}

const continueRelease = { type: "CONTINUE" };

test("action release: an ordinary or disabled effect does not interrupt", () => {
  const work = effectFixtureWork(actor());
  assert.equal(beforeActionRelease(work, 0, 0), false);
  const program = releaseEffect("disabled", {}, () => assert.fail("disabled hook ran"));
  const ref = attach(work, program);
  effects.setEnabled(work, ref, false);
  assert.equal(beforeActionRelease(work, 0, 0), false);
  assert.equal(getUnit(work, 0).action.recoveryUntilTick, 0);
});

test("action release: charges update before cleanup and recovery never shortens", () => {
  const work = effectFixtureWork(actor());
  const initial = work.battlefield.snapshot("state");
  const program = releaseEffect("charges", { remaining: 3 }, (context, self, ref) => {
    const remaining = self.state.remaining - 1;
    effects.setState(context.battle, ref, program, { remaining });
    assert.equal(get(context.battle, ref).state.remaining, remaining);
    if (remaining === 0) effects.end(context.battle, ref);
    return { type: "INTERRUPT", recoveryTicks: 15 };
  });
  const ref = attach(work, program);
  assert.equal(beforeActionRelease(work, 0, 1), true);
  assert.equal(get(work, ref).state.remaining, 2);
  assert.equal(beforeActionRelease(work, 0, 2), true);
  assert.equal(beforeActionRelease(work, 0, 3), true);
  assert.equal(get(work, ref), undefined);
  assert.equal(beforeActionRelease(work, 0, 4), false);
  assert.equal(getUnit(work, 0).action.recoveryUntilTick, 18);
  assert.deepEqual(initial.getUnit(0).effects.instances, []);
});

test("action release: hooks run in registration order and first interruption ends dispatch", () => {
  const work = effectFixtureWork(actor());
  const calls = [];
  for (const [id, directive] of [["first", continueRelease], ["second", { type: "INTERRUPT", recoveryTicks: 4 }], ["third", continueRelease]]) {
    attach(work, releaseEffect(id, {}, () => { calls.push(id); return directive; }));
  }
  assert.equal(beforeActionRelease(work, 0, 10), true);
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(getUnit(work, 0).action.recoveryUntilTick, 14);
});

for (const operation of ["enable", "end"]) {
  test(`action release: ${operation} changes later eligibility, newly registered hooks wait for the next release`, () => {
    const work = effectFixtureWork(actor());
    const calls = [];
    const third = releaseEffect("third", {}, () => { calls.push("C"); return continueRelease; });
    let secondRef;
    const first = releaseEffect("first", { entered: false }, (context, self, ref, program) => {
      calls.push("A");
      if (!self.state.entered) {
        effects.setState(context.battle, ref, program, { entered: true });
        if (operation === "enable") effects.setEnabled(context.battle, secondRef, true);
        else effects.end(context.battle, secondRef);
        const installed = attach(context.battle, third);
        assert.equal(get(context.battle, installed).status, "ACTIVE");
      }
      return continueRelease;
    });
    attach(work, first);
    secondRef = attach(work, releaseEffect("second", {}, () => { calls.push("B"); return continueRelease; }));
    if (operation === "enable") effects.setEnabled(work, secondRef, false);
    beforeActionRelease(work, 0, 0);
    assert.deepEqual(calls, operation === "enable" ? ["A", "B"] : ["A"]);
    calls.length = 0;
    beforeActionRelease(work, 0, 1);
    assert.deepEqual(calls, operation === "enable" ? ["A", "B", "C"] : ["A", "C"]);
  });
}

test("action release: a throwing hook propagates without publishing its draft writes", () => {
  const work = effectFixtureWork(actor());
  const program = releaseEffect("fault", { attempts: 0 }, (context, self, ref) => {
    effects.setState(context.battle, ref, program, { attempts: self.state.attempts + 1 });
    throw new Error("release failed");
  });
  const ref = attach(work, program);
  work.battlefield.apply();
  assert.throws(() => beforeActionRelease(work, 0, 0), /release failed/);
  assert.equal(get(work, ref).state.attempts, 1);
  assert.equal(work.battlefield.snapshot("state").getUnit(0).effects.instances[0].state.attempts, 0);
});

for (const recoveryTicks of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
  test(`action release: invalid recovery ${recoveryTicks} is rejected`, () => {
    const work = effectFixtureWork(actor());
    attach(work, releaseEffect("invalid", {}, () => ({ type: "INTERRUPT", recoveryTicks })));
    assert.throws(() => beforeActionRelease(work, 0, 1), RangeError);
  });
}
