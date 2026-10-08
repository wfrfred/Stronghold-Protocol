import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { combatWorkView, getCombatUnit } from '../../dist/core/tactical/battle/execution/work.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { copyUnitSnapshot } from '../../dist/core/tactical/unit/snapshot.js';
import { createEffectProgram } from '../../dist/core/tactical/unit/capability/effects/program.js';
import { attack } from '../../dist/core/tactical/unit/capability/offense/contributions.js';
import { maxHp } from '../../dist/core/tactical/unit/capability/vitality/contributions.js';
import { resolveAttackPower } from '../../dist/core/tactical/unit/capability/offense/query.js';
import { resolveMaxHp } from '../../dist/core/tactical/unit/capability/vitality/query.js';
import { compileStatusBinding } from '../../dist/core/tactical/unit/capability/status/binding.js';
import { hasStatusFlag } from '../../dist/core/tactical/unit/capability/status/capability.js';
import {
  installNewEffect, setEffectEnabled, updateEffectState, finishEffect,
  expireEffects, attachEffectParent, finalizeEffect,
} from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import * as modifier from '../../dist/core/tactical/modifier/value.js';
import { effectFixtureWork } from '../helpers/effects.js';

const address = instanceId => ({ unitId: 0, instanceId });
function harness() {
  const resources = new CombatResources();
  const unit = initializeUnit({ id: 0, definition: {
    id: 'receiver', offense: { attack: 100 }, vitality: { maxHp: 1000 },
    status: { initialFlags: [] },
  }, position: [0, 0] });
  return { resources, work: effectFixtureWork({ ...unit, vitality: { ...unit.vitality, hp: 500 } }) };
}
function values(work, resources) {
  return {
    attack: resolveAttackPower(0, combatWorkView(work), resources.computations),
    maxHp: resolveMaxHp(0, combatWorkView(work)),
    hp: getCombatUnit(work, 0).vitality.hp,
  };
}
function definition(resources, id = 'inspiration', lifecycle = {}, onSample = () => {}) {
  return resources.registerEffect(createEffectProgram({
    id,
    initialize: () => ({ ratio: 0.5, sourceAttack: 100, hpBonus: 1000 }),
    ownState: state => ({ ...state }),
  }), {
    contributions: [
      attack(instance => { onSample(instance); return [modifier.create({ finalAddition: instance.state.ratio * instance.state.sourceAttack })]; }),
      maxHp(instance => [modifier.create({ addition: instance.state.hpBonus })]),
    ],
    bindings: [compileStatusBinding(['INVINCIBLE'])],
    lifecycle: {
      competition: instance => ({ group: 'encourage', priority: instance.state.ratio }),
      ...lifecycle,
    },
  });
}
function install(h, program, state, expiresAtTick = null, source = null) {
  const result = installNewEffect(h.work, 0, program.ref, {
    source, scope: null, expiresAtTick, initialState: state,
  }, h.resources, 0);
  h.work = result.work;
  assert.equal(result.result.type, 'INSTALLED');
  return result.result.address;
}

test('effect competition: coefficient wins independently of sampled value; recovery preserves history', () => {
  const h = harness();
  const samples = [];
  let starts = 0;
  const program = definition(h.resources, 'inspiration', { start: () => { starts++; } }, instance => samples.push(instance.id));
  const weak = install(h, program, { ratio: 0.5, sourceAttack: 500, hpBonus: 1000 }, null, 10);
  const first = h.work;
  const strong = install(h, program, { ratio: 0.6, sourceAttack: 100, hpBonus: 3000 }, null, 20);
  const instances = getCombatUnit(h.work, 0).effects.instances;
  assert.equal(instances[0].enabled, true);
  assert.equal(instances[0].participating, false);
  assert.equal(instances[0].source, 10);
  assert.deepEqual(values(h.work, h.resources), { attack: 160, maxHp: 4000, hp: 2000 });
  h.work = finishEffect(h.work, strong, h.resources, 1);
  assert.deepEqual(values(h.work, h.resources), { attack: 350, maxHp: 2000, hp: 1000 });
  assert.equal(getCombatUnit(h.work, 0).effects.instances[0].state.sourceAttack, 500);
  assert.equal(starts, 2);
  assert.deepEqual(samples, [0, 1]);
  h.work = finalizeEffect(h.work, strong, h.resources, 1);
  assert.equal(getCombatUnit(h.work, 0).effects.instances[0].id, weak.instanceId);
  assert.deepEqual(values(first, h.resources), { attack: 350, maxHp: 2000, hp: 1000 });
});

