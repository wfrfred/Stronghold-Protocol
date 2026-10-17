import { fixtureBattle } from "../helpers/unit.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  ELEMENT_TYPES,
  createDefinition as createElementalDefinition,
  elementValues,
  hasElemental,
  initialize as initializeElementalState,
  setContribution,
  setDamageHook,
  removeDamageHook,
  setHook,
  removeHook,
  setRule,
} from '../../dist/core/tactical/unit/capability/elemental/capability.js';
import * as elemental from '../../dist/core/tactical/unit/capability/elemental/operations.js';
import { get as getBurst, resolveBurstRecoverySpeed, resolveDamageResistance } from '../../dist/core/tactical/unit/capability/elemental/query.js';
import {
  createArknightsElementalDefinition,
  getArknightsElementalBurstProfile,
  parseElementType,
} from '../../dist/data/arknights/elemental.js';
import { initialize } from "../helpers/unit.js";
import { get, ref } from '../../dist/core/tactical/unit/query.js';
import { transitionUnit } from '../../dist/core/tactical/battle/state.js';
import { leave } from '../../dist/core/tactical/battle/execution/unit.js';
import { create as modifier } from '../../dist/core/tactical/unit/contribution/attribute.js';
import * as effects from '../../dist/core/tactical/unit/effect/operations.js';
import { effectFixtureWork } from '../helpers/effects.js';

const simpleBursts = (program = {}) => Object.fromEntries(ELEMENT_TYPES.map(type => [type, {
  durationTicks: 300,
  onStart: battle => battle,
  ...program,
}]));
const holder = (options = {}, extras = {}) => initialize({
  id: 1,
  position: [0, 0],
  definition: {
    id: 'element-holder',
    allegiance: { side: 'ALLY' },
    elemental: createArknightsElementalDefinition({ receiver: 'CHARACTER', ...options }),
    ...extras,
  },
});
const fixture = (options = {}, program = {}) => {
  const unit = holder({}, { elemental: createElementalDefinition({ maxEp: 1000, bursts: simpleBursts(program), ...options }) });
  return { battle: effectFixtureWork(unit), target: ref(unit) };
};
const request = (type = 'BURN', power = 100, source = { id: 9 }) => ({ type, power, source });
const change = (battle, target, update) => transitionUnit(battle, target.id, unit => ({ ...unit, elemental: update(unit.elemental) }));
const hook = (id, invoke, accepts = () => true) => ({ id, accepts, invoke });
const at = (battle, tick) => ({ ...battle, tick });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('Elemental owns immutable bars and initializes its clock without a recovery timer', () => {
  const definition = createElementalDefinition({ maxEp: 1000, bursts: simpleBursts() });
  const state = initializeElementalState(fixtureBattle(7), definition).value;
  assert.deepEqual(state.ep, elementValues(1000));
  assert.equal(state.lastAdvancedTick, 7);
  assert.equal(state.burst, null);
  assert.equal(definition.recoveryPerSecond, 0);
  assert.equal(definition.burstRecoverySpeed, 1);
  assert.equal(Object.isFrozen(definition.bursts), true);
  const f = fixture();
  assert.equal(hasElemental(get(f.battle, f.target)), true);
  const result = elemental.damage(f.battle, f.target, request());
  assert.equal(result.value.type, 'APPLIED');
  assert.equal(result.value.amount, 100);
  assert.equal(get(result.state, f.target).elemental.ep.BURN, 900);
  assert.equal(get(f.battle, f.target).elemental.ep.BURN, 1000);
  assert.equal(get(result.state, f.target).definition, get(f.battle, f.target).definition);
});

test('EP bars retain independent partial loss and resistance has a five percent floor independent of HP resistance', () => {
  const f = fixture();
  let battle = f.battle;
  for (const type of ELEMENT_TYPES) battle = elemental.damage(battle, f.target, request(type, 200)).state;
  assert.deepEqual(get(battle, f.target).elemental.ep, elementValues(800));
  battle = elemental.damage(battle, f.target, request('NECROSIS', 50)).state;
  assert.equal(get(battle, f.target).elemental.ep.NECROSIS, 750);
  for (const [elementResistance, expected] of [[0, 100], [50, 50], [100, 5], [500, 5], [-50, 100]]) {
    const current = fixture({ elementResistance, damageResistance: 100 });
    const result = elemental.damage(current.battle, current.target, request('EROSION'));
    near(result.value.amount, expected);
    assert.equal(get(result.state, current.target).elemental.ep.EROSION, 1000 - expected);
    assert.equal(resolveDamageResistance(result.state, current.target), 95);
  }
});

