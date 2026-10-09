import { BattlefieldRuntime } from '../../dist/core/tactical/battlefield/runtime.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createNavigationModifierDefinition } from '../../dist/core/tactical/battlefield/navigation/modifier.js';
import { createDeploymentProfile } from '../../dist/core/tactical/unit/capability/deployment.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CombatResources } from '../../dist/core/tactical/battle/resources.js';
import { resolveDeploymentCommands } from '../../dist/core/tactical/battle/steps/deployment.js';
import { advancePredefined, createPredefinedInstanceDefinition } from '../../dist/core/tactical/battle/steps/predefined.js';
import { createCombatWork, getCombatUnit } from '../../dist/core/tactical/battle/execution/work.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { createSkillDefinition } from '../../dist/core/tactical/unit/capability/skill/capability.js';
import { activateSkill } from '../../dist/core/tactical/unit/capability/skill/execution.js';
import { createEffectProgram } from '../../dist/core/tactical/unit/capability/effects/program.js';
import { installNewEffect } from '../../dist/core/tactical/unit/capability/effects/lifecycle.js';
import { createDamageOperands } from '../../dist/core/tactical/unit/capability/vitality/damage/contract.js';
import { createMechanismDefinition, createMechanismRuntime } from '../../dist/core/tactical/battlefield/mechanism.js';
import { createEffectSourceProgramRef } from '../../dist/core/tactical/battlefield/effect-source/program.js';

function fixture() {
  const resources = new CombatResources();
  const sourceRef = createEffectSourceProgramRef('departure-shared-counter');
  resources.effectSources.register({
    ref: sourceRef,
    initialize: () => ({ consumed: 0 }),
    ownState: state => ({ ...state }),
    selectInitial: () => [],
    install: () => undefined,
  });
  const mechanism = createMechanismRuntime({
    id: 20,
    definition: createMechanismDefinition({ id: sourceRef.id }),
    active: true,
    effectSource: resources.effectSources.create(sourceRef, { sourceUnitId: null }),
  });
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
  const counter = resources.registerEffect(createEffectProgram({
    id: 'consume-on-damage', initialize: () => ({}), ownState: state => state,
  }), {
    damage: { reception: { priority: 0, apply: (context, value) => {
      assert.equal(context.operations.sources.tryConsume(20, sourceRef,
        state => ({ consumed: state.consumed + 1 })), true);
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
    mechanismIds: [20], getMechanism: id => id === 20 ? mechanism : undefined,
    supportRelations: [],
  };
  let work = createCombatWork(battlefield, undefined, battlefield);
  for (const id of [0, 1]) work = activateSkill(work, { unitId: id, tick: 0 }, resources).work;
  work = installNewEffect(work, 2, counter.ref, { source: null, scopes: [] }, resources, 0).work;
  for (const id of battlefield.unitIds) byId.set(id, getCombatUnit(work, id));
  return { battlefield, resources, execution: work.execution };
}

for (const domain of ['deployment', 'predefined']) {
  test(`${domain}: successive departures share mechanism updates from skill finish damage`, () => {
    const { battlefield, resources, execution } = fixture();
    const result = domain === 'deployment'
      ? resolveDeploymentCommands(battlefield, [
          { type: 'RETREAT_UNIT', unitId: 0 },
          { type: 'RETREAT_UNIT', unitId: 1 },
        ], execution, 1, resources)
      : advancePredefined(
          [{ id: 10 }, { id: 11 }],
          [
            { definitionId: 10, source: { type: 'UNIT', unitId: 0 } },
            { definitionId: 11, source: { type: 'UNIT', unitId: 1 } },
          ],
          { battlefield, execution, tick: 1, commands: [
            { type: 'REMOVE_PREDEFINED', definitionId: 10, reason: 'SCRIPT' },
            { type: 'REMOVE_PREDEFINED', definitionId: 11, reason: 'SCRIPT' },
          ] },
          resources,
        );
    const mechanism = result.changes.filter(change => change.type === 'UPDATE_MECHANISM').at(-1).mechanism;

    assert.equal(mechanism.effectSource.state.consumed, 2);
    assert.equal(battlefield.getMechanism(20).effectSource.state.consumed, 0);
    assert.deepEqual(result.changes.filter(change => change.type === 'REMOVE_UNIT').map(change => change.unitId), [0, 1]);
    assert.equal(result.events.filter(event => event.type === 'SKILL_FINISHED').length, 2);
    assert.equal(result.changes.filter(change => change.type === 'UPDATE_UNIT' && change.unit.id === 2).at(-1).unit.vitality.hp, 98);
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
    const execution = createCombatWork(battlefield.view).execution;
    const result = domain === 'deployment'
      ? resolveDeploymentCommands(battlefield.view, [
          { type: 'DEPLOY_UNIT', definition, navigationModifiers, tilePosition: [0, 0], playerSide: 'SIDE_A' },
          { type: 'RETREAT_UNIT', unitId: 0 },
          { type: 'DEPLOY_UNIT', definition, tilePosition: [0, 0], playerSide: 'SIDE_A' },
        ], execution, 0, resources)
      : advancePredefined(
          [createPredefinedInstanceDefinition({
            id: 10, alias: null, initiallyPresent: false,
            creation: { type: 'UNIT', definition, position: [0, 0], navigationModifiers },
          })],
          [],
          { battlefield: battlefield.view, execution, tick: 0, commands: [
            { type: 'APPEAR_PREDEFINED', definitionId: 10 },
            { type: 'REMOVE_PREDEFINED', definitionId: 10, reason: 'SCRIPT' },
          ] },
          resources,
        );
    const committed = battlefield.apply(result.changes);

    assert.deepEqual(committed.removedUnits.map(unit => unit.unitId), [0]);
    assert.deepEqual(battlefield.navigationModifierIds, []);
    assert.deepEqual(battlefield.unitIds, domain === 'deployment' ? [1] : []);
  });
}
