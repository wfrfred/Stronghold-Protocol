import { effectTick } from "../../dist/core/tactical/unit/capability/effects/effect.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BattleRuntime } from '../../dist/core/tactical/battle/runtime.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { battlefieldView, getUnit } from '../../dist/core/tactical/battle/execution/context.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { createEffectDefinition } from '../../dist/core/tactical/unit/capability/effects/definition.js';
import { EffectDispatchScope } from '../../dist/core/tactical/unit/capability/effects/dispatch.js';
import {
  expireEffects,
  finalizeFinishedEffects,
  installNewEffect,
  setEffectEnabled,
} from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { attack } from '../../dist/core/tactical/unit/capability/offense/contributions.js';
import { resolveAttackPower } from '../../dist/core/tactical/unit/capability/offense/query.js';
import * as modifier from '../../dist/core/tactical/contribution/value.js';
import { effectFixtureWork } from '../helpers/effects.js';

const address = instanceId => ({ type: "EFFECT", unitId: 0, effectId: instanceId });
const instances = work => getUnit(work, 0).effects.instances;
const power = work => resolveAttackPower(0, battlefieldView(work));
const program = (id, initial = {}) => createEffectDefinition({
  id, initialize: () => initial,
});
const owner = () => initializeUnit({
  id: 0, position: [0, 0], definition: { id: 'expiry-owner', offense: { attack: 100 } },
});
const install = (work, effect, resources, expiresAtTick, initialState) => { installNewEffect(
  work, 0, effect,
  { source: 7, scopes: [{type: 'UNIT',unitId: 0}, ...(expiresAtTick === null ? [] : [{ type: 'TICK', tick: expiresAtTick }])], ...(initialState === undefined ? {} : { initialState }) },
  resources, 0,
); return work; };

test('effect expiry: the default notifies finish at the deadline and defers physical cleanup', () => {
  const resources = new CombatResources();
  const events = [];
  const effect = resources.registerEffect(program('default'), {
    contributions: [attack(() => [modifier.create({ finalAddition: 20 })])],
    lifecycle: {
      disable: context => { events.push(['disable', context.instance.finished]); },
      finish: context => { assert.deepEqual(context.end, { root: context.ref, reason: 'EXPIRED' }); events.push(['finish']); },
    },
  });
  const original = install(effectFixtureWork(owner()), effect, resources, 5);
  const before = original.battlefield.snapshot("draft");
  expireEffects(original, 4, resources);
  const finished = original;
  expireEffects(finished, 5, resources);
  assert.equal(power(finished), 100);
  assert.equal(instances(finished)[0].finished, true);
  assert.deepEqual(events, [['disable', true], ['finish']]);
  expireEffects(finished, 6, resources);
  const cleared = finished;
  finalizeFinishedEffects(cleared, 0, resources, 6);
  assert.deepEqual(instances(cleared), []);
  assert.deepEqual(events, [['disable', true], ['finish']]);
  assert.equal(before.getUnit(0).effects.instances[0].finished, false);
  assert.equal(resolveAttackPower(0, before), 120);
  for (const deadline of [null, 10]) {
    const untouched = install(effectFixtureWork(owner()), effect, resources, deadline);
    expireEffects(untouched, 5, resources);
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
            context.effects.finish([context.ref]);
          } } : {}),
        },
      });
      let work = install(effectFixtureWork(owner()), effect, resources, 5);
      if (inactive === 'disabled') {
        setEffectEnabled(work, address(0), false, resources, 1);
      } else {
        const winner = resources.registerEffect(program('winner'), {
          lifecycle: { competition: () => ({ group: 'expiry', priority: 2 }) },
        });
        work = install(work, winner, resources, null);
      }
      assert.equal(instances(work)[0].participating, false);
      const expired = work;
      expireEffects(expired, 5, resources);
      assert.equal(instances(expired)[0].finished, true);
      assert.deepEqual(calls, custom ? [[inactive !== 'disabled', false]] : []);
      assert.equal(power(expired), 100);
      setEffectEnabled(expired, address(0), true, resources, 6);
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
          context.effects.finish([address(1)]);
        } else {
          context.effects.setTick(address(1), change === 'renew' ? 12 : null);
        }
      } },
    });
    const later = resources.registerEffect(program('later'), {
      lifecycle: { expire: context => {
        calls.push('later');
        context.effects.finish([context.ref]);
      } },
    });
    let work = install(effectFixtureWork(owner()), first, resources, 5);
    work = install(work, later, resources, 5);
    const expired = work;
    expireEffects(expired, 5, resources);
    assert.deepEqual(calls, []);
    assert.equal(instances(expired)[0].finished, true);
    assert.equal(instances(expired)[1].finished, change === 'finish');
    assert.equal(effectTick(instances(expired)[1]), change === 'renew' ? 12 : change === 'clear' ? null : 5);
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
          context.effects.finish([context.ref]);
        } else {
          context.effects.setTick(context.ref, context.tick + context.instance.state.intervalTicks);
          context.effects.update(context.ref, effect, state => ({ ...state, layers: state.layers - 1 }));
          assert.equal(context.facts.getEffect(context.ref).state.layers, context.instance.state.layers);
          assert.equal(effectTick(context.facts.getEffect(context.ref)), context.tick + 4);
        }
      },
    },
  });
  const original = install(effectFixtureWork(owner()), effect, resources, 2);
  const initial = instances(original)[0];
  const initialView = original.battlefield.snapshot("draft");
  let work = original;
  expireEffects(work, 2, resources);
  assert.equal(power(work), 120);
  assert.equal(effectTick(instances(work)[0]), 6);
  expireEffects(work, 2, resources);
  expireEffects(work, 7, resources);
  assert.equal(expires, 2, 'an overdue deadline enters the callback once per pass');
  assert.equal(power(work), 110);
  assert.equal(effectTick(instances(work)[0]), 11);
  const remaining = instances(work)[0];
  for (const key of ['id', 'source', 'acquiredSequence', 'definition']) {
    assert.deepEqual(remaining[key], initial[key]);
  }
  assert.equal(instances(work).length, 1);
  assert.equal(starts, 1);
  assert.equal(enables, 1);
  expireEffects(work, 11, resources);
  assert.equal(instances(work)[0].finished, true);
  assert.equal(power(work), 100);
  assert.equal(expires, 3);
  assert.equal(initial.state.layers, 3);
  assert.equal(resolveAttackPower(0, initialView), 130);
});