test('a burst has a stable identity, locks reception, preserves source and resets all bars on completion', () => {
  const f = fixture();
  const damaged = elemental.damage(f.battle, f.target, request('NEURAL', 400)).state;
  const result = elemental.damage(at(damaged, 4), f.target, request('BURN', 1500));
  assert.equal(result.value.type, 'APPLIED');
  assert.equal(result.value.amount, 1000);
  const burst = getBurst(result.state, result.value.burst);
  assert.equal(burst.type, 'BURN');
  assert.deepEqual(burst.source, { id: 9 });
  assert.deepEqual(burst.host, f.target);
  assert.equal(burst.startedAtTick, 4);
  assert.equal(burst.remainingTicks, 300);
  for (const type of ELEMENT_TYPES) assert.equal(elemental.damage(result.state, f.target, request(type)).value.type, 'REJECTED');
  assert.equal(elemental.heal(result.state, f.target, { source: null, power: 100 }).value.type, 'REJECTED');
  const halfway = elemental.advance(at(result.state, 154), f.target);
  assert.equal(getBurst(halfway, result.value.burst).remainingTicks, 150);
  assert.deepEqual(get(halfway, f.target).elemental.ep, get(result.state, f.target).elemental.ep);
  const completed = elemental.advance(at(halfway, 304), f.target);
  assert.equal(getBurst(completed, result.value.burst), undefined);
  assert.equal(get(completed, f.target).elemental.burst, null);
  assert.deepEqual(get(completed, f.target).elemental.ep, elementValues(1000));
  const next = elemental.damage(completed, f.target, request('EROSION', 1000));
  assert.notEqual(next.value.burst.id, result.value.burst.id);
  assert.equal(elemental.finish(next.state, result.value.burst), next.state);
  assert.equal(elemental.cancel(next.state, result.value.burst, 'OLD'), next.state);
  assert.equal(getBurst(next.state, next.value.burst).status, 'ACTIVE');
});

test('elemental healing applies the full amount independently to every bar and reports settled facts', () => {
  const f = fixture();
  let battle = elemental.damage(f.battle, f.target, request('NEURAL', 200)).state;
  battle = elemental.damage(battle, f.target, request('EROSION', 80)).state;
  battle = elemental.damage(battle, f.target, request('NECROSIS', 300)).state;
  let report;
  battle = change(battle, f.target, state => setHook(state, 'healed', hook('observe', (current, { event }) => { report = event; return { state: current, value: undefined }; })));
  const result = elemental.heal(battle, f.target, { source: null, power: 150 });
  assert.equal(result.value.type, 'APPLIED');
  assert.deepEqual(result.value.amounts, { NEURAL: 150, EROSION: 80, BURN: 0, NECROSIS: 150 });
  assert.deepEqual(report.amounts, result.value.amounts);
  assert.deepEqual(report.current, { NEURAL: 950, EROSION: 1000, BURN: 1000, NECROSIS: 850 });
});

test('receiving an immune request is observable while actual damage is absent and healing is allowed', () => {
  const f = fixture();
  const seen = [];
  let battle = elemental.damage(f.battle, f.target, request('BURN', 100)).state;
  battle = change(battle, f.target, state => setRule(state, { id: 'immune', allowsDamage: () => false }));
  battle = change(battle, f.target, state => setHook(setHook(state, 'received', hook('received', (current, { event }) => {
    seen.push(['received', event.request.power]); return { state: current, value: undefined };
  })), 'damaged', hook('damaged', (current) => { seen.push('damaged'); return { state: current, value: undefined }; })));
  const denied = elemental.damage(battle, f.target, request());
  assert.equal(denied.value.type, 'REJECTED');
  assert.deepEqual(seen, [['received', 100]]);
  assert.equal(get(denied.state, f.target).elemental.ep.BURN, 900);
  const healed = elemental.heal(denied.state, f.target, { source: null, power: 50 });
  assert.equal(healed.value.type, 'APPLIED');
  assert.equal(get(healed.state, f.target).elemental.ep.BURN, 950);
});

