import { combatWorkEvents } from "../../dist/core/tactical/battle/execution/work.js";
import { installFixtureEffect } from "../helpers/effects.js";
import { installNewEffect } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { updateEffectState } from "../../dist/core/tactical/unit/capability/effects/transition.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { compileAction } from "../../dist/core/tactical/unit/capability/action/compile.js";
import { startAction } from "../../dist/core/tactical/unit/capability/action/execution.js";
import { createActionExecutionState } from "../../dist/core/tactical/unit/capability/action/process.js";
import { compileEffect } from "../../dist/core/tactical/unit/capability/action/compile-effect.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { EffectDispatchScope } from "../../dist/core/tactical/unit/capability/effects/dispatch.js";
import {
  prepareCombatEffects,
  removeUnitWithEffects,
} from "../../dist/core/tactical/battle/execution/unit-lifecycle.js";
import {
  combatWorkView,
  createCombatWork,
  getCombatUnit,
  updateCombatUnit,
  removeCombatUnit,
} from "../../dist/core/tactical/battle/execution/work.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import { createNumericContribution } from "../../dist/core/tactical/modifier/numeric.js";
import { compileStatusBinding } from "../../dist/core/tactical/unit/capability/status/binding.js";
import { hasStatusFlag } from "../../dist/core/tactical/unit/capability/status/capability.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { createOperatorDefinition } from "../../dist/core/tactical/unit/archetype/operator.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";

const circle = (radius) =>
  createShapeGeometry({
    shapes: [{ type: "CIRCLE", offset: [0, 0], radius }],
  });

function sourceDefinition(id = "source", power = 20) {
  return createOperatorDefinition({
    id,
    vitality: { maxHp: 100 },
    offense: { attack: 10 },
    allegiance: { side: "ALLY" },
    spatial: { layer: "GROUND" },
    hit: { geometry: circle(0.1) },
    status: { initialFlags: [] },
    defense: { defense: 0, resistance: 0 },
    blocker: { capacity: 0, geometry: { radius: 0.7 } },
    action: {
      normalAction: {
        triggerBindingId: "primary",
        intervalTicks: 10,
        recoveryTicks: 0,
        targetGroups: [
          {
            id: "primary",
            targeting: {
              type: "DAMAGE",
              scope: { type: "RANGE", geometry: { type: "SHAPES", geometry: circle(10) } },
              canTargetAir: true,
              includeBlockingRelations: false,
              preferBlockingRelations: false,
              ignoreTargetFree: false,
              ignoreInvisible: false,
              maxTargets: 1,
            },
            effects: [{ type: "DAMAGE", power, damageType: "PHYSICAL" }],
          },
        ],
        followUps: [],
      },
    },
  });
}

function targetDefinition(id = "target", maxHp = 100, flags = []) {
  return Object.freeze({
    id,
    vitality: Object.freeze({ maxHp }),
    allegiance: Object.freeze({ side: "ENEMY" }),
    spatial: Object.freeze({ layer: "GROUND" }),
    hit: Object.freeze({ geometry: circle(0.1) }),
    status: Object.freeze({ initialFlags: Object.freeze([...flags]) }),
    defense: Object.freeze({ defense: 0, resistance: 0 }),
  });
}

function battleSpec(initialUnits) {
  return {
    ...createLegacyCombatSpec({
      rows: 2,
      columns: 4,
      operators: [],
      enemies: [],
      maxTicks: 10,
      seed: 17,
    }),
    initialUnits,
  };
}

function workWith(...units) {
  const byId = new Map(units.map((unit) => [unit.id, unit]));

  return createCombatWork({
    unitIds: [...byId.keys()],
    getUnit: (id) => byId.get(id),
    blockerOf: () => undefined,
    blockedBy: () => [],
  });
}

function effectInstance(resources, program, overrides = {}) {
  return resources.effects.create(program.ref, {
    id: 0,
    source: null,
    scope: null,
    acquiredSequence: 0,
    expiresAtTick: null,
    ...overrides,
  });
}

