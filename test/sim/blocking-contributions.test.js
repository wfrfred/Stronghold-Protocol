import { fixtureBattlefield } from "../helpers/battlefield.js";
import { effectTick } from "../../dist/core/tactical/unit/capability/effects/instance.js";
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { advanceBlocking } from '../../dist/core/tactical/battle/steps/blocking.js';
import { createBattleState, battlefieldView, getUnit } from '../../dist/core/tactical/battle/execution/context.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';
import { projectStaticNavigationMap } from '../../dist/core/tactical/battlefield/navigation/projection.js';
import { applyBattlefieldChanges } from '../../dist/core/tactical/battlefield/storage/changes.js';
import { deriveBattlefieldDependencies } from '../../dist/core/tactical/battlefield/storage/dependencies.js';
import { createBattlefieldState, settleBattlefieldState, settleBattlefieldStateFully } from '../../dist/core/tactical/battlefield/storage/state.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { copyUnitSnapshot } from '../../dist/core/tactical/unit/snapshot.js';
import {
  copyBlockerState,
  createBlockerDefinition,
  initializeBlockerState,
  resolveBlockingCapacity,
  updateBlockingCapacityContributions,
} from '../../dist/core/tactical/unit/capability/blocking.js';
import { blockingCapacity } from '../../dist/core/tactical/unit/capability/blocking-contributions.js';
import { createEffectProgram } from '../../dist/core/tactical/unit/capability/effects/program.js';
import {
  expireEffects, finalizeEffect, finishEffects, installNewEffect,
  setEffectEnabled, setEffectTick, updateEffectState,
} from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { maxHp } from '../../dist/core/tactical/unit/capability/vitality/contributions.js';
import { resolveMaxHp } from '../../dist/core/tactical/unit/capability/vitality/query.js';
import * as contribution from '../../dist/core/tactical/modifier/contribution.js';
import * as modifier from '../../dist/core/tactical/modifier/value.js';
import { compileAttributeModifiers, parseAttributeModifiers } from '../../dist/data/arknights/modifier.js';
import { compileBuffStacking, parseBuffStacking } from '../../dist/data/arknights/buff-stacking.js';
import { effectFixtureWork } from '../helpers/effects.js';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/arknights/blocking_buffs.json', import.meta.url), 'utf8'));
const fixture = key => fixtures.find(entry => entry.node._buff.buffKey === key);
const effectAddress = { type: "EFFECT", unitId: 0, effectId: 0 };
const program = (id, state = {}) => createEffectProgram({ id, initialize: () => state, ownState: value => ({ ...value }) });
const blocker = (capacity = 3) => initializeUnit({
  id: 0, position: [0, 0], definition: {
    id: 'capacity-holder', allegiance: { side: 'ALLY' }, vitality: { maxHp: 100 },
    blocker: { capacity, geometry: { radius: 1 } },
  },
});
const enemy = (id, weight = 1) => initializeUnit({
  id, position: [0.25, 0], definition: {
    id: `blocked-${id}`, allegiance: { side: 'ENEMY' }, blockable: { weight },
  },
});
const capacityOf = unit => resolveBlockingCapacity(unit.definition.blocker, unit.blocker);
const capacity = work => capacityOf(getUnit(work, 0));
const install = (work, effect, resources, expiresAtTick = null) => installNewEffect(
  work, 0, effect.ref, { source: 7, scopes: expiresAtTick === null ? [] : [{ type: "TICK", tick: expiresAtTick }] }, resources, 0,
).work;
const entry = (id, value, participating = true) => ({ id, sequence: 0, participating, values: [value] });

