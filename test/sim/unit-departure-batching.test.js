import { fixtureBattlefield } from "../helpers/battlefield.js";
import { createActionDefinition } from '../../dist/core/tactical/unit/capability/action/capability.js';
import { acceptActionExecution, createActionExecutionState } from '../../dist/core/tactical/unit/capability/action/process.js';
import { ActionExecutionWork } from '../../dist/core/tactical/unit/capability/action/internal/executions.js';
import { BattlefieldRuntime } from '../../dist/core/tactical/battlefield/runtime.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createNavigationModifierDefinition } from '../../dist/core/tactical/battlefield/navigation/modifier.js';
import { createDeploymentProfile } from '../../dist/core/tactical/unit/capability/deployment.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { resolveDeploymentCommands } from '../../dist/core/tactical/battle/steps/deployment.js';
import { advancePredefined, createPredefinedDefinition } from '../../dist/core/tactical/battle/steps/predefined.js';
import { createBattleState, getUnit, } from '../../dist/core/tactical/battle/execution/context.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { createSkillDefinition } from '../../dist/core/tactical/unit/capability/skill/capability.js';
import { activateSkill } from '../../dist/core/tactical/unit/capability/skill/execution.js';
import { createEffectDefinition } from '../../dist/core/tactical/unit/capability/effects/definition.js';
import { installNewEffect, finishEffects } from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { createDamageOperands } from '../../dist/core/tactical/unit/capability/vitality/damage/contract.js';

function fixture() {
  const resources = new CombatResources();
  const skill = createSkillDefinition({
    id: 'departing-counter-skill', activation: 'MANUAL', spRecovery: 'NONE',
    spCost: 0, initialSp: 0, durationTicks: null,
  });
  resources.skills.register({
    definition: skill,
    activate: () => ({ type: 'ACTIVATED' }),
    finish: context => {
      context.damage({ sourceUnitId: null, targetUnitId: 2, damageType: 'TRUE', operands: createDamageOperands(1) });
    },
  });
  const counter = resources.registerEffect(createEffectDefinition({
    id: 'consume-on-damage', initialize: () => ({ consumed: 0 }),
  }), {
    damage: { reception: { priority: 0, apply: (context, value) => {
      context.operations.effects.update(context.ref, counter.ref,
        state => ({ consumed: state.consumed + 1 }));
      return { value };
    } } },
  });
  const units = Array.from({ length: 3 }, (_, id) => initializeUnit({
    id, position: [id, 0], definition: {
      id: `departure-${id}`, vitality: { maxHp: 100 },
      ...(id < 2 ? { skill } : {}),
    },
  }));
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const battlefield = {
    unitIds: [0, 1, 2], getUnit: id => byId.get(id),
    blockerOf: () => undefined, blockedBy: () => [],
    supportRelations: [],
  };
  const work = createBattleState(fixtureBattlefield(battlefield), undefined);
  for (const id of [0, 1]) activateSkill(work, { unitId: id, tick: 0 }, resources);
  installNewEffect(work, 2, counter.ref, { source: null, scopes: [] }, resources, 0);
  work.battlefield.apply();
  return { battlefield: work.battlefield, resources, execution: work.execution };
}

for (const domain of ['deployment', 'predefined']) {
  test(`${domain}: successive departures share effect updates from skill finish damage`, () => {
    const { battlefield, resources, execution } = fixture();
    const before = battlefield.snapshot('state');
    const state = createBattleState(battlefield, execution, undefined, 1);
    if (domain === 'deployment') {
      resolveDeploymentCommands(state, [
        { type: 'RETREAT_UNIT', unitId: 0 },
        { type: 'RETREAT_UNIT', unitId: 1 },
      ], 1, resources);
    } else {
      advancePredefined(
        state,
        [{ id: 10 }, { id: 11 }],
        [
          { definitionId: 10, source: { type: 'UNIT', unitId: 0 } },
          { definitionId: 11, source: { type: 'UNIT', unitId: 1 } },
        ],
        [
          { type: 'REMOVE_PREDEFINED', definitionId: 10, reason: 'SCRIPT' },
          { type: 'REMOVE_PREDEFINED', definitionId: 11, reason: 'SCRIPT' },
        ],
        1,
        resources,
      );
    }

    assert.equal(getUnit(state, 2).effects.instances[0].state.consumed, 2);
    assert.equal(before.getUnit(2).effects.instances[0].state.consumed, 0);
    assert.deepEqual(state.removedUnits.map(unit => unit.unitId), [0, 1]);
    assert.equal(state.events.filter(event => event.type === 'SKILL_FINISHED').length, 2);
    assert.equal(getUnit(state, 2).vitality.hp, 98);
  });
}