test("combat program: action compilation uses only injected query and settlement ports", () => {
  const definition = sourceDefinition();
  const action = {
    ...definition.action.normalAction,
    targetGroups: definition.action.normalAction.targetGroups.map(group => ({
      ...group,
      effects: [{ type: "DAMAGE", powerSource: "SOURCE_ATTACK", power: 1, damageType: "PHYSICAL" }],
    })),
    followUps: [{ receiver: { type: "SOURCE" }, effect: { type: "HEAL", power: 5, ignoreHealFree: false } }],
  };
  const source = initializeUnit({ id: 0, definition, position: [0, 0] });
  const target = initializeUnit({ id: 1, definition: targetDefinition(), position: [1, 0] });
  const calls = [];
  const queries = { evaluator: () => () => [] };
  const resources = {
    offense: queries,
    vitality: queries,
    settleDamage: (work, request, scope) => {
      calls.push({ request, scope });
      const current = getCombatUnit(work, request.targetUnitId);
      return { work: updateCombatUnit(work, {
        ...current, vitality: { ...current.vitality, hp: current.vitality.hp - request.operands.power },
      }) };
    },
    settleHealing: (work, request, tick, scope) => {
      calls.push({ request, tick, scope, targetHp: getCombatUnit(work, 1).vitality.hp });
      return { work };
    },
  };
  const compiled = compileAction(action, resources);
  const initial = workWith(source, target);
  const bindings = compiled.bind({ source, battlefield: combatWorkView(initial) });
  let work = initial;

  for (const segment of compiled.program) {
    work = segment.run({ work, sourceUnitId: 0, tick: 7, bindings }).work;
  }

  assert.deepEqual([...bindings], [["primary", [1]]]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].request, {
    sourceUnitId: 0, targetUnitId: 1, tick: 7, damageType: "PHYSICAL",
    operands: { power: 10, attackScale: 1, attackAddition: 0, fixedPenetration: 0, proportionalPenetration: 0 },
  });
  assert.deepEqual(calls[1].request, {
    sourceUnitId: 0, targetUnitId: 0, power: 5, ignoreHealFree: false,
  });
  assert.equal(calls[1].tick, 7);
  assert.equal(calls[1].targetHp, 90);
  assert.equal(calls.every(call => call.scope instanceof EffectDispatchScope), true);
  assert.notEqual(calls[0].scope, calls[1].scope);
  assert.equal(getCombatUnit(initial, 1).vitality.hp, 100);
  assert.equal(getCombatUnit(work, 1).vitality.hp, 90);
});

test("combat program: a custom compiled effect may act on a target without Vitality", () => {
  const resources = new CombatResources();
  const definition = sourceDefinition();
  const source = initializeUnit({ id: 0, definition, position: [0, 0] });
  const target = initializeUnit({ id: 1, definition: { id: "mechanism" }, position: [1, 0] });
  let calls = 0;
  const compiled = compileAction(definition.action.normalAction, resources, () => (context) => {
    calls++;
    const current = getCombatUnit(context.work, context.targetUnitId);

    return updateCombatUnit(context.work, { ...current, position: [2, 0] });
  });
  const prepared = {
    ...compiled,
    bind: () => new Map([["primary", [1]]]),
  };
  const initial = workWith(source, target);
  const result = startAction(initial, createActionExecutionState(), 0, prepared, 0, resources, true).work;

  assert.equal(calls, 1);
  assert.deepEqual(getCombatUnit(result, 1).position, [2, 0]);
  assert.deepEqual(getCombatUnit(initial, 1).position, [1, 0]);
  assert.equal("vitality" in getCombatUnit(result, 1), false);
  assert.deepEqual(
    combatWorkEvents(result).map((event) => event.type),
    ["ACTION", "ACTION_FINISHED"],
  );
});