test('effect competition: explicit enable is independent of override participation and copied facts', () => {
  const h = harness();
  const program = definition(h.resources);
  const weak = install(h, program, { ratio: 0.5, sourceAttack: 100, hpBonus: 1000 });
  const strong = install(h, program, { ratio: 0.9, sourceAttack: 100, hpBonus: 3000 });
  h.work = setEffectEnabled(h.work, weak, false, h.resources, 1);
  h.work = setEffectEnabled(h.work, strong, false, h.resources, 2);
  assert.deepEqual(values(h.work, h.resources), { attack: 100, maxHp: 1000, hp: 500 });
  assert.equal(hasStatusFlag(getCombatUnit(h.work, 0), 'INVINCIBLE'), false);
  const snapshot = copyUnitSnapshot(getCombatUnit(h.work, 0));
  h.work = setEffectEnabled(h.work, weak, true, h.resources, 3);
  assert.equal(getCombatUnit(h.work, 0).effects.instances[0].participating, false);
  assert.equal(values(h.work, h.resources).attack, 100);
  h.work = setEffectEnabled(h.work, strong, true, h.resources, 4);
  assert.equal(getCombatUnit(h.work, 0).effects.instances[0].enabled, true);
  assert.equal(getCombatUnit(h.work, 0).effects.instances[0].participating, false);
  assert.equal(snapshot.effects.instances[0].enabled, false);
  assert.equal(snapshot.effects.instances[1].enabled, false);
});

test('effect competition: same group spans programs and equal priority keeps earliest acquisition', () => {
  const h = harness();
  const first = definition(h.resources, 'first');
  const second = definition(h.resources, 'second');
  const old = install(h, first, { ratio: 0.5, sourceAttack: 100, hpBonus: 1000 });
  install(h, second, { ratio: 0.5, sourceAttack: 1000, hpBonus: 3000 });
  assert.equal(values(h.work, h.resources).attack, 150);
  h.work = finishEffect(h.work, old, h.resources, 1);
  assert.equal(values(h.work, h.resources).attack, 600);
});

test('effect competition: state refresh publishes complete facts and all bindings before callbacks', () => {
  const h = harness();
  const observations = [];
  const observe = kind => context => {
    const unit = context.facts.getUnit(0);
    observations.push({ kind, id: context.address.instanceId, active: context.facts.participating(0).map(instance => instance.id),
      hp: unit.vitality.hp, maxHp: resolveMaxHp(0, { getUnit: id => context.facts.getUnit(id) }),
      attack: resolveAttackPower(0, { getUnit: id => context.facts.getUnit(id) }, h.resources.computations) });
  };
  const program = definition(h.resources, 'coherent', { enable: observe('enable'), disable: observe('disable') });
  install(h, program, { ratio: 0.5, sourceAttack: 100, hpBonus: 1000 });
  install(h, program, { ratio: 0.6, sourceAttack: 100, hpBonus: 3000 });
  observations.length = 0;
  h.work = updateEffectState(h.work, 0, 0, program.ref, state => ({ ...state, ratio: 0.8, sourceAttack: 200, hpBonus: 7000 }), h.resources, 5);
  assert.deepEqual(observations, [
    { kind: 'disable', id: 1, active: [0], hp: 4000, maxHp: 8000, attack: 260 },
    { kind: 'enable', id: 0, active: [0], hp: 4000, maxHp: 8000, attack: 260 },
  ]);
});