test('received Hook may remove the host before settlement without publishing damage from a stale Unit', () => {
  const f = fixture();
  let damaged = false;
  let battle = change(f.battle, f.target, state => setHook(state, 'received', hook('remove-host', (current, { host }) => {
      const self = get(current, host);
return { state: leave(current, self.id, "DEATH"), value: undefined }; })));
  battle = change(battle, f.target, state => setHook(state, 'damaged', hook('observe', (current) => { damaged = true; return { state: current, value: undefined }; })));
  const result = elemental.damage(battle, f.target, request('BURN', 1000));
  assert.equal(result.value.type, 'REJECTED');
  assert.equal(get(result.state, f.target), undefined);
  assert.equal(damaged, false);
  assert.equal(result.state.events.some(event => event.type === 'ELEMENT_DAMAGE'), false);
});

test('request-specific damage Hooks can reduce one element without changing common resistance', () => {
  const f = fixture();
  const battle = change(f.battle, f.target, state => setDamageHook(state, {
    id: 'erosion-reduction',
    accepts: () => true,
    invoke: (current, { request }, amount) => ({ state: current, value: amount * (request.type === 'EROSION' ? 0.5 : 1) }),
  }));
  assert.equal(elemental.damage(battle, f.target, request('EROSION')).value.amount, 50);
  assert.equal(elemental.damage(battle, f.target, request('BURN')).value.amount, 100);
});

const epShield = (id, budget) => ({
  id,
  initialize: () => ({ remaining: budget }),
  onEnable(battle, context) {
    const address = context.ref;
    return change(battle, address.host, state => setDamageHook(state, {
      id: `shield/${address.id}`,
      accepts: current => {
        const self = effects.get(current, address);
        return self?.status === 'ACTIVE' && self.data.remaining > 0;
      },
      invoke(current, _context, amount) {
        const self = effects.get(current, address);
        const blocked = Math.min(amount, self.data.remaining);
        current = effects.replaceEffect(current, address, {
          ...self,
          data: { remaining: self.data.remaining - blocked },
        });
        return { state: current, value: amount - blocked };
      },
    }));
  },
  onDisable(battle, context) {
    return change(battle, context.ref.host, state => removeDamageHook(state, `shield/${context.ref.id}`));
  },
});

test('Effects compose EP shields after resistance, retain their own budgets and unregister on disable', () => {
  const f = fixture({ elementResistance: 50 });
  const first = effects.install(f.battle, f.target, epShield('first-shield', 30));
  const second = effects.install(first.state, f.target, epShield('second-shield', 40));
  const original = second.state;
  let result = elemental.damage(original, f.target, request());
  assert.equal(result.value.amount, 0);
  assert.equal(effects.get(result.state, first.value).data.remaining, 0);
  assert.equal(effects.get(result.state, second.value).data.remaining, 20);
  assert.equal(effects.get(original, first.value).data.remaining, 30);
  assert.equal(get(result.state, f.target).elemental.ep.BURN, 1000);
  result = elemental.damage(result.state, f.target, request());
  assert.equal(result.value.amount, 30);
  assert.equal(get(result.state, f.target).elemental.ep.BURN, 970);
  const disabled = effects.setEnabled(original, first.value, false);
  result = elemental.damage(disabled, f.target, request());
  assert.equal(result.value.amount, 10);
  assert.equal(effects.get(result.state, first.value).data.remaining, 30);
  assert.equal(effects.get(result.state, second.value).data.remaining, 0);
});