for (const domain of ['deployment', 'predefined']) {
  test(`${domain}: creation then departure preserves removal facts and cleans attached navigation modifiers`, () => {
    const map = createBattlefieldMap(1, 2, Array.from({ length: 2 }, () => ({
      heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
      playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
    })));
    const battlefield = BattlefieldRuntime.create({ map });
    const resources = new CombatResources();
    const definition = Object.freeze({
      id: 'transient-placement', deployment: createDeploymentProfile({ buildableType: 'ALL' }),
      vitality: Object.freeze({ maxHp: 100 }),
    });
    const navigationModifiers = [{
      definition: createNavigationModifierDefinition({
        id: 'transient-wall', FLY: null,
        WALK: { denyPassage: false, deniedDepartures: [], costFloor: 10 },
      }),
      range: [[0, 0]], direction: 'RIGHT',
    }];
    const state = createBattleState(battlefield);
    if (domain === 'deployment') {
      resolveDeploymentCommands(state, [
        { type: 'DEPLOY_UNIT', definition, navigationModifiers, tilePosition: [0, 0], playerSide: 'SIDE_A' },
        { type: 'RETREAT_UNIT', unitId: 0 },
        { type: 'DEPLOY_UNIT', definition, tilePosition: [0, 0], playerSide: 'SIDE_A' },
      ], 0, resources);
    } else {
      advancePredefined(
        state,
        [createPredefinedDefinition({
          id: 10, alias: null, initiallyPresent: false,
          creation: { type: 'UNIT', definition, position: [0, 0], navigationModifiers },
        })],
        [],
        [
          { type: 'APPEAR_PREDEFINED', definitionId: 10 },
          { type: 'REMOVE_PREDEFINED', definitionId: 10, reason: 'SCRIPT' },
        ],
        0,
        resources,
      );
    }

    assert.deepEqual(state.removedUnits.map(unit => unit.unitId), [0]);
    assert.deepEqual(battlefield.snapshot("draft").navigationModifierIds, []);
    assert.deepEqual(battlefield.snapshot("draft").unitIds, domain === 'deployment' ? [1] : []);
  });
}

test('effect finish: nested host death stops Action and Skill before their dependents, then waits for host notices', () => {
  const resources = new CombatResources();
  const order = [];
  const skill = createSkillDefinition({
    id: 'nested-finish-skill', activation: 'MANUAL', spRecovery: 'NONE',
    spCost: 0, initialSp: 0, durationTicks: null,
  });
  const action = createActionDefinition({
    triggerBindingId: 'primary', baseAttackTimeTicks: 1, recoveryTicks: 0,
    targetGroups: [{ id: 'primary', targeting: {
      type: 'DAMAGE', scope: { type: 'BLOCKER' }, canTargetAir: true,
      includeBlockingRelations: false, preferBlockingRelations: false,
      ignoreTargetFree: false, ignoreInvisible: false, maxTargets: 1,
    }, operations: [{ type: 'DAMAGE', power: 1, damageType: 'TRUE' }] }], followUps: [],
  });
  const accepted = acceptActionExecution(createActionExecutionState(), {
    sourceUnitId: 0, definition: action, inputTargetUnitId: 1,
    bindings: new Map([['primary', [1]]]), tick: 0,
  });
  const executions = new ActionExecutionWork(accepted.state);
  const independent = resources.registerEffect(createEffectDefinition({
    id: 'independent-in-skill-finish', initialize: () => ({}),
  }));
  const forbidden = resources.registerEffect(createEffectDefinition({
    id: 'forbidden-on-departing-host', initialize: () => ({}),
  }), { lifecycle: { start: () => { throw new Error('closed host ran start'); } } });
  resources.skills.register({
    definition: skill,
    activate: () => ({ type: 'ACTIVATED' }),
    finish: context => {
      order.push('skill');
      assert.equal(context.facts.getUnit(0).skill.active, null);
      assert.equal(executions.get(0), undefined);
      assert.equal(context.effects.install(1, independent.ref, { source: 0, scopes: [] }).type, 'INSTALLED');
    },
  });
  const first = resources.registerEffect(createEffectDefinition({
    id: 'first-host-notice', initialize: () => ({}),
  }), { lifecycle: { finish: context => {
    order.push('first');
    context.damage({ sourceUnitId: null, targetUnitId: 0, damageType: 'TRUE', operands: createDamageOperands(100) });
    order.push('first after damage');
    assert.equal(context.facts.getUnit(0).skill.active, null);
    assert.equal(executions.get(0), undefined);
    assert.deepEqual(context.effects.install(0, forbidden.ref, { source: null, scopes: [] }),
      { type: 'REJECTED', reason: 'TARGET_CLOSING' });
    assert.equal(context.instance.finished, true);
    assert.equal(order.includes('skill'), false);
  } } });
  const second = resources.registerEffect(createEffectDefinition({
    id: 'second-host-notice', initialize: () => ({}),
  }), { lifecycle: { finish: context => {
    order.push('second');
    assert.equal(context.facts.getUnit(0).skill.active, null);
    assert.equal(executions.get(0), undefined);
    assert.equal(order.includes('skill'), false);
    context.effects.finish([context.ref]);
  } } });
  const dependent = resources.registerEffect(createEffectDefinition({
    id: 'nested-action-dependent', initialize: () => ({}),
  }), { lifecycle: { finish: context => {
    order.push('action dependent');
    assert.deepEqual(context.end, { root: { type: 'ACTION', executionId: 0 }, reason: 'DEATH' });
    assert.equal(executions.get(0), undefined);
    assert.equal(context.facts.getUnit(0).skill.active, null);
  } } });
  const units = [
    initializeUnit({ id: 0, position: [0, 0], definition: { id: 'nested-source', vitality: { maxHp: 100 }, skill } }),
    initializeUnit({ id: 1, position: [1, 0], definition: { id: 'nested-receiver', vitality: { maxHp: 100 } } }),
  ];
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const work = createBattleState(fixtureBattlefield({
    unitIds: [0, 1], getUnit: id => byId.get(id), blockerOf: () => undefined, blockedBy: () => [],
  }), undefined, executions);
  activateSkill(work, { unitId: 0, tick: 0 }, resources);
  const refs = [];
  for (const program of [first, second]) {
    const installed = installNewEffect(work, 0, program.ref, { source: null, scopes: [] }, resources, 0);
    refs.push(installed.ref);
  }
  installNewEffect(work, 1, dependent.ref, {
    source: 0, scopes: [{ type: 'ACTION', executionId: 0 }],
  }, resources, 0);
  const hostBefore = getUnit(work, 0);

  finishEffects(work, refs, resources, 1, 'EXPLICIT');

  assert.deepEqual(order, ['first', 'action dependent', 'first after damage', 'second', 'skill']);
  assert.equal(getUnit(work, 0), undefined);
  assert.deepEqual(executions.result().executions, []);
  assert.equal(work.events.filter(event => event.type === 'ACTION_CANCELLED').length, 1);
  assert.equal(work.events.filter(event => event.type === 'SKILL_FINISHED').length, 1);
  assert.equal(getUnit(work, 1).effects.instances.find(instance => instance.definitionRef === independent.ref).participating, true);
  assert.equal(hostBefore.effects.nextInstanceId, 2);
});

