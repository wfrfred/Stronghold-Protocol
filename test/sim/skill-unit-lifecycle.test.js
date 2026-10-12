import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { definition as effectDefinition, at } from "../helpers/effects.js";
import { transitionUnit } from "../../dist/core/tactical/battle/execution/context.js";
import { setHook, removeHook } from "../../dist/core/tactical/unit/capability/vitality/damage/hook.js";
import { find } from "../../dist/core/tactical/unit/effect/query.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import {
  getUnit,
} from '../../dist/core/tactical/battle/execution/context.js';
import {
  removeUnitWithEffects,
} from '../../dist/core/tactical/battle/execution/unit-lifecycle.js';
import { createSkillDefinition } from '../../dist/core/tactical/unit/capability/skill/capability.js';
import { activateSkill } from '../../dist/core/tactical/unit/capability/skill/execution.js';
import { createDamageOperands } from '../../dist/core/tactical/unit/capability/vitality/damage/contract.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { createLegacyCombatSpec } from '../../dist/legacy/combat.js';
import { effectFixtureWork } from '../helpers/effects.js';

function effectProgram(id) {
  return effectDefinition(id);
}

function fixture(content = {}) {
  const resources = new CombatResources();
  const finished = [];
  const disabled = [];
  const owned = effectDefinition('skill-owned-on-receiver', {}, {
    onDisable: context => {
      disabled.push(context.ref.effectId);
      content.disable?.(context);
    },
  });
  const definition = createSkillDefinition({
    id: 'departing-skill', activation: 'MANUAL', spRecovery: 'NONE',
    spCost: 1, initialSp: 1, durationTicks: null,
  });
  const installOwned = (context, expected = true) => [[], [{ type: 'UNIT', unitId: 1 }]].map(additional => {
    const result = effects.install(context.battle, getUnit(context.battle, 1), owned, {
      source: context.unitId, scopes: [{ type: 'SKILL', unitId: context.unitId, activationId: context.activationId }, ...additional],
    });
    assert.equal(result !== undefined, expected);
    return result;
  });
  resources.skills.register({
    definition,
    activate: context => {
      if (content.activate !== undefined) return content.activate(context, installOwned);
      installOwned(context);
      return { type: 'ACTIVATED' };
    },
    finish: context => {
      const source = context.facts.getUnit(context.unitId);
      finished.push({ sourcePresent: source !== undefined, active: source?.skill.active, tick: context.tick });
      content.finish?.(context);
    },
  });
  const sourceDefinition = { id: 'skill-source', vitality: { maxHp: 100 }, skill: definition };
  const receiverDefinition = { id: 'skill-receiver', vitality: { maxHp: 100 } };
  const source = initializeUnit({ id: 0, definition: sourceDefinition, position: [0, 0] });
  const receiver = initializeUnit({ id: 1, definition: receiverDefinition, position: [1, 0] });
  return {
    resources, finished, disabled, sourceDefinition, receiverDefinition,
    work: effectFixtureWork(source, receiver),
  };
}

function sourceDamage(power = 100, tick = 1) {
  return { sourceUnitId: null, targetUnitId: 0, damageType: 'TRUE',
    operands: createDamageOperands(power), tick };
}

function skillsFinished(work) {
  return work.events.filter(event => event.type === 'SKILL_FINISHED');
}

for (const reason of ['DEATH', 'RETREAT', 'SCRIPT']) {
  test(`skill scope: ${reason} finishes activation-dependent and additionally receiver-scoped effects before deleting the source`, () => {
    const f = fixture();
    const state = f.work;
    activateSkill(state, { unitId: 0, tick: 0 }, f.resources);
    const before = state.battlefield.snapshot("draft");
    const lifecycle = f.resources;
    if (reason === 'DEATH') f.resources.settleDamage(state, sourceDamage());
    else removeUnitWithEffects(state, 0, reason, lifecycle, 1);
    const instances = getUnit(state, 1).effects.instances;

    assert.equal(getUnit(state, 0), undefined);
    assert.equal(state.removedUnits.find(value => value.unitId === 0).reason, reason);
    assert.equal(instances.length, 0);
    assert.deepEqual(instances, []);
    assert.deepEqual(f.disabled, [0, 1]);
    assert.deepEqual(f.finished, [{ sourcePresent: true, active: null, tick: 1 }]);
    assert.equal(skillsFinished(state).length, 1);
    assert.equal(before.getUnit(0).skill.active.id, 0);
    assert.equal(before.getUnit(1).effects.instances.every(instance => instance.status === "ACTIVE"), true);

    removeUnitWithEffects(state, 0, reason, lifecycle, 1);
    assert.equal(skillsFinished(state).length, 1);
    assert.equal(f.finished.length, 1);
    effects.advance(at(state, 2));
    assert.deepEqual(getUnit(state, 1).effects.instances, []);
  });
}