test('blocking capacity: initialization and copying retain stored contributions and resolve ties to even after clamping', () => {
  const definition = createBlockerDefinition({ capacity: 3, geometry: { radius: 1 } });
  const state = initializeBlockerState(definition);
  assert.equal(definition.capacity, 3);
  assert.deepEqual(state.capacity.entries, []);
  assert.equal(resolveBlockingCapacity(definition, state), 3);
  const modified = { ...state, capacity: contribution.create([entry('arithmetic', modifier.create({
    addition: 1, multiplier: 0.5, finalAddition: 1, finalScaler: 2,
  }))]) };
  assert.equal(resolveBlockingCapacity(definition, modified), 14);
  const copy = copyBlockerState(modified);
  assert.notEqual(copy, modified);
  assert.equal(copy.capacity.entries, modified.capacity.entries);
  assert.ok(Object.isFrozen(copy.capacity.entries));
  assert.ok(Object.isFrozen(copy.capacity.entries[0]));
  copy.capacity = contribution.setParticipation(copy.capacity, 'arithmetic', false);
  assert.equal(resolveBlockingCapacity(definition, copy), 3);
  assert.equal(resolveBlockingCapacity(definition, modified), 14);
  for (const [value, expected] of [[-3, 0], [-0.5, 0], [0.49, 0], [0.5, 0], [0.51, 1], [1.5, 2], [2.5, 2], [3.5, 4]]) {
    const result = { ...state, capacity: contribution.create([entry('rounding', modifier.create({ finalAddition: value - 3 }))]) };
    assert.equal(resolveBlockingCapacity(definition, result), expected, `resolved ${value}`);
  }
});

test('blocking capacity: effect updates, participation and terminal cleanup preserve base capacity and unrelated HP', () => {
  const resources = new CombatResources();
  const effect = resources.registerEffect(program('capacity-effect', { amount: -1 }), {
    contributions: [blockingCapacity(instance => [modifier.create({ addition: instance.state.amount })])],
  });
  const hpEffect = resources.registerEffect(program('hp-effect'), {
    contributions: [maxHp(() => [modifier.create({ finalAddition: 100 })])],
  });
  const initialized = blocker();
  const owner = { ...initialized, vitality: { ...initialized.vitality, hp: 50 } };
  const original = effectFixtureWork(owner);
  let work = install(original, effect, resources);
  const installed = copyUnitSnapshot(getUnit(work, 0));
  assert.equal(capacity(work), 2);
  assert.equal(getUnit(work, 0).vitality.hp, 50);
  assert.equal(resolveMaxHp(0, battlefieldView(work)), 100);
  work = updateEffectState(work, 0, 0, effect.ref, () => ({ amount: -2 }), resources, 0);
  assert.equal(capacity(work), 1);
  work = setEffectEnabled(work, effectAddress, false, resources, 1);
  assert.equal(capacity(work), 3);
  work = updateEffectState(work, 0, 0, effect.ref, () => ({ amount: -9 }), resources, 1);
  assert.equal(capacity(work), 3);
  work = setEffectEnabled(work, effectAddress, true, resources, 2);
  assert.equal(capacity(work), 0);
  work = install(work, hpEffect, resources);
  assert.equal(capacity(work), 0);
  assert.equal(getUnit(work, 0).vitality.hp, 100);
  assert.equal(resolveMaxHp(0, battlefieldView(work)), 200);
  work = finishEffects(work, [effectAddress], resources, 3);
  assert.equal(capacity(work), 3);
  assert.equal(getUnit(work, 0).vitality.hp, 100);
  assert.equal(resolveMaxHp(0, battlefieldView(work)), 200);
  assert.equal(getUnit(work, 0).definition.blocker.capacity, 3);
  const current = getUnit(work, 0);
  assert.equal(updateBlockingCapacityContributions(current, state => state), current);
  work = finalizeEffect(work, effectAddress, resources, 3);
  assert.deepEqual(getUnit(work, 0).blocker.capacity.entries, []);
  assert.equal(installed.blocker.capacity.entries[0].participating, true);
  assert.equal(capacityOf(installed), 2);
  assert.equal(capacity(original), 3);
  assert.equal(owner.vitality.hp, 50);
});