test('effect competition: overridden instances continue expiring and cannot be resurrected', () => {
  const h = harness();
  const program = definition(h.resources);
  const weak = install(h, program, { ratio: 0.5, sourceAttack: 100, hpBonus: 1000 }, 2);
  const strong = install(h, program, { ratio: 0.9, sourceAttack: 100, hpBonus: 3000 }, 4);
  h.work = expireEffects(h.work, 2, h.resources);
  assert.equal(getCombatUnit(h.work, 0).effects.instances[0].finished, true);
  assert.equal(values(h.work, h.resources).attack, 190);
  h.work = finishEffect(h.work, strong, h.resources, 3);
  assert.equal(values(h.work, h.resources).attack, 100);
  assert.equal(setEffectEnabled(h.work, weak, true, h.resources, 4), h.work);
});

test('effect competition: parent finish restores the surviving independent source', () => {
  const h = harness();
  const parent = h.resources.registerEffect(createEffectProgram({ id: 'parent', initialize: () => ({}), ownState: state => state }));
  const parentAddress = install(h, parent, {});
  const program = definition(h.resources);
  install(h, program, { ratio: 0.5, sourceAttack: 100, hpBonus: 1000 }, null, 1);
  const child = install(h, program, { ratio: 0.9, sourceAttack: 100, hpBonus: 3000 }, null, 2);
  h.work = attachEffectParent(h.work, child, parentAddress, h.resources, 0).work;
  h.work = finishEffect(h.work, parentAddress, h.resources, 1);
  assert.equal(getCombatUnit(h.work, 0).effects.instances[2].finished, true);
  assert.equal(values(h.work, h.resources).attack, 150);
});

test('effect competition: nested finish invalidates a pending enable callback, then outer work continues', () => {
  const h = harness();
  const callbacks = [];
  const program = definition(h.resources, 'nested', {
    disable: context => {
      callbacks.push(['disable', context.address.instanceId]);
      if (context.address.instanceId === 0 && !context.instance.finished) {
        context.effects.finish(address(1));
        callbacks.push(['continued', context.facts.participating(0).map(instance => instance.id)]);
      }
    },
    enable: context => { callbacks.push(['enable', context.address.instanceId]); },
  });
  install(h, program, { ratio: 0.5, sourceAttack: 100, hpBonus: 1000 });
  callbacks.length = 0;
  const result = installNewEffect(h.work, 0, program.ref, {
    source: null, scope: null, expiresAtTick: null, initialState: { ratio: 0.9, sourceAttack: 100, hpBonus: 3000 },
  }, h.resources, 0);
  h.work = result.work;
  assert.equal(result.result.type, 'REJECTED');
  assert.equal(result.result.reason, 'START_FINISHED');
  assert.deepEqual(callbacks, [['disable', 0], ['disable', 1], ['enable', 0], ['continued', [0]]]);
  assert.equal(values(h.work, h.resources).attack, 150);
});

test('effect competition: callback exception leaves input facts and contributions intact', () => {
  const h = harness();
  const program = definition(h.resources, 'fails', {
    enable: context => {
      if (context.instance.state.ratio > 0.6) { throw new Error('content bug'); }
    },
  });
  install(h, program, { ratio: 0.5, sourceAttack: 100, hpBonus: 1000 });
  install(h, program, { ratio: 0.6, sourceAttack: 100, hpBonus: 3000 });
  const original = h.work;
  assert.throws(() => updateEffectState(original, 0, 0, program.ref, state => ({ ...state, ratio: 0.9 }), h.resources, 1), /content bug/);
  assert.equal(getCombatUnit(original, 0).effects.instances[0].state.ratio, 0.5);
  assert.deepEqual(values(original, h.resources), { attack: 160, maxHp: 4000, hp: 2000 });
});

