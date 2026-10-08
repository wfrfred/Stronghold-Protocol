import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { combatWorkView, getCombatUnit } from '../../dist/core/tactical/battle/execution/work.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';
import { createMechanismDefinition, createMechanismRuntime } from '../../dist/core/tactical/battlefield/mechanism.js';
import { createEffectSourceProgramRef, effectSourceInstallation } from '../../dist/core/tactical/battlefield/effect-source/program.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { createEffectProgram } from '../../dist/core/tactical/unit/capability/effects/program.js';
import { EffectDispatchScope } from '../../dist/core/tactical/unit/capability/effects/dispatch.js';
import {
  expireEffects,
  finalizeFinishedEffects,
  installNewEffect,
  setEffectEnabled,
} from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { attack } from '../../dist/core/tactical/unit/capability/offense/contributions.js';
import { resolveAttackPower } from '../../dist/core/tactical/unit/capability/offense/query.js';
import * as modifier from '../../dist/core/tactical/modifier/value.js';
import { effectFixtureWork } from '../helpers/effects.js';

const address = instanceId => ({ unitId: 0, instanceId });
const instances = work => getCombatUnit(work, 0).effects.instances;
const power = work => resolveAttackPower(0, combatWorkView(work));
const program = (id, initial = {}) => createEffectProgram({
  id, initialize: () => initial, ownState: state => ({ ...state }),
});
const owner = () => initializeUnit({
  id: 0, position: [0, 0], definition: { id: 'expiry-owner', offense: { attack: 100 } },
});
const install = (work, effect, resources, expiresAtTick, initialState) => installNewEffect(
  work, 0, effect.ref,
  { source: 7, scope: { type: 'UNIT', unitId: 0 }, expiresAtTick, ...(initialState === undefined ? {} : { initialState }) },
  resources, 0,
).work;

test('effect expiry: the default finishes at the deadline and defers finalization', () => {
  const resources = new CombatResources();
  const events = [];
  const effect = resources.registerEffect(program('default'), {
    contributions: [attack(() => [modifier.create({ finalAddition: 20 })])],
    lifecycle: {
      disable: context => { events.push(['disable', context.instance.finished]); },
      finalize: () => { events.push(['finalize']); },
    },
  });
  const original = install(effectFixtureWork(owner()), effect, resources, 5);
  assert.equal(expireEffects(original, 4, resources), original);
  const finished = expireEffects(original, 5, resources);
  assert.equal(power(finished), 100);
  assert.equal(instances(finished)[0].finished, true);
  assert.deepEqual(events, [['disable', true]]);
  assert.equal(expireEffects(finished, 6, resources), finished);
  const cleared = finalizeFinishedEffects(finished, 0, resources, 6);
  assert.deepEqual(instances(cleared), []);
  assert.deepEqual(events, [['disable', true], ['finalize']]);
  assert.equal(instances(original)[0].finished, false);
  assert.equal(power(original), 120);
  for (const deadline of [null, 10]) {
    const untouched = install(effectFixtureWork(owner()), effect, resources, deadline);
    assert.equal(expireEffects(untouched, 5, resources), untouched);
  }
});

test('effect expiry: disabled and overridden instances retain their expiration behavior', () => {
  for (const inactive of ['disabled', 'overridden']) {
    for (const custom of [false, true]) {
      const resources = new CombatResources();
      const calls = [];
      const effect = resources.registerEffect(program('inactive'), {
        contributions: [attack(() => [modifier.create({ finalAddition: 20 })])],
        lifecycle: {
          competition: () => ({ group: 'expiry', priority: 1 }),
          ...(custom ? { expire: context => {
            calls.push([context.instance.enabled, context.instance.participating]);
            context.effects.finish(context.address);
          } } : {}),
        },
      });
      let work = install(effectFixtureWork(owner()), effect, resources, 5);
      if (inactive === 'disabled') {
        work = setEffectEnabled(work, address(0), false, resources, 1);
      } else {
        const winner = resources.registerEffect(program('winner'), {
          lifecycle: { competition: () => ({ group: 'expiry', priority: 2 }) },
        });
        work = install(work, winner, resources, null);
      }
      assert.equal(instances(work)[0].participating, false);
      const expired = expireEffects(work, 5, resources);
      assert.equal(instances(expired)[0].finished, true);
      assert.deepEqual(calls, custom ? [[inactive !== 'disabled', false]] : []);
      assert.equal(power(expired), 100);
      assert.equal(setEffectEnabled(expired, address(0), true, resources, 6), expired);
    }
  }
});