test('skill ownership: finish content can install a hook before nested damage', () => {
  const hits = [];
  const observer = effectDefinition('finish-installed-observer', {}, {
    onInstall(context) {
      const id = context.self.id;
      transitionUnit(context.battle, context.unit.id, unit => setHook(unit, {
        id: 'skill-finish-observer', stage: 'reception', priority: 0,
        enabled: context => find(context.unit, observer, id)?.status === 'ACTIVE',
        invoke: (_context, value) => { hits.push('observer'); return { value }; },
      }));
    },
    onEnd(context) {
      transitionUnit(context.battle, context.unit.id, unit => removeHook(unit, 'skill-finish-observer'));
    },
  });
  const f = fixture({ finish: context => {
    assert.ok(effects.install(context.battle, getUnit(context.battle, 1), observer));
    context.damage({ sourceUnitId: 0, targetUnitId: 1, damageType: 'TRUE', operands: createDamageOperands(1) });
  } });
  activateSkill(f.work, { unitId: 0, tick: 0 }, f.resources);
  removeUnitWithEffects(f.work, 0, 'SCRIPT', f.resources, 1);
  assert.deepEqual(hits, ['observer']);
  assert.equal(getUnit(f.work, 1).vitality.hp, 99);
});

test('skill scope: activation continues after synchronous self-death but rejects late dependencies before allocation', () => {
  const observed = [];
  const f = fixture({ activate: (context, installOwned) => {
    installOwned(context);
    context.damage({ sourceUnitId: null, targetUnitId: 0,
      damageType: 'TRUE', operands: createDamageOperands(100) });
    assert.equal(context.facts.getUnit(0), undefined);
    observed.push('continued');
    installOwned(context, false);
    assert.equal(context.facts.getUnit(1).effects.instances.length, 0);
    assert.equal(context.facts.getUnit(1).effects.nextId, 2);
    return { type: 'ACTIVATED' };
  } });
  const activated = activateSkill(f.work, { unitId: 0, tick: 0 }, f.resources);
  assert.equal(activated.result.type, 'FINISHED');
  assert.deepEqual(activated.signals, []);
  assert.deepEqual(observed, ['continued']);
  assert.equal(getUnit(f.work, 0), undefined);
  assert.deepEqual(f.finished, [{ sourcePresent: true, active: null, tick: 0 }]);
  assert.deepEqual(f.disabled, [0, 1]);
  assert.equal(skillsFinished(f.work).length, 1);
  assert.equal(getUnit(f.work, 1).effects.instances.every(instance => instance.status === "ENDING"), true);
  assert.equal(f.work.battlefield.snapshot("state").getUnit(0).skill.active, null);
  assert.equal(f.work.battlefield.snapshot("state").getUnit(0).vitality.hp, 100);
  assert.deepEqual(f.work.battlefield.snapshot("state").getUnit(1).effects.instances, []);
});