test('effect finish: remote dependent notices delay Skill notification and host deletion through nested endings', () => {
  const resources = new CombatResources();
  const order = [];
  const skill = createSkillDefinition({
    id: 'remote-pending-skill', activation: 'MANUAL', spRecovery: 'NONE',
    spCost: 0, initialSp: 0, durationTicks: null,
  });
  resources.skills.register({
    definition: skill,
    activate: () => ({ type: 'ACTIVATED' }),
    finish: context => {
      order.push('skill');
      assert.equal(context.facts.getUnit(0).skill.active, null);
    },
  });
  const transient = resources.registerEffect(createEffectDefinition({
    id: 'nested-transient-notice', initialize: () => ({}),
  }), { lifecycle: {
    start: context => { context.effects.finish([context.ref]); },
    finish: () => { order.push('transient'); },
  } });
  const parent = resources.registerEffect(createEffectDefinition({
    id: 'remote-pending-parent', initialize: () => ({}),
  }), { lifecycle: { finish: context => {
    order.push('parent');
    context.damage({ sourceUnitId: null, targetUnitId: 0, damageType: 'TRUE', operands: createDamageOperands(100) });
  } } });
  const child = resources.registerEffect(createEffectDefinition({
    id: 'remote-pending-child', initialize: () => ({}),
  }), { lifecycle: { finish: context => {
    order.push('child');
    assert.equal(context.facts.getUnit(0).skill.active, null);
    assert.equal(context.effects.install(1, transient.ref, { source: 0, scopes: [] }).type, 'ENDED');
    order.push('child after nested ending');
    assert.equal(context.facts.getUnit(0).skill.active, null);
    assert.equal(order.includes('skill'), false);
  } } });
  const units = [
    initializeUnit({ id: 0, position: [0, 0], definition: { id: 'remote-parent-source', vitality: { maxHp: 100 }, skill } }),
    initializeUnit({ id: 1, position: [1, 0], definition: { id: 'remote-child-host', vitality: { maxHp: 100 } } }),
  ];
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const work = createBattleState(fixtureBattlefield({
    unitIds: [0, 1], getUnit: id => byId.get(id), blockerOf: () => undefined, blockedBy: () => [],
  }));
  activateSkill(work, { unitId: 0, tick: 0 }, resources);
  const installed = installNewEffect(work, 0, parent.ref, { source: null, scopes: [] }, resources, 0);
  installNewEffect(work, 1, child.ref, { source: 0, scopes: [installed.ref] }, resources, 0);

  finishEffects(work, [installed.ref], resources, 1);

  assert.deepEqual(order, ['parent', 'child', 'transient', 'child after nested ending', 'skill']);
  assert.equal(getUnit(work, 0), undefined);
  assert.equal(work.events.filter(event => event.type === 'SKILL_FINISHED').length, 1);
});