function battlefield(units) {
  const tile = createTile({ heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null });
  const map = createBattlefieldMap(1, 1, [tile]);
  const baseline = { WALK: projectStaticNavigationMap(map, 'WALK', 0), FLY: projectStaticNavigationMap(map, 'FLY', 0) };
  const branches = [settleBattlefieldState, settleBattlefieldStateFully].map(settle => ({
    settle, state: createBattlefieldState(map, baseline),
  }));
  const commit = changes => {
    const results = branches.map(branch => {
      const previous = branch.state;
      const applied = applyBattlefieldChanges(previous, changes);
      const dependencies = deriveBattlefieldDependencies(map, previous, applied.content, applied.dependencies);
      const settled = branch.settle(map, baseline, previous, applied.content, applied.dependencies);
      branch.state = settled.state;
      return { ...applied.facts, ...settled.facts, dependencies };
    });
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(branches[0].state, branches[1].state);
    return results[0];
  };
  const h = {
    branches, commit,
    get state() { return branches[0].state; },
    work() { return createBattleState(fixtureBattlefield({ map,
      unitIds: [...h.state.units.keys()], getUnit: id => h.state.units.get(id),
      blockingRelations: h.state.blockingRelations, supportRelations: h.state.supportRelations,
    })); },
    publish(work) {
      return commit(work.battlefield.unitIds.map(id => ({ type: 'UPDATE_UNIT', unit: getUnit(work, id) })));
    },
    blocked() { return h.state.blockingRelations.map(relation => relation.blockedUnitId); },
    blockingPhase(tick) {
      const state = h.state;
      const changes = advanceBlocking({
        map, unitIds: [...state.units.keys()], getUnit: id => state.units.get(id),
        blockingRelations: state.blockingRelations, supportRelations: state.supportRelations,
      });
      commit(changes);
    },
  };
  commit(units.map(unit => ({ type: 'REGISTER_UNIT', unit })));
  return h;
}

function nativeModifier(raw) {
  const description = raw.node._buff.attributes.attributeModifiers.find(value => value.attributeType === 'BLOCK_CNT');
  const parsed = parseAttributeModifiers([description]);
  assert.deepEqual(parseAttributeModifiers([{ ...description, attributeType: 5 }]), parsed);
  return compileAttributeModifiers(parsed)[0];
}

test('blocking capacity: native STACK layers release enemies and expiry restores acquisition at the next blocking phase', () => {
  const raw = fixture('enemy_mcnist_block_cnt_advance');
  assert.equal(raw.source.templateKey, 'enemy_mcnist_block_advance');
  assert.deepEqual(raw.source.nodePath, [0]);
  const rule = compileBuffStacking(parseBuffStacking(raw.node._buff));
  const compiled = nativeModifier(raw);
  const resources = new CombatResources();
  const effect = resources.registerEffect(program(raw.node._buff.buffKey, { stackCount: 1, lifetimeTicks: 2 }), {
    contributions: [blockingCapacity(instance => [compiled.sample({
      blackboard: new Map([['block_cnt', -1]]), stackCount: rule.validStackCount(instance.state.stackCount),
      readSourceAttribute: () => undefined,
    })])],
    lifecycle: { expire: context => {
      const plan = rule.expire({ stackCount: context.instance.state.stackCount,
        expiresAtTick: effectTick(context.instance) }, context.instance.state.lifetimeTicks, context.tick);
      if (plan.type === 'FINISH') {
        context.effects.finish([context.ref]);
      } else {
        context.effects.setTick(context.ref, plan.expiresAtTick);
        context.effects.update(context.ref, effect.ref, state => ({ ...state, stackCount: plan.stackCount }));
      }
    } },
  });
  const h = battlefield([blocker(), enemy(1), enemy(2), enemy(3), enemy(4, 4)]);
  h.blockingPhase(0);
  assert.deepEqual(h.blocked(), [1, 2, 3]);
  const original = h.state;
  const apply = () => {
    let work = h.work();
    const current = getUnit(work, 0).effects?.instances.find(instance => instance.programRef === effect.ref);
    const plan = rule.plan(current === undefined ? undefined : {
      stackCount: current.state.stackCount, expiresAtTick: effectTick(current),
    }, { stackCount: 1, expiresAtTick: 2 }, 0);
    if (plan.type === 'INSTALL') {
      work = install(work, effect, resources, 2);
    } else {
      assert.equal(plan.type, 'REFRESH');
      work = setEffectTick(work, effectAddress, plan.expiresAtTick);
      work = updateEffectState(work, 0, 0, effect.ref, state => ({ ...state, stackCount: plan.stackCount }), resources, 0);
    }
    assert.equal(h.publish(work).dependencies.blocking, true);
  };
  for (const [remaining, blocked] of [[2, [1, 2]], [1, [1]], [0, []]]) {
    apply();
    assert.equal(capacityOf(h.state.units.get(0)), remaining);
    assert.deepEqual(h.blocked(), blocked);
  }
  for (const [tick, restored] of [[2, 1], [4, 2], [6, 3]]) {
    const beforePhase = h.blocked();
    h.publish(expireEffects(h.work(), tick, resources));
    assert.equal(capacityOf(h.state.units.get(0)), restored);
    assert.deepEqual(h.blocked(), beforePhase, 'restoring capacity does not acquire relations during settlement');
    h.blockingPhase(tick);
    assert.deepEqual(h.blocked(), Array.from({ length: restored }, (_, index) => index + 1));
  }
  assert.equal(h.state.units.get(0).effects.instances[0].finished, true);
  assert.equal(h.state.units.get(0).definition.blocker.capacity, 3);
  assert.equal(h.state.units.get(4).definition.blockable.weight, 4);
  assert.equal(h.state.units.get(4).blockable.weight, 4);
  assert.equal(original.units.get(0).blocker.capacity.entries.length, 0);
  assert.deepEqual(original.blockingRelations.map(relation => relation.blockedUnitId), [1, 2, 3]);
});