test('effect competition: nested enable changes supersede a pending outer notification', () => {
  const h = harness();
  const events = [];
  const program = definition(h.resources, 'reentrant', {
    enable: context => { events.push(['enable', context.address.instanceId]); },
    disable: context => {
      events.push(['disable', context.address.instanceId]);
      if (context.address.instanceId === 1 && context.instance.finished) {
        context.effects.setEnabled(address(0), false);
        context.effects.setEnabled(address(0), true);
      }
    },
  });
  install(h, program, { ratio: 0.5, sourceAttack: 100, hpBonus: 1000 });
  const strong = install(h, program, { ratio: 0.9, sourceAttack: 100, hpBonus: 3000 });
  events.length = 0;
  h.work = finishEffect(h.work, strong, h.resources, 1);
  assert.deepEqual(events, [['disable', 1], ['disable', 0], ['enable', 0]]);
  assert.equal(values(h.work, h.resources).attack, 150);
});

test('effect competition: ending a strong parent never enables its weaker child', () => {
  const h = harness();
  const events = [];
  const program = definition(h.resources, 'parent-group', {
    enable: context => { events.push(['enable', context.address.instanceId]); },
    disable: context => {
      events.push(['disable', context.address.instanceId]);
      assert.equal(context.facts.getEffect(address(1)).finished, true);
      assert.deepEqual(context.facts.participating(0), []);
    },
  });
  const parent = install(h, program, { ratio: 0.9, sourceAttack: 100, hpBonus: 3000 });
  const child = install(h, program, { ratio: 0.5, sourceAttack: 100, hpBonus: 1000 });
  h.work = attachEffectParent(h.work, child, parent, h.resources, 0).work;
  events.length = 0;
  h.work = finishEffect(h.work, parent, h.resources, 1);
  assert.deepEqual(events, [['disable', 0]]);
  assert.equal(getCombatUnit(h.work, 0).effects.instances[1].finished, true);
  assert.deepEqual(values(h.work, h.resources), { attack: 100, maxHp: 1000, hp: 500 });
});

test('effect competition: empty identity and nonfinite priority fail without publishing', () => {
  for (const competition of [{ group: '', priority: 1 }, { group: 'g', priority: Infinity }]) {
    const h = harness();
    const program = definition(h.resources, 'invalid', { competition: () => competition });
    const original = h.work;
    assert.throws(() => install(h, program, { ratio: 1, sourceAttack: 100, hpBonus: 1000 }), /competition/);
    assert.equal(getCombatUnit(original, 0).effects, undefined);
  }
});

test('effect competition: cross-unit parent completion publishes child recovery and HP responses before any callback', () => {
  const h = harness();
  const second = initializeUnit({ id: 1, position: [1, 0], definition: {
    id: 'second', offense: { attack: 100 }, vitality: { maxHp: 1000 }, status: { initialFlags: [] },
  } });
  h.work = effectFixtureWork(getCombatUnit(h.work, 0), { ...second, vitality: { ...second.vitality, hp: 500 } });
  const observations = [];
  const program = definition(h.resources, 'cross-unit', {
    disable: context => {
      if (context.address.unitId === 0) {
        const child = context.facts.getEffect({ unitId: 1, instanceId: 1 });
        const receiver = context.facts.getUnit(1);
        observations.push([
          child.finished, child.participating, context.facts.participating(1).map(instance => instance.id),
          receiver.vitality.hp, resolveMaxHp(1, { getUnit: id => context.facts.getUnit(id) }),
        ]);
      }
    },
  });
  const parent = install(h, program, { ratio: 0.9, sourceAttack: 100, hpBonus: 3000 });
  for (const ratio of [0.5, 0.9]) {
    h.work = installNewEffect(h.work, 1, program.ref, {
      source: null, scope: null, expiresAtTick: null,
      initialState: { ratio, sourceAttack: 100, hpBonus: ratio === 0.5 ? 1000 : 3000 },
    }, h.resources, 0).work;
  }
  h.work = attachEffectParent(h.work, { unitId: 1, instanceId: 1 }, parent, h.resources, 0).work;
  h.work = finishEffect(h.work, parent, h.resources, 1);
  assert.deepEqual(observations, [[true, false, [0], 1000, 2000]]);
  assert.deepEqual(values(h.work, h.resources), { attack: 100, hp: 500, maxHp: 1000 });
});