test('nested EP damage consumes a shared Effect shield before the outer reception continues', () => {
  const f = fixture();
  const prepared = change(f.battle, f.target, state => setDamageHook(state, {
    id: 'nested-damage',
    accepts: () => true,
    invoke(battle, { host, request: incoming }, amount) {
      if (incoming.power === 100) {
        battle = elemental.damage(battle, host, request('BURN', 60)).state;
      }
      return { state: battle, value: amount };
    },
  }));
  const installed = effects.install(prepared, f.target, epShield('shared-shield', 100));
  const result = elemental.damage(installed.state, f.target, request());
  assert.equal(result.value.amount, 60);
  assert.equal(effects.get(result.state, installed.value).data.remaining, 0);
  assert.equal(get(result.state, f.target).elemental.ep.BURN, 940);
  assert.deepEqual(result.state.events.filter(event => event.type === 'ELEMENT_DAMAGE').map(event => event.amount), [60]);
});

test('EP reception rereads Hook registrations and nested damage uses fresh candidates and current bars', () => {
  const f = fixture();
  const seen = [];
  const reduction = id => ({
    id,
    accepts: () => true,
    invoke: (battle, { request }, amount) => {
      seen.push([id, request.power]);
      return { state: battle, value: amount / 2 };
    },
  });
  let battle = change(f.battle, f.target, state => setDamageHook(state, {
    id: 'first',
    accepts: () => true,
    invoke(current, { host, request: incoming }, amount) {
      seen.push(['first', incoming.power]);
      if (incoming.power === 100) {
        current = change(current, host, state => setDamageHook(setDamageHook(state, reduction('second')), reduction('third')));
        current = elemental.damage(current, host, request('BURN', 10)).state;
      }
      return { state: current, value: amount };
    },
  }));
  battle = change(battle, f.target, state => setDamageHook(state, {
    id: 'second',
    accepts: () => false,
    invoke: () => { throw new Error('stale Hook'); },
  }));
  const result = elemental.damage(battle, f.target, request());
  assert.deepEqual(seen, [['first', 100], ['first', 10], ['second', 10], ['third', 10], ['second', 100]]);
  assert.equal(result.value.amount, 50);
  assert.equal(get(result.state, f.target).elemental.ep.BURN, 947.5);
});

test('EP reception stops when a damage Hook removes the host', () => {
  const f = fixture();
  let battle = change(f.battle, f.target, state => setDamageHook(state, {
    id: 'leave',
    accepts: () => true,
    invoke: (current, { host }, amount) => ({ state: leave(current, host.id, "DEATH"), value: amount }),
  }));
  battle = change(battle, f.target, state => setDamageHook(state, {
    id: 'unreachable',
    accepts: () => true,
    invoke: () => { throw new Error('removed host'); },
  }));
  const result = elemental.damage(battle, f.target, request());
  assert.equal(result.value.type, 'REJECTED');
  assert.equal(get(result.state, f.target), undefined);
  assert.equal(result.state.events.some(event => event.type === 'ELEMENT_DAMAGE'), false);
});

test('burstStarted precedes damage observers and onStart rereads after nested cancellation', () => {
  const seen = [];
  const f = fixture({}, { onStart: battle => { seen.push('program'); return battle; } });
  let battle = change(f.battle, f.target, state => setHook(state, 'burstStarted', hook('start', (current, { event: burst }) => {
    seen.push('started'); return { state: elemental.cancel(current, burst, 'NESTED'), value: undefined };
  })));
  battle = change(battle, f.target, state => setHook(state, 'burstEnded', hook('end', (current, { event }) => {
    seen.push(['ended', event.end]); return { state: current, value: undefined };
  })));
  battle = change(battle, f.target, state => setHook(state, 'damaged', hook('damage', (current, { event }) => {
    seen.push(['damaged', event.amount]); return { state: current, value: undefined };
  })));
  elemental.damage(battle, f.target, request('BURN', 1000));
  assert.deepEqual(seen, ['started', ['ended', { type: 'CANCELLED', reason: 'NESTED' }], ['damaged', 1000]]);
});

test('reentrant replacement Burst does not authorize the previous Burst startup program', () => {
  const started = [];
  const f = fixture({}, { onStart: (battle, self) => { started.push(self.type); return battle; } });
  const battle = change(f.battle, f.target, state => setHook(state, 'burstStarted', hook('replace', (current, { event: burst }) => {
    if (burst.type !== 'BURN') return { state: current, value: undefined };
    current = elemental.cancel(current, burst, 'REPLACED');
    return { state: elemental.damage(current, f.target, request('NEURAL', 1000)).state, value: undefined };
  })));
  const result = elemental.damage(battle, f.target, request('BURN', 1000));
  assert.deepEqual(started, ['NEURAL']);
  assert.equal(getBurst(result.state, result.value.burst), undefined);
  assert.equal(get(result.state, f.target).elemental.burst.type, 'NEURAL');
});