test('effect expiry: an earlier callback can renew or finish a later expired candidate', () => {
  for (const change of ['renew', 'clear', 'finish']) {
    const resources = new CombatResources();
    const calls = [];
    const first = resources.registerEffect(program('first'), {
      lifecycle: { disable: context => {
        if (change === 'finish') {
          context.effects.finish(address(1));
        } else {
          context.effects.setExpiration(address(1), change === 'renew' ? 12 : null);
        }
      } },
    });
    const later = resources.registerEffect(program('later'), {
      lifecycle: { expire: context => {
        calls.push('later');
        context.effects.finish(context.address);
      } },
    });
    let work = install(effectFixtureWork(owner()), first, resources, 5);
    work = install(work, later, resources, 5);
    const expired = expireEffects(work, 5, resources);
    assert.deepEqual(calls, []);
    assert.equal(instances(expired)[0].finished, true);
    assert.equal(instances(expired)[1].finished, change === 'finish');
    assert.equal(instances(expired)[1].expiresAtTick, change === 'renew' ? 12 : change === 'clear' ? null : 5);
  }
});

test('effect expiry: content can remove one layer, renew the same identity, and finish the last layer', () => {
  const resources = new CombatResources();
  let starts = 0;
  let enables = 0;
  let expires = 0;
  const effect = resources.registerEffect(program('layered', { layers: 3, intervalTicks: 4 }), {
    contributions: [attack(instance => [modifier.create({ finalAddition: instance.state.layers * 10 })])],
    lifecycle: {
      start: () => { starts++; },
      enable: () => { enables++; },
      expire: context => {
        expires++;
        if (context.instance.state.layers === 1) {
          context.effects.finish(context.address);
        } else {
          context.effects.setExpiration(context.address, context.tick + context.instance.state.intervalTicks);
          context.effects.update(context.address, effect.ref, state => ({ ...state, layers: state.layers - 1 }));
          assert.equal(context.facts.getEffect(context.address).state.layers, context.instance.state.layers);
          assert.equal(context.facts.getEffect(context.address).expiresAtTick, context.tick + 4);
        }
      },
    },
  });
  const original = install(effectFixtureWork(owner()), effect, resources, 2);
  const initial = instances(original)[0];
  let work = expireEffects(original, 2, resources);
  assert.equal(power(work), 120);
  assert.equal(instances(work)[0].expiresAtTick, 6);
  assert.equal(expireEffects(work, 2, resources), work);
  work = expireEffects(work, 7, resources);
  assert.equal(expires, 2, 'an overdue deadline enters the callback once per pass');
  assert.equal(power(work), 110);
  assert.equal(instances(work)[0].expiresAtTick, 11);
  const remaining = instances(work)[0];
  for (const key of ['id', 'source', 'scope', 'acquiredSequence', 'programRef', 'parent']) {
    assert.deepEqual(remaining[key], initial[key]);
  }
  assert.equal(instances(work).length, 1);
  assert.equal(starts, 1);
  assert.equal(enables, 1);
  work = expireEffects(work, 11, resources);
  assert.equal(instances(work)[0].finished, true);
  assert.equal(power(work), 100);
  assert.equal(expires, 3);
  assert.equal(instances(original)[0].state.layers, 3);
  assert.equal(power(original), 130);
});

test('effect expiry: clearing a deadline and nested terminal removal are normal outcomes', () => {
  for (const settlement of ['clear', 'remove']) {
    const resources = new CombatResources();
    const replacement = resources.registerEffect(program('replacement'));
    const effect = resources.registerEffect(program('normal-outcome', { count: 0 }), {
      lifecycle: { expire: context => {
        context.effects.update(context.address, effect.ref, () => ({ count: 1 }));
        if (settlement === 'clear') {
          context.effects.setExpiration(context.address, null);
        } else {
          context.effects.finish(context.address);
          context.effects.install(0, replacement.ref, { source: null, scope: null, expiresAtTick: null });
          assert.equal(context.facts.getEffect(context.address), undefined);
          assert.equal(context.instance.finished, true);
          assert.equal(context.instance.state.count, 1);
        }
      } },
    });
    const original = install(effectFixtureWork(owner()), effect, resources, 5);
    const expired = expireEffects(original, 5, resources);
    assert.equal(instances(expired).length, 1);
    assert.equal(instances(expired)[0].expiresAtTick, null);
    assert.equal(instances(expired)[0].finished, false);
    assert.equal(instances(expired)[0].programRef, settlement === 'clear' ? effect.ref : replacement.ref);
  }
});

