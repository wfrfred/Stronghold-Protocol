import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import {
  combatWorkEvents,
  getCombatUnit,
} from '../../dist/core/tactical/battle/execution/work.js';
import {
  removeUnitWithEffects,
} from '../../dist/core/tactical/battle/execution/unit-lifecycle.js';
import { EffectDispatchScope } from '../../dist/core/tactical/unit/capability/effects/dispatch.js';
import { prepareCombatEffects } from '../../dist/core/tactical/battle/execution/unit-lifecycle.js';
import { effectView } from '../../dist/core/tactical/unit/capability/effects/query.js';
import { createEffectProgram } from '../../dist/core/tactical/unit/capability/effects/program.js';
import { createSkillDefinition } from '../../dist/core/tactical/unit/capability/skill/capability.js';
import { activateSkill } from '../../dist/core/tactical/unit/capability/skill/execution.js';
import { createDamageOperands } from '../../dist/core/tactical/unit/capability/vitality/damage/contract.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { createLegacyCombatSpec } from '../../dist/legacy/combat.js';
import { effectFixtureWork } from '../helpers/effects.js';

function effectProgram(id) {
  return createEffectProgram({ id, initialize: () => ({}), ownState: state => ({ ...state }) });
}

function fixture(content = {}) {
  const resources = new CombatResources();
  const finished = [];
  const disabled = [];
  const owned = resources.registerEffect(effectProgram('skill-owned-on-receiver'), {
    lifecycle: { disable: context => {
      disabled.push(context.ref.effectId);
      content.disable?.(context);
    } },
  });
  const definition = createSkillDefinition({
    id: 'departing-skill', activation: 'MANUAL', spRecovery: 'NONE',
    spCost: 1, initialSp: 1, durationTicks: null,
  });
  const installOwned = (context, expected = 'INSTALLED') => [[], [{ type: 'UNIT', unitId: 1 }]].map(additional => {
    const result = context.effects.install(1, owned.ref, {
      source: context.unitId, scopes: [{ type: 'SKILL', unitId: context.unitId, activationId: context.activationId }, ...additional],
    });
    assert.equal(result.type, expected);
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
  return combatWorkEvents(work).filter(event => event.type === 'SKILL_FINISHED');
}

for (const reason of ['DEATH', 'RETREAT', 'SCRIPT']) {
  test(`skill scope: ${reason} finishes activation-dependent and additionally receiver-scoped effects before deleting the source`, () => {
    const f = fixture();
    const active = activateSkill(f.work, { unitId: 0, tick: 0 }, f.resources).work;
    const lifecycle = f.resources;
    const removed = reason === 'DEATH'
      ? f.resources.settleDamage(active, sourceDamage()).work
      : removeUnitWithEffects(active, 0, reason, lifecycle, 1);
    const effects = getCombatUnit(removed, 1).effects.instances;

    assert.equal(getCombatUnit(removed, 0), undefined);
    assert.equal(removed.removals.get(0), reason);
    assert.equal(effects.length, 2);
    assert.equal(effects.every(instance => instance.finished && !instance.participating), true);
    assert.deepEqual(f.disabled, [0, 1]);
    assert.deepEqual(f.finished, [{ sourcePresent: true, active: null, tick: 1 }]);
    assert.equal(skillsFinished(removed).length, 1);
    assert.equal(getCombatUnit(active, 0).skill.active.id, 0);
    assert.equal(getCombatUnit(active, 1).effects.instances.every(instance => instance.participating), true);

    const duplicate = removeUnitWithEffects(removed, 0, reason, lifecycle, 1);
    assert.equal(skillsFinished(duplicate).length, 1);
    assert.equal(f.finished.length, 1);
    const cleaned = prepareCombatEffects(duplicate, 2, f.resources);
    assert.deepEqual(getCombatUnit(cleaned, 1).effects.instances, []);
  });
}

test('skill ownership: finish content retains the caller dispatch candidates through nested damage', () => {
  const hits = [];
  let observer;
  const f = fixture({ finish: context => {
    const installed = context.effects.install(1, observer.ref, {
      source: 0, scopes: [],
    });
    assert.equal(installed.type, 'INSTALLED');
    assert.equal(context.facts.getUnit(1).effects.instances.some(instance => instance.programRef === observer.ref && instance.participating), true);
    context.damage({ sourceUnitId: 0, targetUnitId: 1, damageType: 'TRUE', operands: createDamageOperands(1) });
  } });
  observer = f.resources.registerEffect(effectProgram('finish-installed-observer'), {
    damage: { reception: { priority: 0, apply: (_context, value) => {
      hits.push('observer');
      return { value };
    } } },
  });
  let work = activateSkill(f.work, { unitId: 0, tick: 0 }, f.resources).work;
  const dispatch = new EffectDispatchScope();
  dispatch.withCandidates(effectView(() => work), 1, () => {
    work = removeUnitWithEffects(work, 0, 'SCRIPT', f.resources, 1, dispatch);
  });
  assert.deepEqual(hits, []);
  assert.equal(getCombatUnit(work, 1).vitality.hp, 99);
  work = f.resources.settleDamage(work, {
    sourceUnitId: null, targetUnitId: 1, damageType: 'TRUE',
    operands: createDamageOperands(1), tick: 2,
  }, dispatch).work;
  assert.deepEqual(hits, ['observer']);
  assert.equal(getCombatUnit(work, 1).vitality.hp, 98);
});

test('skill scope: activation continues after synchronous self-death but rejects late dependencies before allocation', () => {
  const observed = [];
  const f = fixture({ activate: (context, installOwned) => {
    installOwned(context);
    context.damage({ sourceUnitId: null, targetUnitId: 0,
      damageType: 'TRUE', operands: createDamageOperands(100) });
    assert.equal(context.facts.getUnit(0), undefined);
    observed.push('continued');
    installOwned(context, 'REJECTED');
    assert.equal(context.facts.getUnit(1).effects.instances.length, 2);
    assert.equal(context.facts.getUnit(1).effects.nextInstanceId, 2);
    return { type: 'ACTIVATED' };
  } });
  const activated = activateSkill(f.work, { unitId: 0, tick: 0 }, f.resources);
  assert.equal(activated.result.type, 'FINISHED');
  assert.deepEqual(activated.signals, []);
  assert.deepEqual(observed, ['continued']);
  assert.equal(getCombatUnit(activated.work, 0), undefined);
  assert.deepEqual(f.finished, [{ sourcePresent: true, active: null, tick: 0 }]);
  assert.deepEqual(f.disabled, [0, 1]);
  assert.equal(skillsFinished(activated.work).length, 1);
  assert.equal(getCombatUnit(activated.work, 1).effects.instances.every(instance => instance.finished && !instance.participating), true);
  assert.equal(getCombatUnit(f.work, 0).skill.active, null);
  assert.equal(getCombatUnit(f.work, 0).vitality.hp, 100);
  assert.equal(getCombatUnit(f.work, 1).effects, undefined);
});

test('skill scope: refusal after self-death keeps independent remote effects but rejects activation dependencies', () => {
  let independent;
  const f = fixture({ activate: (context, installOwned) => {
    context.damage({ sourceUnitId: null, targetUnitId: 0,
      damageType: 'TRUE', operands: createDamageOperands(100) });
    installOwned(context, 'REJECTED');
    assert.equal(context.effects.install(1, independent.ref, { source: context.unitId, scopes: [] }).type, 'INSTALLED');
    return { type: 'REJECTED', reason: 'late prerequisite' };
  } });
  independent = f.resources.registerEffect(effectProgram('independent-after-refusal'));
  const rejected = activateSkill(f.work, { unitId: 0, tick: 0 }, f.resources);
  assert.deepEqual(rejected.result, { type: 'REJECTED', reason: 'CONTENT_REJECTED', detail: 'late prerequisite' });
  assert.equal(getCombatUnit(rejected.work, 0), undefined);
  assert.equal(getCombatUnit(rejected.work, 1).effects.instances.every(instance => instance.participating), true);
  assert.equal(skillsFinished(rejected.work).length, 1);
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

test('skill ownership: a throwing departure callback discards the entire tick and retries one committed finish', () => {
  let fail = true;
  let prefix;
  const f = fixture({ finish: context => {
    assert.equal(context.effects.install(1, prefix.ref, { source: 0, scopes: [] }).type, 'INSTALLED');
    if (fail) throw new Error('skill departure failed');
  } });
  prefix = f.resources.registerEffect(effectProgram('finish-prefix'));
  const battle = runtime(f);
  battle.step([{ type: 'ACTIVATE_SKILL', unitId: 0 }]);
  const before = battle.snapshot();
  assert.throws(() => battle.step([{ type: 'RETREAT_UNIT', unitId: 0 }]), /skill departure failed/);
  assert.deepEqual(battle.snapshot(), before);
  fail = false;
  const retried = battle.step([{ type: 'RETREAT_UNIT', unitId: 0 }]);
  const receiver = battle.snapshot().units.find(unit => unit.id === 1);
  assert.equal(battle.snapshot().units.some(unit => unit.id === 0), false);
  assert.equal(retried.events.filter(event => event.type === 'SKILL_FINISHED').length, 1);
  assert.equal(receiver.effects.instances.filter(instance => instance.programRef === prefix.ref).length, 1);
  assert.deepEqual(receiver.effects.instances.map(instance => instance.id), [2]);
});

test('skill ownership: self-death during activation publishes one finish and no late start', () => {
  const f = fixture({ activate: (context, installOwned) => {
    context.damage({ sourceUnitId: null, targetUnitId: 0,
      damageType: 'TRUE', operands: createDamageOperands(100) });
    installOwned(context, 'REJECTED');
    return { type: 'ACTIVATED' };
  } });
  const battle = runtime(f);
  const step = battle.step([{ type: 'ACTIVATE_SKILL', unitId: 0 }]);
  assert.deepEqual(step.events.filter(event => event.type.startsWith('SKILL_')).map(event => event.type), ['SKILL_FINISHED']);
  assert.equal(battle.snapshot().units.some(unit => unit.id === 0), false);
  const receiver = battle.snapshot().units.find(unit => unit.id === 1);
  assert.equal(receiver.effects, undefined);
  assert.equal(f.finished.length, 1);
});

test('skill scope: failed departure cleanup discards self-death and retries the same identities', () => {
  let fail = true;
  const f = fixture({
    activate: (context, installOwned) => {
      installOwned(context);
      context.damage({ sourceUnitId: null, targetUnitId: 0,
        damageType: 'TRUE', operands: createDamageOperands(100) });
      installOwned(context, 'REJECTED');
      return { type: 'ACTIVATED' };
    },
    disable: () => { if (fail) throw new Error('late skill cleanup failed'); },
  });
  const battle = runtime(f);
  const before = battle.snapshot();
  assert.throws(() => battle.step([{ type: 'ACTIVATE_SKILL', unitId: 0 }]), /late skill cleanup failed/);
  assert.deepEqual(battle.snapshot(), before);
  fail = false;
  const retried = battle.step([{ type: 'ACTIVATE_SKILL', unitId: 0 }]);
  const receiver = battle.snapshot().units.find(unit => unit.id === 1);
  assert.deepEqual(retried.events.filter(event => event.type.startsWith('SKILL_')).map(event => event.type), ['SKILL_FINISHED']);
  assert.equal(battle.snapshot().units.some(unit => unit.id === 0), false);
  assert.equal(receiver.effects.nextInstanceId, 2);
  assert.deepEqual(f.disabled.slice(-2), [0, 1]);
  assert.deepEqual(receiver.effects.instances, []);
});