test('burst onEnd observes ENDING and full cancellation reason; dependent Effects end while permanent Effects survive', () => {
  const seen = [];
  const f = fixture({}, { onEnd: (battle, self, end) => {
    seen.push([self.status, end, elemental.damage(battle, self.host, request()).value.type]); return battle;
  } });
  const result = elemental.damage(f.battle, f.target, request('BURN', 1000));
  const bound = effects.install(result.state, f.target, { id: 'bound', initialize: () => ({}) }, { scopes: [{ type: 'ELEMENTAL_BURST', ref: result.value.burst }] });
  const permanent = effects.install(bound.state, f.target, { id: 'permanent', initialize: () => ({}) });
  const ended = elemental.cancel(permanent.state, result.value.burst, 'CONTENT');
  assert.deepEqual(seen, [['ENDING', { type: 'CANCELLED', reason: 'CONTENT' }, 'REJECTED']]);
  assert.equal(effects.get(ended, bound.value), undefined);
  assert.equal(effects.get(ended, permanent.value).status, 'ACTIVE');
});

test('normal completion reports FINISHED and host departure closes an active Burst with its actual reason', () => {
  const seen = [];
  const f = fixture({}, { onEnd: (battle, _self, end) => { seen.push(end); return battle; } });
  let result = elemental.damage(f.battle, f.target, request('BURN', 1000));
  let battle = elemental.finish(result.state, result.value.burst);
  assert.deepEqual(seen, [{ type: 'FINISHED' }]);
  result = elemental.damage(battle, f.target, request('BURN', 1000));
  battle = leave(result.state, f.target.id, "DEATH");
  assert.deepEqual(seen, [{ type: 'FINISHED' }, { type: 'CANCELLED', reason: 'DEATH' }]);
  assert.equal(get(battle, f.target), undefined);
  assert.equal(getBurst(battle, result.value.burst), undefined);
});

test('nested host departure during onEnd cannot resurrect the ending Unit or Burst', () => {
  let calls = 0;
  const f = fixture({}, { onEnd: (battle, self) => { calls++; return leave(battle, self.host.id, "DEATH"); } });
  const result = elemental.damage(f.battle, f.target, request('BURN', 1000));
  const ended = elemental.finish(result.state, result.value.burst);
  assert.equal(calls, 1);
  assert.equal(get(ended, f.target), undefined);
  assert.equal(getBurst(ended, result.value.burst), undefined);
});

test('dynamic burst speed preserves elapsed budget and zero speed does not accumulate deferred progress', () => {
  const f = fixture();
  const result = elemental.damage(f.battle, f.target, request('BURN', 1000));
  let battle = elemental.advance(at(result.state, 60), f.target);
  assert.equal(getBurst(battle, result.value.burst).remainingTicks, 240);
  battle = change(battle, f.target, state => setContribution(state, 'burstRecoverySpeed', { id: 'speed', value: [modifier({ finalScaler: 0 })] }));
  battle = elemental.advance(at(battle, 1000), f.target);
  assert.equal(getBurst(battle, result.value.burst).remainingTicks, 240);
  assert.equal(get(battle, f.target).elemental.lastAdvancedTick, 1000);
  battle = change(battle, f.target, state => setContribution(state, 'burstRecoverySpeed', { id: 'speed', value: [modifier({ finalScaler: 2 })] }));
  assert.equal(resolveBurstRecoverySpeed(battle, f.target), 2);
  battle = elemental.advance(at(battle, 1060), f.target);
  assert.equal(getBurst(battle, result.value.burst).remainingTicks, 120);
  battle = elemental.advance(at(battle, 1120), f.target);
  assert.equal(getBurst(battle, result.value.burst), undefined);
});