test("combat program: ordered steps can rebind after a prior hit removes a target", () => {
  const resources = new CombatResources();
  const definition = sourceDefinition();
  const source = initializeUnit({ id: 0, definition, position: [0, 0] });
  const first = initializeUnit({
    id: 1,
    definition: targetDefinition("first", 10),
    position: [1, 0],
  });
  const second = initializeUnit({
    id: 2,
    definition: targetDefinition("second", 30),
    position: [2, 0],
  });
  const compiled = compileAction(definition.action.normalAction, resources);
  let observed;
  const repeated = {
    ...compiled,
    program: [
      compiled.program[0],
      { type: "EXECUTE", run: (context) => {
        observed = {
          first: getCombatUnit(context.work, 1),
          secondHp: getCombatUnit(context.work, 2).vitality.hp,
          candidates: combatWorkView(context.work).unitIds,
        };

        return {
          work: context.work,
          bindings: compiled.bind({
            source: getCombatUnit(context.work, context.sourceUnitId),
            battlefield: combatWorkView(context.work),
          }),
        };
      } },
      compiled.program[0],
    ],
  };
  const result = startAction(workWith(source, first, second), createActionExecutionState(), 0, repeated, 0, resources, true).work;

  assert.deepEqual(observed, { first: undefined, secondHp: 30, candidates: [0, 2] });
  assert.equal(getCombatUnit(result, 1), undefined);
  assert.equal(getCombatUnit(result, 2).vitality.hp, 10);
  assert.deepEqual(
    combatWorkEvents(result)
      .filter((event) => event.type === "DAMAGE")
      .map((event) => [event.targetUnitId, event.amount]),
    [
      [1, 10],
      [2, 20],
    ],
  );
});

test("combat program: a compiled source-attack effect reads current contributions at execution", () => {
  const resources = new CombatResources();
  const program = createEffectProgram({
    id: "attack-bonus",
    initialize: () => ({ bonus: 15 }),
    ownState: (value) => ({ bonus: value.bonus }),
  });
  resources.registerEffect(program, {
    contributions: {
      attack: ({ instance }) => [createNumericContribution({ addition: instance.state.bonus })],
    },
  });
  const effect = compileEffect(
    { type: "DAMAGE", power: 1, powerSource: "SOURCE_ATTACK", damageType: "PHYSICAL" },
    resources,
  );
  const source = installFixtureEffect(
    initializeUnit({ id: 0, definition: sourceDefinition(), position: [0, 0] }),
    effectInstance(resources, program),
    resources,
  );
  const target = initializeUnit({ id: 1, definition: targetDefinition(), position: [1, 0] });
  const first = effect({
    work: workWith(source, target),
    sourceUnitId: 0,
    targetUnitId: 1,
    tick: 0,
  });
  const changed = updateEffectState(first, 0, 0, program.ref, { bonus: 30 }, resources);
  const second = effect({ work: changed, sourceUnitId: 0, targetUnitId: 1, tick: 0 });

  assert.equal(getCombatUnit(first, 1).vitality.hp, 75);
  assert.equal(getCombatUnit(second, 1).vitality.hp, 35);
  assert.deepEqual(
    combatWorkEvents(second).filter((event) => event.type === "DAMAGE").map((event) => event.amount),
    [25, 40],
  );
});

test("combat program: runtime resources compile shared definitions once while snapshots remain data-only", () => {
  const resources = new CombatResources();
  const markerProgram = createEffectProgram({
    id: "marker",
    initialize: () => ({ value: 7 }),
    ownState: (value) => ({ value: value.value }),
  });
  resources.registerEffect(markerProgram, {});
  const definition = sourceDefinition();
  const marker = effectInstance(resources, markerProgram);
  const seeded = installFixtureEffect(
    initializeUnit({ id: 0, definition, position: [0, 0] }),
    marker,
    resources,
  );
  const spec = battleSpec([
    { definition, position: [0, 0], states: { effects: seeded.effects } },
    { definition, position: [0, 1] },
    { definition: Object.freeze({ id: "non-vital-target" }), position: [1, 0] },
  ]);
  let compilations = 0;
  const runtime = new BattleRuntime(spec, {
    combat: resources,
    compileAction: (action, suppliedResources) => {
      compilations++;
      assert.equal(suppliedResources, resources);
      const compiled = compileAction(action, suppliedResources, () => (context) => {
        const target = getCombatUnit(context.work, context.targetUnitId);

        return updateCombatUnit(context.work, {
          ...target,
          position: [context.sourceUnitId + 1, 0],
        });
      });

      return {
        ...compiled,
        bind: () => new Map([["primary", [2]]]),
      };
    },
  });
  const before = runtime.snapshot();

  assert.deepEqual(structuredClone(before), before);
  assert.deepEqual(before.units[0].effects.instances[0].programRef, { id: "marker" });
  assert.equal(before.units[0].definition, definition);

  const step = runtime.step();
  const after = runtime.snapshot();

  assert.equal(compilations, 1);
  assert.equal(step.events.filter((event) => event.type === "ACTION").length, 2);
  assert.deepEqual(after.units.find((unit) => unit.id === 2).position, [2, 0]);
  assert.deepEqual(structuredClone(after), after);
  assert.deepEqual(before.units.find((unit) => unit.id === 2).position, [1, 0]);
});