test('effect expiry: clearing a deadline and nested terminal removal are normal outcomes', () => {
  for (const settlement of ['clear', 'remove']) {
    const resources = new CombatResources();
    const replacement = resources.registerEffect(program('replacement'));
    const effect = resources.registerEffect(program('normal-outcome', { count: 0 }), {
      lifecycle: { expire: context => {
        context.effects.update(context.ref, effect, () => ({ count: 1 }));
        if (settlement === 'clear') {
          context.effects.setTick(context.ref, null);
        } else {
          context.effects.finish([context.ref]);
          context.effects.install(0, replacement, { source: null, scopes: [] });
          assert.equal(context.facts.getEffect(context.ref), undefined);
          assert.equal(context.instance.finished, true);
          assert.equal(context.instance.state.count, 1);
        }
      } },
    });
    const original = install(effectFixtureWork(owner()), effect, resources, 5);
    const expired = original;
    expireEffects(expired, 5, resources);
    assert.equal(instances(expired).length, 1);
    assert.equal(effectTick(instances(expired)[0]), null);
    assert.equal(instances(expired)[0].finished, false);
    assert.equal(instances(expired)[0].definition, settlement === 'clear' ? effect : replacement);
  }
});

test('effect expiry: renewed deadlines and updated bindings are visible to participation successors', () => {
  const resources = new CombatResources();
  const observed = [];
  const observe = kind => context => {
    const layered = context.facts.getEffect(address(0));
    const unit = context.facts.getUnit(0);
    observed.push({
      kind, layers: layered.state.layers, deadline: effectTick(layered),
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
        context.effects.setTick(context.ref, context.tick + 5);
        context.effects.update(context.ref, layered, state => ({ layers: state.layers - 1 }));
      },
    },
  });
  const rival = resources.registerEffect(program('rival'), {
    contributions: [attack(() => [modifier.create({ finalAddition: 25 })])],
    lifecycle: { competition: () => ({ group: 'layers', priority: 2.5 }), enable: observe('enable') },
  });
  let work = install(effectFixtureWork(owner()), layered, resources, 5);
  work = install(work, rival, resources, null);
  const expired = work;
  expireEffects(expired, 5, resources);
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
          context.effects.update(context.ref, effect, state => ({ layers: state.layers - 1 }));
        }
        if (fail && failure === 'exception') {
          throw new Error('expiration failed');
        }
        if (!fail) {
          context.effects.setTick(context.ref, context.tick + 1);
        } else if (failure === 'overdue') {
          context.effects.setTick(context.ref, context.tick - 1);
        }
      } },
    });
    const original = install(effectFixtureWork(owner()), effect, resources, 5);
    original.battlefield.apply();
    assert.throws(() => expireEffects(original, 10, resources, scope),
      failure === 'exception' ? /expiration failed/ : /must resolve its expired deadline/);
    original.battlefield.drop();
    assert.equal(instances(original)[0].state.layers, 3);
    assert.equal(effectTick(instances(original)[0]), 5);
    assert.equal(power(original), 130);
    for (const read of [
      () => escaped.instance,
      () => escaped.facts.getEffect(escaped.ref),
      () => escaped.effects.setTick(escaped.ref, 11),
      () => escaped.effects.update(escaped.ref, effect, state => state),
      () => escaped.effects.finish([escaped.ref]),
    ]) {
      assert.throws(read, /no longer active/);
    }
    fail = false;
    const retry = original;
    expireEffects(retry, 10, resources, scope);
    assert.equal(instances(retry)[0].state.layers, 2);
    assert.equal(effectTick(instances(retry)[0]), 11);
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
      context.effects.finish([context.ref]);
    } },
  });
  let newbornAddress;
  const first = resources.registerEffect(program('installer'), {
    lifecycle: { expire: context => {
      calls.push('installer');
      const installed = context.effects.install(0, newborn, {
        source: null, scopes: [...(context.tick === null ? [] : [{ type: "TICK", tick: context.tick }])],
      });
      assert.equal(installed.type, 'INSTALLED');
      newbornAddress = installed.ref;
      assert.equal(context.facts.getEffect(newbornAddress).participating, true);
      context.effects.finish([context.ref]);
    } },
  });
  const original = install(effectFixtureWork(owner()), first, resources, 5);
  const firstPass = original;
  expireEffects(firstPass, 5, resources);
  assert.deepEqual(calls, ['installer']);
  assert.equal(instances(firstPass).find(instance => instance.id === newbornAddress.effectId).finished, false);
  const secondPass = firstPass;
  expireEffects(secondPass, 5, resources);
  assert.deepEqual(calls, ['installer', 'newborn']);
  assert.equal(instances(secondPass).find(instance => instance.id === newbornAddress.effectId).finished, true);
});