test('effect expiry: renewed deadlines and updated bindings are visible to participation successors', () => {
  const resources = new CombatResources();
  const observed = [];
  const observe = kind => context => {
    const layered = context.facts.getEffect(address(0));
    const unit = context.facts.getUnit(0);
    observed.push({
      kind, layers: layered.state.layers, deadline: layered.expiresAtTick,
      active: context.facts.participating(0).map(instance => instance.id),
      retainedAddition: unit.offense.attack.entries.find(entry => entry.owner?.instanceId === 0).values[0].finalAddition,
      attack: resolveAttackPower(0, { getUnit: id => context.facts.getUnit(id) }),
    });
  };
  const layered = resources.registerEffect(program('coherent-layers', { layers: 3 }), {
    contributions: [attack(instance => [modifier.create({ finalAddition: instance.state.layers * 10 })])],
    lifecycle: {
      competition: instance => ({ group: 'layers', priority: instance.state.layers }),
      disable: observe('disable'),
      expire: context => {
        context.effects.setExpiration(context.address, context.tick + 5);
        context.effects.update(context.address, layered.ref, state => ({ layers: state.layers - 1 }));
      },
    },
  });
  const rival = resources.registerEffect(program('rival'), {
    contributions: [attack(() => [modifier.create({ finalAddition: 25 })])],
    lifecycle: { competition: () => ({ group: 'layers', priority: 2.5 }), enable: observe('enable') },
  });
  let work = install(effectFixtureWork(owner()), layered, resources, 5);
  work = install(work, rival, resources, null);
  const expired = expireEffects(work, 5, resources);
  assert.deepEqual(observed, ['disable', 'enable'].map(kind => ({
    kind, layers: 2, deadline: 10, active: [1], retainedAddition: 20, attack: 125,
  })));
  assert.equal(instances(expired)[0].finished, false);
});

test('effect expiry: unresolved deadlines fail without publishing state and release callback scopes for retry', () => {
  for (const failure of ['unchanged', 'state-only', 'overdue', 'exception']) {
    const resources = new CombatResources();
    const scope = new EffectDispatchScope();
    let fail = true;
    let escaped;
    const effect = resources.registerEffect(program('fallible', { layers: 3 }), {
      contributions: [attack(instance => [modifier.create({ finalAddition: instance.state.layers * 10 })])],
      lifecycle: { expire: context => {
        escaped = context;
        if (!fail || failure !== 'unchanged') {
          context.effects.update(context.address, effect.ref, state => ({ layers: state.layers - 1 }));
        }
        if (fail && failure === 'exception') {
          throw new Error('expiration failed');
        }
        if (!fail) {
          context.effects.setExpiration(context.address, context.tick + 1);
        } else if (failure === 'overdue') {
          context.effects.setExpiration(context.address, context.tick - 1);
        }
      } },
    });
    const original = install(effectFixtureWork(owner()), effect, resources, 5);
    assert.throws(() => expireEffects(original, 10, resources, scope),
      failure === 'exception' ? /expiration failed/ : /must resolve its expired deadline/);
    assert.equal(instances(original)[0].state.layers, 3);
    assert.equal(instances(original)[0].expiresAtTick, 5);
    assert.equal(power(original), 130);
    for (const read of [
      () => escaped.instance,
      () => escaped.facts.getEffect(escaped.address),
      () => escaped.effects.setExpiration(escaped.address, 11),
      () => escaped.effects.update(escaped.address, effect.ref, state => state),
      () => escaped.effects.finish(escaped.address),
    ]) {
      assert.throws(read, /no longer active/);
    }
    fail = false;
    const retry = expireEffects(original, 10, resources, scope);
    assert.equal(instances(retry)[0].state.layers, 2);
    assert.equal(instances(retry)[0].expiresAtTick, 11);
    assert.equal(power(retry), 120);
    assert.throws(() => escaped.facts.getUnit(0), /no longer active/);
  }
});