test("combat program: a failed receiver rolls back shield facts and retries identically", () => {
  function scenario(failing) {
    const resources = new CombatResources();
    const program = createEffectProgram({
      id: "shield",
      initialize: () => ({ remaining: 10 }),
      ownState: (value) => ({ remaining: value.remaining }),
    });
    const attempts = [];
    const fault = { enabled: failing };
    resources.registerEffect(program, {
      damage: {
        reception: {
          priority: 1000,
          apply: (context, damage) => {
            const absorbed = Math.min(context.instance.state.remaining, damage.amount);
            context.operations.effects.update(context.address, program.ref, (state) => ({
              remaining: state.remaining - absorbed,
            }));
            attempts.push(context.instance.state.remaining);

            if (fault.enabled) {
              throw new Error("receiver failed after consuming shield");
            }

            return { value: { ...damage, amount: damage.amount - absorbed } };
          },
        },
      },
    });
    const definition = targetDefinition();
    const seeded = installFixtureEffect(
      initializeUnit({ id: 1, definition, position: [1, 0] }),
      effectInstance(resources, program),
      resources,
    );
    const runtime = new BattleRuntime(
      battleSpec([
        { definition: sourceDefinition(), position: [0, 0] },
        { definition, position: [1, 0], states: { effects: seeded.effects } },
      ]),
      { combat: resources },
    );

    return { runtime, fault, attempts };
  }

  const { runtime, fault, attempts } = scenario(true);
  const before = runtime.snapshot();

  assert.throws(() => runtime.step(), /receiver failed after consuming shield/);
  assert.deepEqual(runtime.snapshot(), before);
  assert.equal(attempts[0], 0);

  fault.enabled = false;
  const retry = runtime.step();
  const reference = scenario(false);
  const expected = reference.runtime.step();

  assert.equal(attempts[1], attempts[0]);
  assert.deepEqual(retry, expected);
  assert.deepEqual(runtime.snapshot(), reference.runtime.snapshot());
  assert.equal(runtime.snapshot().units.find((unit) => unit.id === 1).vitality.hp, 90);
  assert.equal(
    runtime.snapshot().units.find((unit) => unit.id === 1).effects.instances[0].state.remaining,
    0,
  );
});

test("combat program: expiration removes its status contribution and preserves baseline flags", () => {
  const resources = new CombatResources();
  const program = createEffectProgram({
    id: "expiring-marker",
    initialize: () => ({}),
    ownState: () => ({}),
  });
  resources.registerEffect(program, {
    bindings: [compileStatusBinding(["INVISIBLE"])],
  });
  const definition = targetDefinition("marked-target", 100, ["HEAL_FREE"]);
  const seeded = installFixtureEffect(
    initializeUnit({ id: 0, definition, position: [1, 0] }),
    effectInstance(resources, program, { expiresAtTick: 0 }),
    resources,
  );
  const runtime = new BattleRuntime(
    battleSpec([
      { definition, position: [1, 0], states: { effects: seeded.effects, status: seeded.status } },
    ]),
    { combat: resources },
  );
  const before = runtime.snapshot().units[0];

  assert.equal(hasStatusFlag(before, "INVISIBLE"), true);
  assert.equal(hasStatusFlag(before, "HEAL_FREE"), true);
  runtime.step();
  const after = runtime.snapshot().units[0];

  assert.deepEqual(after.effects.instances, []);
  assert.equal(hasStatusFlag(after, "INVISIBLE"), false);
  assert.equal(hasStatusFlag(after, "HEAL_FREE"), true);
  assert.equal(hasStatusFlag(before, "INVISIBLE"), true);
});