test('blocking capacity: the native zero scaler releases weighted enemies and participation restores capacity independently of weight', () => {
  const raw = fixture('redace[taunt]');
  assert.equal(raw.source.templateKey, 'redace_tal_trigger');
  assert.deepEqual(raw.source.nodePath, [3]);
  const compiled = nativeModifier(raw);
  const resources = new CombatResources();
  const effect = resources.registerEffect(program(raw.node._buff.buffKey), {
    contributions: [blockingCapacity(() => [compiled.sample({
      blackboard: new Map(), stackCount: 1, readSourceAttribute: () => undefined,
    })])],
  });
  const h = battlefield([blocker(), enemy(1, 2), enemy(2), enemy(3, 4)]);
  h.blockingPhase(0);
  assert.deepEqual(h.blocked(), [1, 2]);
  h.publish(install(h.work(), effect, resources));
  assert.equal(capacityOf(h.state.units.get(0)), 0);
  assert.deepEqual(h.blocked(), []);
  h.blockingPhase(0);
  assert.deepEqual(h.blocked(), []);
  h.publish(setEffectEnabled(h.work(), effectAddress, false, resources, 1));
  assert.equal(capacityOf(h.state.units.get(0)), 3);
  assert.deepEqual(h.blocked(), []);
  h.blockingPhase(1);
  assert.deepEqual(h.blocked(), [1, 2]);
  h.publish(setEffectEnabled(h.work(), effectAddress, true, resources, 2));
  assert.deepEqual(h.blocked(), []);
  h.publish(finishEffects(h.work(), [effectAddress], resources, 3));
  assert.equal(capacityOf(h.state.units.get(0)), 3);
  h.blockingPhase(3);
  assert.deepEqual(h.blocked(), [1, 2]);
  assert.deepEqual([...h.state.units.values()].slice(1).map(unit => unit.blockable.weight), [2, 1, 4]);
});

test('blocking capacity: replacing contribution entries without changing the resolved number leaves projection clean', () => {
  const h = battlefield([blocker(), enemy(1)]);
  h.blockingPhase(0);
  const before = h.state;
  const owner = before.units.get(0);
  const changed = updateBlockingCapacityContributions(owner, () => contribution.create([
    entry('positive', modifier.create({ addition: 1 })),
    entry('negative', modifier.create({ addition: -1 })),
  ]));
  assert.notEqual(changed.blocker.capacity.entries, owner.blocker.capacity.entries);
  assert.equal(capacityOf(changed), capacityOf(owner));
  const result = h.commit([{ type: 'UPDATE_UNIT', unit: changed }]);
  assert.deepEqual(result.dependencies, { unitTiles: false, occupancy: false, support: false,
    blocking: false, navigationModifierRelations: false, navigationModifierCoverage: false });
  assert.equal(h.state.blockingRelations, before.blockingRelations);
  assert.equal(h.state.spatial, before.spatial);
  assert.equal(h.state.navigationMaps, before.navigationMaps);
  const refreshed = updateBlockingCapacityContributions(h.state.units.get(0), state =>
    contribution.update(state, 'positive', current => ({ ...current, values: [modifier.create({ addition: 1.1 })] })));
  assert.equal(capacityOf(refreshed), 3);
  assert.equal(h.commit([{ type: 'UPDATE_UNIT', unit: refreshed }]).dependencies.blocking, false);
});