function runtimeScenario(failure) {
  const resources = new CombatResources();
  const fault = { enabled: failure !== undefined };
  const marker = resources.registerEffect(program('expiry-marker'));
  const effect = resources.registerEffect(program('runtime-expiry', { layers: 3 }), {
    contributions: [attack(instance => [modifier.create({ finalAddition: instance.state.layers * 10 })])],
    lifecycle: { expire: context => {
      context.effects.update(context.ref, effect, state => ({ layers: state.layers - 1 }));
      if (context.ref.unitId === 0) {
        context.effects.install(0, marker, { source: null, scopes: [] });
      }
      if (fault.enabled && context.ref.unitId === 1) {
        if (failure === 'exception') {
          throw new Error('runtime expiration failed');
        }
      } else {
        context.effects.setTick(context.ref, context.tick + 3);
      }
    } },
  });
  const tile = createTile({
    heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
  });
  const definition = { id: 'runtime-owner', offense: { attack: 100 } };
  const placement = (id, column) => {
    const state = effectFixtureWork(initializeUnit({ id, definition, position: [0, column] }));
    const installed = installNewEffect(state, id, effect,
      { source: null, scopes: [{ type: 'TICK', tick: 0 }] }, resources, 0);
    assert.equal(installed.type, 'INSTALLED');
    const unit = getUnit(state, id);
    return { definition, position: unit.position, states: {
      effects: unit.effects, offense: unit.offense,
    } };
  };
  const runtime = new BattleRuntime({
    map: createBattlefieldMap(1, 3, [tile, tile, tile]),
    initialUnits: [placement(0, 0), placement(1, 1)],
    schedule: { type: 'TIMELINE', spawns: [] },
    predefines: [{ id: 7, alias: null, initiallyPresent: false, creation: {
      type: 'UNIT', ...placement(2, 2), navigationModifiers: [],
    } }],
    initialMechanisms: [], initialNavigationModifiers: [], maxTicks: 10, routeMoveMultiplier: 1,
    rngState: 17,
  }, { combat: resources });
  return { runtime, fault };
}

test('effect expiry: a runtime exception or invalid deadline propagates without publishing the tick', () => {
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
    assert.equal(resolveAttackPower(0, { getUnit: id => before.units.find(unit => unit.id === id) }), 130);
    clean.runtime.step(commands);
    const after = clean.runtime.snapshot();
    assert.equal(after.tickIndex, 1);
    assert.equal(after.execution.nextUnitId, 3);
    assert.deepEqual(after.units.slice(0, 2).map(unit => unit.effects.instances[0].state.layers), [2, 2]);
    assert.deepEqual(after.units.slice(0, 2).map(unit => effectTick(unit.effects.instances[0])), [3, 3]);
    assert.equal(resolveAttackPower(0, { getUnit: id => after.units.find(unit => unit.id === id) }), 120);
    assert.equal(after.units[0].effects.instances.length, 2);
    assert.equal(after.units[0].effects.nextInstanceId, 2);
  }
});

test('effect expiry: shortening an initially future deadline waits for the next frozen pass', () => {
  const resources = new CombatResources();
  const calls = [];
  const first = resources.registerEffect(program('shortener'), {
    lifecycle: { expire: context => {
      calls.push('first');
      context.effects.setTick(address(1), 5);
      context.effects.finish([context.ref]);
    } },
  });
  const future = resources.registerEffect(program('future'), {
    lifecycle: { expire: context => { calls.push('future'); context.effects.finish([context.ref]); } },
  });
  let work = install(effectFixtureWork(owner()), first, resources, 5);
  work = install(work, future, resources, 10);
  expireEffects(work, 5, resources);
  assert.deepEqual(calls, ['first']);
  assert.equal(instances(work)[1].finished, false);
  expireEffects(work, 5, resources);
  assert.deepEqual(calls, ['first', 'future']);
  assert.equal(instances(work)[1].finished, true);
});