test("combat program: retreat cleans lifetime-owned effects without treating provenance as ownership", () => {
  const resources = new CombatResources();
  const program = createEffectProgram({
    id: "owned-marker",
    initialize: () => ({}),
    ownState: () => ({}),
  });
  resources.registerEffect(program, {
    bindings: [compileStatusBinding(["HEAL_FREE"])],
  });
  const neutral = resources.registerEffect(
    createEffectProgram({ id: "neutral-marker", initialize: () => ({}), ownState: () => ({}) }),
  );
  const invisible = resources.registerEffect(
    createEffectProgram({ id: "invisible-marker", initialize: () => ({}), ownState: () => ({}) }),
    {
      bindings: [compileStatusBinding(["INVISIBLE"])],
    },
  );
  const definition = targetDefinition();
  let seeded = initializeUnit({ id: 1, definition, position: [1, 0] });
  seeded = installFixtureEffect(
    seeded,
    effectInstance(resources, program, {
      source: 0,
      scope: { type: "UNIT", unitId: 0 },
    }),
    resources,
  );
  seeded = installFixtureEffect(
    seeded,
    effectInstance(resources, neutral, { id: 1, acquiredSequence: 1, source: 0 }),
    resources,
  );
  seeded = installFixtureEffect(
    seeded,
    effectInstance(resources, invisible, {
      id: 2,
      acquiredSequence: 2,
      source: 0,
      scope: { type: "UNIT", unitId: 2 },
    }),
    resources,
  );
  const owner = initializeUnit({ id: 0, definition: { id: "owner" }, position: [0, 0] });
  const otherOwner = initializeUnit({ id: 2, definition: { id: "other-owner" }, position: [2, 0] });
  const removed = removeUnitWithEffects(
    workWith(owner, seeded, otherOwner),
    0,
    "RETREAT",
    resources,
    0,
  );
  const pending = getCombatUnit(removed, 1);
  assert.deepEqual(
    pending.effects.instances.map((instance) => instance.id),
    [0, 1, 2],
  );
  assert.equal(pending.effects.instances[0].finished, true);
  assert.equal(pending.effects.instances[0].participating, false);
  assert.equal(hasStatusFlag(pending, "HEAL_FREE"), false);
  const prepared = prepareCombatEffects(removed, 0, resources);
  assert.deepEqual(
    getCombatUnit(prepared, 1).effects.instances.map((instance) => instance.id),
    [1, 2],
  );
  const runtime = new BattleRuntime(
    battleSpec([
      { definition: Object.freeze({ id: "owner" }), position: [0, 0] },
      { definition, position: [1, 0], states: { effects: seeded.effects, status: seeded.status } },
      { definition: Object.freeze({ id: "other-owner" }), position: [2, 0] },
    ]),
    { combat: resources },
  );

  runtime.step([{ type: "RETREAT_UNIT", unitId: 0 }]);
  const snapshot = runtime.snapshot();
  const target = snapshot.units.find((unit) => unit.id === 1);

  assert.equal(
    snapshot.units.some((unit) => unit.id === 0),
    false,
  );
  assert.deepEqual(
    target.effects.instances.map((instance) => instance.id),
    [1, 2],
  );
  assert.equal(hasStatusFlag(target, "HEAL_FREE"), false);
  assert.equal(hasStatusFlag(target, "INVISIBLE"), true);
});