test('skill scope: refusal after self-death keeps independent remote effects but rejects activation dependencies', () => {
  let independent;
  const f = fixture({ activate: (context, installOwned) => {
    context.damage({ sourceUnitId: null, targetUnitId: 0,
      damageType: 'TRUE', operands: createDamageOperands(100) });
    installOwned(context, false);
    assert.equal(effects.install(context.battle, getUnit(context.battle, 1), independent, { source: context.unitId, scopes: [] }) !== undefined, true);
    return { type: 'REJECTED', reason: 'late prerequisite' };
  } });
  independent = effectProgram('independent-after-refusal');
  const rejected = activateSkill(f.work, { unitId: 0, tick: 0 }, f.resources);
  assert.deepEqual(rejected.result, { type: 'REJECTED', reason: 'CONTENT_REJECTED', detail: 'late prerequisite' });
  assert.equal(getUnit(f.work, 0), undefined);
  assert.equal(getUnit(f.work, 1).effects.instances.every(instance => instance.status === "ACTIVE"), true);
  assert.equal(skillsFinished(f.work).length, 1);
  assert.equal(f.finished.length, 1);
});

function runtime(f) {
  const base = createLegacyCombatSpec({ rows: 1, columns: 3, operators: [], enemies: [], maxTicks: 20, seed: 7 });
  return new BattleRuntime({
    ...base,
    initialUnits: [
      { definition: f.sourceDefinition, position: [0, 0] },
      { definition: f.receiverDefinition, position: [1, 0] },
    ],
    schedule: { type: 'TIMELINE', spawns: [{
      definition: { id: 'future', vitality: { maxHp: 1 }, locomotion: {
        moveSpeedPerTick: 0, steeringParameters: { steeringFactor: 1, maxSteeringForce: 1 },
      } }, tick: 19,
      route: { pathMotionMode: 'WALK', startPosition: [0, 2], endPosition: [0, 2],
        spawnOffset: [0, 0], spawnRandomRange: [0, 0], checkpoints: [], allowDiagonalMove: false,
        visitEveryTileCenter: false, visitEveryNodeCenter: false, visitEveryCheckPoint: true },
      timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true,
      notCountInTotal: false,
    }] },
  }, { combat: f.resources });
}

test('skill ownership: a throwing departure callback propagates without publishing the tick', () => {
  let prefix;
  const f = fixture({ finish: context => {
    assert.equal(effects.install(context.battle, getUnit(context.battle, 1), prefix, { source: 0, scopes: [] }) !== undefined, true);
    throw new Error('skill departure failed');
  } });
  prefix = effectProgram('finish-prefix');
  const battle = runtime(f);
  battle.step([{ type: 'ACTIVATE_SKILL', unitId: 0 }]);
  const before = battle.snapshot();
  assert.throws(() => battle.step([{ type: 'RETREAT_UNIT', unitId: 0 }]), /skill departure failed/);
  assert.deepEqual(battle.snapshot(), before);
});

test('skill ownership: self-death during activation publishes one finish and no late start', () => {
  const f = fixture({ activate: (context, installOwned) => {
    context.damage({ sourceUnitId: null, targetUnitId: 0,
      damageType: 'TRUE', operands: createDamageOperands(100) });
    installOwned(context, false);
    return { type: 'ACTIVATED' };
  } });
  const battle = runtime(f);
  const step = battle.step([{ type: 'ACTIVATE_SKILL', unitId: 0 }]);
  assert.deepEqual(step.events.filter(event => event.type.startsWith('SKILL_')).map(event => event.type), ['SKILL_FINISHED']);
  assert.equal(battle.snapshot().units.some(unit => unit.id === 0), false);
  const receiver = battle.snapshot().units.find(unit => unit.id === 1);
  assert.deepEqual(receiver.effects.instances, []);
  assert.equal(f.finished.length, 1);
});

test('skill scope: failed departure cleanup propagates without publishing self-death or identities', () => {
  const f = fixture({
    activate: (context, installOwned) => {
      installOwned(context);
      context.damage({ sourceUnitId: null, targetUnitId: 0,
        damageType: 'TRUE', operands: createDamageOperands(100) });
      installOwned(context, false);
      return { type: 'ACTIVATED' };
    },
    disable: () => { throw new Error('late skill cleanup failed'); },
  });
  const battle = runtime(f);
  const before = battle.snapshot();
  assert.throws(() => battle.step([{ type: 'ACTIVATE_SKILL', unitId: 0 }]), /late skill cleanup failed/);
  assert.deepEqual(battle.snapshot(), before);
});
