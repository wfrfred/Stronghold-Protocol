import { effectTick } from "../../dist/core/tactical/unit/capability/effects/instance.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileBuffStacking, parseBuffStacking } from '../../dist/data/arknights/buff-stacking.js';
import { compileAttributeModifiers, parseAttributeModifiers } from '../../dist/data/arknights/modifier.js';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { battlefieldView, getUnit } from '../../dist/core/tactical/battle/execution/context.js';
import { createEffectProgram } from '../../dist/core/tactical/unit/capability/effects/program.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { attack } from '../../dist/core/tactical/unit/capability/offense/contributions.js';
import { resolveAttackPower } from '../../dist/core/tactical/unit/capability/offense/query.js';
import { defense } from '../../dist/core/tactical/unit/capability/defense/contributions.js';
import { resolveDefense } from '../../dist/core/tactical/unit/capability/defense/query.js';
import { installNewEffect, updateEffectState, setEffectTick, setEffectEnabled, finishEffects, expireEffects } from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { EffectDispatchScope } from '../../dist/core/tactical/unit/capability/effects/dispatch.js';
import { effectFixtureWork } from '../helpers/effects.js';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/arknights/buff_stacking.json', import.meta.url)));
const raw = fixtures.fixtures.find(entry => entry.templateKey === 'astesi_t_1').buff;
const close = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-9, `${value} ≈ ${expected}`);

test('Buff contribution integration: the native Astesia DEF facet merges layers, preserves the first blackboard and source, and renews its instance', () => {
  const policy = compileBuffStacking(parseBuffStacking(raw));
  const [compiled] = compileAttributeModifiers(parseAttributeModifiers(raw.attributes.attributeModifiers).filter(entry => entry.attributeType === 'DEF'));
  const resources = new CombatResources();
  let starts = 0;
  const program = resources.registerEffect(createEffectProgram({
    id: raw.buffKey,
    initialize: () => ({ stackCount: 1, defenseRatio: 0.2 }),
    ownState: state => ({ ...state }),
  }), {
    contributions: [defense(instance => {
      const value = compiled.sample({
        blackboard: new Map([['def', instance.state.defenseRatio]]),
        stackCount: policy.validStackCount(instance.state.stackCount),
        readSourceAttribute: () => undefined,
      });
      return value === undefined ? [] : [value];
    })],
    lifecycle: { start: () => { starts++; } },
  });
  let work = effectFixtureWork(initializeUnit({ id: 0, position: [0, 0], definition: { id: 'receiver', defense: { defense: 100, resistance: 0 } } }));
  const original = work.battlefield.snapshot("draft");
  const apply = (source, defenseRatio, expiresAtTick, tick) => {
    const current = getUnit(work, 0).effects?.instances.find(instance => instance.programRef === program.ref && !instance.finished);
    const plan = policy.plan(current === undefined ? undefined : { stackCount: current.state.stackCount, expiresAtTick: effectTick(current) }, { stackCount: 1, expiresAtTick }, tick);
    if (plan.type === 'INSTALL') {
      work = installNewEffect(work, 0, program.ref, { source, scopes: expiresAtTick === null ? [] : [{ type: "TICK", tick: expiresAtTick }], initialState: { stackCount: 1, defenseRatio } }, resources, tick).work;
    } else if (plan.type === 'REFRESH') {
      const address = { type: "EFFECT", unitId: 0, effectId: current.id };
      work = setEffectTick(work, address, plan.expiresAtTick);
      work = updateEffectState(work, 0, current.id, program.ref, state => ({ ...state, stackCount: plan.stackCount }), resources, tick);
    }
    return plan;
  };
  const effective = () => resolveDefense(0, battlefieldView(work)).defense;
  apply(10, 0.2, 10, 0);
  close(effective(), 120);
  const first = work.battlefield.snapshot("draft");
  apply(20, 0.9, 15, 1);
  close(effective(), 140);
  let instance = getUnit(work, 0).effects.instances[0];
  assert.equal(instance.source, 10);
  assert.equal(instance.state.defenseRatio, 0.2);
  assert.equal(instance.state.stackCount, 2);
  assert.equal(effectTick(instance), 15);
  assert.equal(getUnit(work, 0).effects.instances.length, 1);
  assert.equal(first.getUnit(0).effects.instances[0].state.stackCount, 1);
  assert.equal(starts, 1);
  const address = { type: "EFFECT", unitId: 0, effectId: instance.id };
  work = setEffectEnabled(work, address, false, resources, 2);
  apply(30, 0.8, 20, 3);
  assert.equal(effective(), 100);
  work = setEffectEnabled(work, address, true, resources, 4);
  close(effective(), 160);
  apply(30, 0.8, 20, 5);
  apply(30, 0.8, 20, 6);
  close(effective(), 200);
  const capped = work.battlefield.snapshot("draft");
  assert.equal(apply(40, 0.8, 100, 7).type, 'REJECT');
  assert.equal(getUnit(work, 0), capped.getUnit(0));
  work = expireEffects(work, 19, resources);
  close(effective(), 200);
  work = finishEffects(work, [address], resources, 20);
  assert.equal(effective(), 100);
  assert.equal(resolveDefense(0, original).defense, 100);
  assert.equal(starts, 1);
  instance = getUnit(work, 0).effects.instances[0];
  assert.equal(instance.finished, true);
});