test('natural recovery preserves fractional EP and never accumulates a full-bar healing budget', () => {
  const f = fixture({ recoveryPerSecond: 15 });
  let battle = elemental.advance(at(f.battle, 1000), f.target);
  battle = elemental.damage(battle, f.target, request('BURN', 100)).state;
  battle = elemental.advance(at(battle, 1001), f.target);
  assert.equal(get(battle, f.target).elemental.ep.BURN, 900.5);
  assert.equal(get(battle, f.target).elemental.ep.NEURAL, 1000);
  assert.deepEqual(get(elemental.advance(battle, f.target), f.target).elemental.ep, get(battle, f.target).elemental.ep);
});

test('ordinary damage and healing before the scheduled advance do not consume natural recovery time', () => {
  const f = fixture({ recoveryPerSecond: 30 });
  let battle = elemental.damage(f.battle, f.target, request('BURN', 100)).state;
  for (let tick = 1; tick <= 10; tick++) {
    battle = at(battle, tick);
    battle = elemental.damage(battle, f.target, request('BURN', 2)).state;
    battle = elemental.heal(battle, f.target, { source: null, power: 0.5 }).state;
    battle = elemental.advance(battle, f.target);
  }
  assert.equal(get(battle, f.target).elemental.ep.BURN, 895);
  assert.equal(get(battle, f.target).elemental.lastAdvancedTick, 10);
});

for (const accepts of [true, false]) {
  test(`elemental Hook replacement uses latest implementation and accepts=${accepts}`, () => {
    const f = fixture();
    const seen = [];
    const replacement = hook('B', (battle) => { seen.push('new B'); return { state: battle, value: undefined }; }, () => accepts);
    let battle = change(f.battle, f.target, state => setHook(state, 'damaged', hook('A', (current) => {
      seen.push('A'); return { state: change(current, f.target, state => setHook(state, 'damaged', replacement)), value: undefined };
    })));
    battle = change(battle, f.target, state => setHook(state, 'damaged', hook('B', (current) => { seen.push('old B'); return { state: current, value: undefined }; })));
    elemental.damage(battle, f.target, request());
    assert.deepEqual(seen, ['A', ...(accepts ? ['new B'] : [])]);
  });
}

test('nested elemental dispatch selects current IDs while outer facts and candidate IDs stay fixed', () => {
  const f = fixture();
  const seen = [];
  const added = hook('C', (battle, { event }) => { seen.push(['C', event.previous, event.current]); return { state: battle, value: undefined }; });
  let battle = change(f.battle, f.target, state => setHook(state, 'damaged', hook('A', (current, { host, event }) => {
      const self = get(current, host);

    seen.push(['A', event.previous, event.current]);
    if (event.previous !== 1000) return { state: current, value: undefined };
    current = change(current, f.target, state => setHook(state, 'damaged', added));
    return { state: elemental.damage(current, ref(self), request('BURN', 100)).state, value: undefined };
  })));
  battle = change(battle, f.target, state => setHook(state, 'damaged', hook('B', (current, { event }) => { seen.push(['B', event.previous, event.current]); return { state: current, value: undefined }; })));
  elemental.damage(battle, f.target, request());
  assert.deepEqual(seen, [['A', 1000, 900], ['A', 900, 800], ['B', 900, 800], ['C', 900, 800], ['B', 1000, 900]]);
});

test('elemental dispatch skips removed candidate IDs', () => {
  const f = fixture();
  const seen = [];
  let battle = change(f.battle, f.target, state => setHook(state, 'damaged', hook('A', (current) => {
    seen.push('A'); return { state: change(current, f.target, state => removeHook(state, 'damaged', 'B')), value: undefined };
  })));
  battle = change(battle, f.target, state => setHook(state, 'damaged', hook('B', (current) => { seen.push('B'); return { state: current, value: undefined }; })));
  elemental.damage(battle, f.target, request());
  assert.deepEqual(seen, ['A']);
});

test('raw element identities preserve the four supported native types and reject NONE, ANGER and guessed aliases', () => {
  for (const [index, raw, type] of [
    [1, 'SANITY', 'NEURAL'], [2, 'WATER', 'EROSION'], [3, 'FIRE', 'BURN'], [4, 'DARK', 'NECROSIS'],
  ]) {
    assert.equal(parseElementType(index), type);
    assert.equal(parseElementType(raw), type);
  }
  for (const value of [0, 5, 'NONE', 'ANGER', 'fire', 'BURN']) assert.throws(() => parseElementType(value), TypeError);
});