test("combat program: readiness skips binding and target ownership stays in events and execution", () => {
  const resources = new CombatResources();
  const definition = sourceDefinition();
  const source = initializeUnit({ id: 0, definition, position: [0, 0] });
  const target = initializeUnit({ id: 1, definition: targetDefinition(), position: [1, 0] });
  const compiled = compileAction(definition.action.normalAction, resources);
  let bindings = 0;
  const query = {
    ...compiled,
    bind: (context) => {
      assert.equal("work" in context, false);
      bindings++;
      return compiled.bind(context);
    },
  };
  const state = createActionExecutionState();

  for (const [readyAtTick, recoveryUntilTick, mayStart] of [[2, 0, true], [0, 2, true], [0, 0, false]]) {
    const waiting = { ...source, action: { ...source.action, readyAtTick, recoveryUntilTick } };
    const initial = workWith(waiting, target);
    const result = startAction(initial, state, 0, query, 1, resources, mayStart);

    assert.equal(result.work, initial);
    assert.equal(result.state, state);
    assert.deepEqual(Object.keys(getCombatUnit(result.work, 0).action).sort(), ['readyAtTick', 'recoveryUntilTick']);
  }
  assert.equal(bindings, 0);

  const started = startAction(workWith(source, target), state, 0, query, 0, resources, true);
  assert.equal(bindings, 1);
  assert.equal(combatWorkEvents(started.work).find(event => event.type === 'ACTION').targetUnitId, 1);
  assert.deepEqual(started.state, { nextExecutionId: 1, executions: [] });
  assert.equal(combatWorkEvents(started.work).at(-1).type, "ACTION_FINISHED");

  const disappeared = removeCombatUnit(started.work, 1, 'RETREAT');
  const cooling = startAction(disappeared, started.state, 0, query, 1, resources, true);
  assert.equal(cooling.work, disappeared);
  assert.equal(bindings, 1);
  assert.deepEqual(Object.keys(getCombatUnit(cooling.work, 0).action).sort(), ['readyAtTick', 'recoveryUntilTick']);

  const ready = startAction(cooling.work, cooling.state, 0, query, definition.action.normalAction.intervalTicks, resources, true);
  assert.equal(bindings, 2);
  assert.equal(ready.work, cooling.work);
  assert.deepEqual(ready.state, cooling.state);
});

test("combat program: immediate execution cleans owned Effects and cancels successors after source departure", () => {
  const resources = new CombatResources();
  const marker = resources.registerEffect(createEffectProgram({
    id: "instant-scoped-marker",
    initialize: () => ({}),
    ownState: () => ({}),
  }), { bindings: [compileStatusBinding(["INVINCIBLE"])] });
  const definition = sourceDefinition();
  const source = initializeUnit({ id: 0, definition, position: [0, 0] });
  const target = initializeUnit({ id: 1, definition: targetDefinition(), position: [1, 0] });
  const observed = [];
  const compiled = {
    ...compileAction(definition.action.normalAction, resources),
    program: [
      { type: "EXECUTE", run: (context) => {
        observed.push(["install", context.executionId]);
        return { work: installNewEffect(context.work, 1, marker.ref, {
          source: 0,
          scope: { type: "EXECUTION", unitId: 0, executionId: context.executionId },
          expiresAtTick: null,
        }, resources, context.tick).work };
      } },
      { type: "EXECUTE", run: (context) => ({ work: removeCombatUnit(context.work, 0, "RETREAT") }) },
      { type: "EXECUTE", run: (context) => {
        observed.push(["successor", getCombatUnit(context.work, 0)]);
        assert.equal(hasStatusFlag(getCombatUnit(context.work, 1), "INVINCIBLE"), true);
        return { work: updateCombatUnit(context.work, { ...getCombatUnit(context.work, 1), position: [2, 0] }) };
      } },
    ],
  };
  const started = startAction(workWith(source, target), createActionExecutionState(), 0, compiled, 0, resources, true);
  const receiver = getCombatUnit(started.work, 1);

  assert.deepEqual(observed, [["install", 0]]);
  assert.deepEqual(receiver.position, [1, 0]);
  assert.equal(receiver.effects.instances[0].finished, true);
  assert.equal(hasStatusFlag(receiver, "INVINCIBLE"), false);
  assert.deepEqual(started.state, { nextExecutionId: 1, executions: [] });
  assert.equal(combatWorkEvents(started.work).at(-1).type, "ACTION_CANCELLED");
  assert.equal(combatWorkEvents(started.work).at(-1).reason, 'SOURCE_ABSENT');
});