test('effect expiry: a newly installed expired effect is visible to facts and waits for another pass', () => {
  const resources = new CombatResources();
  const calls = [];
  const newborn = resources.registerEffect(program('newborn'), {
    lifecycle: { expire: context => {
      calls.push('newborn');
      context.effects.finish(context.address);
    } },
  });
  let newbornAddress;
  const first = resources.registerEffect(program('installer'), {
    lifecycle: { expire: context => {
      calls.push('installer');
      const installed = context.effects.install(0, newborn.ref, {
        source: null, scope: null, expiresAtTick: context.tick,
      });
      assert.equal(installed.type, 'INSTALLED');
      newbornAddress = installed.address;
      assert.equal(context.facts.getEffect(newbornAddress).participating, true);
      context.effects.finish(context.address);
    } },
  });
  const original = install(effectFixtureWork(owner()), first, resources, 5);
  const firstPass = expireEffects(original, 5, resources);
  assert.deepEqual(calls, ['installer']);
  assert.equal(instances(firstPass).find(instance => instance.id === newbornAddress.instanceId).finished, false);
  const secondPass = expireEffects(firstPass, 5, resources);
  assert.deepEqual(calls, ['installer', 'newborn']);
  assert.equal(instances(secondPass).find(instance => instance.id === newbornAddress.instanceId).finished, true);
});

function runtimeScenario(failure) {
  const resources = new CombatResources();
  const fault = { enabled: failure !== undefined };
  const marker = resources.registerEffect(program('expiry-marker'));
  const effect = resources.registerEffect(program('runtime-expiry', { layers: 3 }), {
    contributions: [attack(instance => [modifier.create({ finalAddition: instance.state.layers * 10 })])],
    lifecycle: { expire: context => {
      context.effects.update(context.address, effect.ref, state => ({ layers: state.layers - 1 }));
      if (context.address.unitId === 0) {
        context.effects.install(0, marker.ref, { source: null, scope: null, expiresAtTick: null });
      }
      if (fault.enabled && context.address.unitId === 1) {
        if (failure === 'exception') {
          throw new Error('runtime expiration failed');
        }
      } else {
        context.effects.setExpiration(context.address, context.tick + 3);
      }
    } },
  });
  const sourceRef = createEffectSourceProgramRef('expiry-source');
  resources.effectSources.register({
    ref: sourceRef, initialize: () => ({}), ownState: state => state,
    selectInitial: ({ battlefield }) => battlefield.unitIds,
    install: () => effectSourceInstallation(effect.ref, { expiresAtTick: 0 }),
  });
  const source = createMechanismRuntime({
    id: 40, definition: createMechanismDefinition({ id: 'expiry-source' }), active: true,
    effectSource: resources.effectSources.create(sourceRef, { sourceUnitId: null }),
  });
  const tile = createTile({
    heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
  });
  const definition = { id: 'runtime-owner', offense: { attack: 100 } };
  const runtime = new BattleRuntime({
    map: createBattlefieldMap(1, 3, [tile, tile, tile]),
    initialUnits: [{ definition, position: [0, 0] }, { definition, position: [0, 1] }],
    schedule: { type: 'TIMELINE', spawns: [] },
    predefines: [{ id: 7, alias: null, initiallyPresent: false, creation: {
      type: 'UNIT', definition, position: [0, 2], navigationEffects: [],
    } }],
    initialMechanisms: [source], initialEffects: [], maxTicks: 10, moveMultiplier: 1,
    rngState: 17, nextUnitId: 0, nextNavigationRequestId: 0,
  }, { combat: resources });
  return { runtime, fault };
}

test('effect expiry: a runtime exception or invalid deadline discards the complete tick and retries cleanly', () => {
  for (const failure of ['exception', 'deadline']) {
    const failed = runtimeScenario(failure);
    const clean = runtimeScenario();
    const before = failed.runtime.snapshot();
    const maps = failed.runtime.navigationMaps;
    const commands = [{ type: 'APPEAR_PREDEFINED', definitionId: 7 }];
    assert.throws(() => failed.runtime.step(commands),
      failure === 'exception' ? /runtime expiration failed/ : /must resolve its expired deadline/);
    assert.deepEqual(failed.runtime.snapshot(), before);
    assert.equal(failed.runtime.navigationMaps, maps);
    assert.equal(before.execution.nextUnitId, 2);
    assert.deepEqual(before.units.map(unit => unit.effects.instances[0].state.layers), [3, 3]);
    failed.fault.enabled = false;
    assert.deepEqual(failed.runtime.step(commands), clean.runtime.step(commands));
    const after = failed.runtime.snapshot();
    assert.deepEqual(after, clean.runtime.snapshot());
    assert.equal(after.tickIndex, 1);
    assert.equal(after.execution.nextUnitId, 3);
    assert.deepEqual(after.units.slice(0, 2).map(unit => unit.effects.instances[0].state.layers), [2, 2]);
    assert.deepEqual(after.units.slice(0, 2).map(unit => unit.effects.instances[0].expiresAtTick), [3, 3]);
    assert.equal(after.units[0].effects.instances.length, 2);
    assert.equal(after.units[0].effects.nextInstanceId, 2);
  }
});