test('participation notification scope: exceptions release pending identity leases before retry', () => {
  const scope = new EffectDispatchScope();
  const address = { type: "EFFECT", unitId: 0, effectId: 1 };
  let escaped;
  assert.throws(() => scope.withParticipationChanges([{ address, participating: true }], isPending => {
    escaped = isPending;
    assert.equal(isPending(0), true);
    throw new Error('content bug');
  }), /content bug/);
  assert.equal(escaped(0), false);
  assert.equal(scope.consumeParticipationChange(address, true), false);
  scope.withParticipationChanges([{ address, participating: false }], isPending => {
    assert.equal(isPending(0), true);
    assert.equal(scope.consumeParticipationChange(address, false), true);
    assert.equal(isPending(0), false);
  });
  assert.equal(scope.consumeParticipationChange(address, false), false);
});

test('Buff contribution integration: only effective layer growth resamples the retained source, while renewal preserves the sample', () => {
  const policy = compileBuffStacking({ overrideType: 'STACK', maxStackCnt: 3, maxValidStackCnt: 2, refreshRemainingTimeWhenStackMax: true, takeSnapshotWhenExtend: false, clearAllStackCntWhenTimeUp: false });
  const [compiled] = compileAttributeModifiers(parseAttributeModifiers([{
    attributeType: 'ATK', formulaItem: 'MULTIPLIER', value: 0.5,
    loadFromBlackboard: false, fetchBaseValueFromSourceEntity: true,
  }]));
  const resources = new CombatResources();
  const program = resources.registerEffect(createEffectProgram({
    id: 'source-layer-sample', initialize: () => ({ stackCount: 1, sourceAttack: 100 }), ownState: state => ({ ...state }),
  }), { contributions: [attack(instance => [compiled.sample({
    blackboard: new Map(), stackCount: policy.validStackCount(instance.state.stackCount),
    readSourceAttribute: () => instance.state.sourceAttack,
  })])] });
  let work = effectFixtureWork(initializeUnit({ id: 0, position: [0, 0], definition: { id: 'receiver', offense: { attack: 100 } } }));
  work = installNewEffect(work, 0, program.ref, { source: 10, scopes: [{ type: "TICK", tick: 10 }]}, resources, 0).work;
  const power = () => resolveAttackPower(0, battlefieldView(work));
  assert.equal(power(), 150);
  const apply = (currentSourceAttack, tick, expiresAtTick) => {
    const current = getUnit(work, 0).effects.instances[0];
    const plan = policy.plan({ stackCount: current.state.stackCount, expiresAtTick: effectTick(current) }, { stackCount: 1, expiresAtTick }, tick);
    assert.equal(plan.type, 'REFRESH');
    work = setEffectTick(work, { type: "EFFECT", unitId: 0, effectId: 0 }, plan.expiresAtTick);
    work = updateEffectState(work, 0, 0, program.ref, state => ({ ...state,
      stackCount: plan.stackCount, sourceAttack: plan.reloadModifiers ? currentSourceAttack : state.sourceAttack,
    }), resources, tick);
    return plan;
  };
  assert.equal(apply(200, 1, 20).reloadModifiers, true);
  assert.equal(power(), 300);
  assert.equal(apply(400, 2, 30).reloadModifiers, false);
  assert.equal(power(), 300);
  assert.equal(apply(800, 3, 40).reloadModifiers, false);
  assert.equal(power(), 300);
  const current = getUnit(work, 0).effects.instances[0];
  assert.equal(current.state.stackCount, 3);
  assert.equal(current.state.sourceAttack, 200);
  assert.equal(effectTick(current), 40);
  assert.equal(current.source, 10);
});