test('standard burst profiles distinguish receiver class, boss threshold, ordinary damage and elemental HP damage', () => {
  const character = ELEMENT_TYPES.map(type => getArknightsElementalBurstProfile('CHARACTER', type));
  const enemy = ELEMENT_TYPES.map(type => getArknightsElementalBurstProfile('ENEMY', type));
  assert.deepEqual(character.map(p => p.durationTicks), [300, 300, 300, 450]);
  assert.deepEqual(enemy.map(p => p.durationTicks), [300, 240, 300, 450]);
  assert.deepEqual(character.map(p => p.burstDamage), [
    { type: 'TRUE', power: 1000 }, { type: 'PHYSICAL', power: 800 }, { type: 'ARTS', power: 1200 }, null,
  ]);
  assert.deepEqual(enemy.map(p => p.burstDamage), [
    { type: 'ELEMENTAL', power: 6000 }, { type: 'ELEMENTAL', power: 5000 }, { type: 'ELEMENTAL', power: 7000 }, null,
  ]);
  assert.equal(character[1].defReduction, 100);
  assert.equal(enemy[1].defReduction, 120);
  assert.equal(character[2].resReduction, 20);
  assert.equal(enemy[2].resReduction, 20);
  assert.equal(character[0].stunTicks, 300);
  assert.equal(enemy[0].paralysisStacks, 3);
  assert.deepEqual(character[3].damagePerSecond, { type: 'ARTS', power: 100 });
  assert.deepEqual(enemy[3].damagePerSecond, { type: 'ELEMENTAL', power: 800 });
  assert.equal(character[3].spDrainPerSecond, 1);
  assert.equal(character[3].blocksSkill, true);
  assert.equal(character[3].blocksSpRecovery, true);
  assert.equal(enemy[3].attackReductionRatio, 0.5);
  assert.equal(holder({ receiver: 'ENEMY', boss: true }).definition.elemental.maxEp, 2000);
  assert.equal(holder({ receiver: 'CHARACTER', boss: true }).definition.elemental.maxEp, 1000);
  assert.ok(Object.isFrozen(enemy[0].burstDamage));
  assert.throws(() => createElementalDefinition({
    maxEp: 0, bursts: simpleBursts(),
  }), RangeError);
});

test('standard elemental profiles match the extracted client EPBreakBuffDB, BuffData and prefab damage nodes', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/arknights-elemental-buffs.json', import.meta.url), 'utf8'));
  const rawDamageType = { PURE: 'TRUE', PHYSICAL: 'PHYSICAL', MAGICAL: 'ARTS', ELEMENT: 'ELEMENTAL' };
  const blackboard = key => new Map(fixture.buffData[key].blackboard.map(entry => [entry.key, entry.value]));
  const damageNode = key => fixture.buffTemplates.find(entry => entry.record.templateKey === key).record.eventToActions._items
    .flatMap(entry => JSON.parse(entry.value.SerializedState))
    .find(node => node.$type === 'Torappu.Battle.Action.Nodes+NoSourceDamage');
  for (const [raw, type] of [['SANITY', 'NEURAL'], ['WATER', 'EROSION'], ['FIRE', 'BURN'], ['DARK', 'NECROSIS']]) {
    const breakData = fixture.epBreakData[raw];
    for (const receiver of ['CHARACTER', 'ENEMY']) {
      const selected = getArknightsElementalBurstProfile(receiver, type);
      const suffix = receiver === 'CHARACTER' ? 'char' : 'enemy';
      const buffKey = `${breakData.elementBuffs[0]}_${suffix}`;
      const values = blackboard(buffKey);
      assert.equal(selected.durationTicks, 30 * breakData[receiver === 'CHARACTER' ? 'elementBreakDuration' : 'enemyElementBreakDuration']);
      if (raw !== 'DARK') {
        const node = damageNode(buffKey);
        assert.deepEqual(selected.burstDamage, { type: rawDamageType[node._damageType], power: values.get(node._damageKey) });
        assert.equal(node._ignoreForSp, false);
      } else {
        const node = damageNode(receiver === 'CHARACTER' ? 'periodic_magic_damage' : 'periodic_element_damage');
        assert.deepEqual(selected.damagePerSecond, { type: rawDamageType[node._damageType], power: values.get('damage') / values.get('interval') });
        assert.equal(node._ignoreForSp, true);
      }
    }
  }
  assert.equal(getArknightsElementalBurstProfile('CHARACTER', 'NEURAL').stunTicks, 30 * blackboard('ep_break_sanity_char').get('stun'));
  assert.equal(getArknightsElementalBurstProfile('ENEMY', 'NEURAL').paralysisStacks, blackboard('ep_break_sanity_enemy').get('palsy_stack_cnt'));
  assert.equal(getArknightsElementalBurstProfile('CHARACTER', 'EROSION').defReduction, -blackboard('ep_break_water_char').get('def'));
  assert.equal(getArknightsElementalBurstProfile('ENEMY', 'EROSION').defReduction, -fixture.buffData.ep_break_water_enemy.attributes.attributeModifiers[0].value);
  assert.equal(fixture.buffData.ep_break_water_enemy.isDurableBuff, true);
  assert.equal(getArknightsElementalBurstProfile('CHARACTER', 'BURN').resReduction, -blackboard('ep_break_fire_char').get('magic_resistance'));
  assert.equal(getArknightsElementalBurstProfile('ENEMY', 'BURN').resReduction, -fixture.buffData.ep_break_fire_enemy.attributes.attributeModifiers[0].value);
  assert.equal(getArknightsElementalBurstProfile('CHARACTER', 'NECROSIS').spDrainPerSecond, -blackboard('ep_break_dark_char').get('sp'));
  assert.equal(getArknightsElementalBurstProfile('ENEMY', 'NECROSIS').attackReductionRatio, -blackboard('ep_break_dark_enemy').get('atk_down'));
});


test('burst replacement preserves the original notification context for remaining observers', () => {
  const f = fixture();
  const seen = [];
  let original;
  let battle = change(f.battle, f.target, state => setHook(state, 'burstStarted', {
    id: 'replace',
    invoke(current, context) {
      if (context.event.type === 'BURN') {
        original = context;
        current = elemental.cancel(current, context.event, 'REPLACED');
        current = elemental.damage(current, context.host, request('NEURAL', 1000)).state;
      }
      return { state: current, value: undefined };
    },
  }));
  battle = change(battle, f.target, state => setHook(state, 'burstStarted', {
    id: 'observe',
    invoke(current, context) {
      if (context.event.type === 'BURN') assert.equal(context, original);
      const active = get(current, context.host).elemental.burst;
      seen.push([context.event.type, context.event.status, active.type]);
      return { state: current, value: undefined };
    },
  }));
  elemental.damage(battle, f.target, request('BURN', 1000));
  assert.deepEqual(seen, [['NEURAL', 'ACTIVE', 'NEURAL'], ['BURN', 'ACTIVE', 'NEURAL']]);
});

test('EP damage hooks pass the latest battle and amount while retaining their fixed context', () => {
  const f = fixture();
  const incoming = request();
  let original;
  let battle = change(f.battle, f.target, state => setDamageHook(state, {
    id: 'first',
    invoke(current, context, amount) {
      original = context;
      assert.equal(context.request, incoming);
      return { state: at(current, 1), value: amount - 30 };
    },
  }));
  battle = change(battle, f.target, state => setDamageHook(state, {
    id: 'second',
    accepts(current, context, amount) {
      assert.equal(context, original);
      assert.equal(current.tick, 1);
      assert.equal(amount, 70);
      return true;
    },
    invoke(current, context, amount) {
      assert.equal(context, original);
      assert.equal(current.tick, 1);
      return { state: at(current, 2), value: amount / 2 };
    },
  }));
  const result = elemental.damage(battle, f.target, incoming);
  assert.equal(result.state.tick, 2);
  assert.equal(result.value.amount, 35);
  assert.equal(get(result.state, f.target).elemental.ep.BURN, 965);
  assert.equal(f.battle.tick, 0);
});
