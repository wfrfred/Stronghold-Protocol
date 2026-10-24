import { advance as advanceBlocking } from "../../dist/core/tactical/battle/blocking/operations.js";
import { ref as activationRef } from "../../dist/core/tactical/unit/capability/skill/activation.js";
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { prepare } from '../../dist/data/arknights/operator.js';
import { create } from '../../dist/content/tactical/operators/melantha.js';

import { initialize } from "../helpers/unit.js";
import { createBattleState, battlefieldView, getUnit, updateUnit } from '../../dist/core/tactical/battle/state.js';
import { enter } from '../../dist/core/tactical/battle/execution/unit.js';
import { activate as activateSkill, advance as advanceSkill, finish as finishSkill } from '../../dist/core/tactical/unit/capability/skill/operations.js';
import { resolveAttack } from '../../dist/core/tactical/unit/capability/offense/query.js';
import { fixtureBattlefieldState } from '../helpers/battlefield.js';
import { ref as unitRef } from '../../dist/core/tactical/unit/query.js';
import { start as startAction } from '../../dist/core/tactical/unit/action/operations.js';
import { select } from '../../dist/core/tactical/battle/targeting/select.js';
import { invisibleRestriction, camouflageRestriction, untargetableRestriction } from '../../dist/content/tactical/effects/visibility.js';

const data = JSON.parse(readFileSync(new URL('../fixtures/arknights/main-mode-units.json', import.meta.url)));
const profile = (fields = {}) => prepare(
  { id: 'char_208_melan', record: data.characters.char_208_melan },
  data.skills['skcom_atk_up[1]'],
  { elite: 1, level: 55, potential: 6, skillIndex: 0, skillLevel: 7, trust: 100, ...fields },
  { ranges: data.ranges, favor: data.favor },
);

test('Melantha uses main-mode level, potential, trust and talent, then a scoped skill contribution', () => {

  const prepared = profile();
  const definition = create(prepared);
  const unit = initialize({ id: 0, position: [0, 0], definition });
  assert.deepEqual(definition.deployable, {
    cost: prepared.attributes.cost, redeployTicks: prepared.attributes.respawnTime * 30,
    slots: 1, buildableType: 'MELEE', advancedBuildableMask: 1,
    refund: { rate: 0.5, limit: 'BASE_COST' },
  });
  assert.equal(unit.deployable.refundAllowed, false);
  let state = createBattleState(fixtureBattlefieldState([unit]));
  const untouched = state;
  state = enter(state, 0);
  const entered = state;
  const base = (738 + 25 + 65) * 1.08;
  assert.equal(resolveAttack(state, unitRef(getUnit(state, 0))), base);
  assert.equal(getUnit(untouched, 0).effects.values().toArray().length, 0);
  state = updateUnit(state, { ...getUnit(state, 0), skill: { ...getUnit(state, 0).skill, sp: { ...getUnit(state, 0).skill.sp, value: 40 } } });
  const activation = activateSkill({ ...state, tick: 0  }, unitRef(getUnit(state, 0)));
  state = activation.state;
  assert.equal(activation.value.type, 'ACTIVATED');
  assert.equal(resolveAttack(state, unitRef(getUnit(state, 0))), (738 + 25 + 65) * 1.58);
  assert.equal(getUnit(entered, 0).effects.values().toArray().length, 1);
  assert.equal(getUnit(state, 0).effects.values().toArray().length, 2);
  const active = state;
  state = advanceSkill({ ...state, tick: 600 }, unitRef(getUnit(state, 0)));
  assert.equal(resolveAttack(state, unitRef(getUnit(state, 0))), base);
  assert.equal(getUnit(state, 0).skill.active, null);
  assert.equal(getUnit(active, 0).skill.active.sustain.endsAtTick, 600);
  assert.deepEqual(state.events.filter(e => e.type.startsWith('SKILL_')).map(e => e.type), ['SKILL_ACTIVATED', 'SKILL_FINISHED']);
});

test('explicit skill finish removes only skill output, preserving Melantha talent', () => {

  const definition = create(profile({ level: 1, potential: 1, trust: 0 }));
  let state = createBattleState(fixtureBattlefieldState([initialize({ id: 0, position: [0, 0], definition })]));
  state = enter(state, 0);
  const before = resolveAttack(state, unitRef(getUnit(state, 0)));
  state = updateUnit(state, { ...getUnit(state, 0), skill: { ...getUnit(state, 0).skill, sp: { ...getUnit(state, 0).skill.sp, value: 40 } } });
  state = activateSkill({ ...state, tick: 0  }, unitRef(getUnit(state, 0))).state;
  state = finishSkill({ ...state, tick: 1 }, activationRef(getUnit(state, 0).skill.active));
  assert.equal(resolveAttack(state, unitRef(getUnit(state, 0))), before);
  assert.equal(getUnit(state, 0).effects.values().toArray().length, 1);
});

test('ordinary attacks read current talent and skill contributions instead of captured table attack', () => {

  const definition = create(profile());
  const attack = definition.action.definitions.values().toArray()[0];
  const receiver = initialize({ id: 1, position: [1, 0], definition: {
    id: 'receiver', targetable: { restrictions: [] }, vitality: { maxHp: 10000, defense: 0, resistance: 0 }, allegiance: { side: 'ENEMY' }, layer: { type: 'GROUND' },
    hitbox: { shape: { type: 'CIRCLE', offset: [0, 0], radius: .1 } },
  } });
  let state = createBattleState(fixtureBattlefieldState([initialize({ id: 0, position: [0, 0], definition }), receiver]));
  state = enter(state, 0);
  state = updateUnit(state, { ...getUnit(state, 0), skill: { ...getUnit(state, 0).skill, sp: { ...getUnit(state, 0).skill.sp, value: 40 } } });
  state = activateSkill({ ...state, tick: 0  }, unitRef(getUnit(state, 0))).state;
  state = startAction(state, unitRef(getUnit(state, 0)), attack).state;
  const amount = state.events.find(event => event.type === 'DAMAGE').amount;
  assert.ok(Math.abs(amount - (738 + 25 + 65) * 1.58) < 1e-6);
  assert.equal(getUnit(state, 1).vitality.hp, 10000 - amount);
});

test('the ordinary ground block radius catches a target 0.6 units from Melantha', () => {

  const definition = create(profile());
  const receiver = initialize({ id: 1, position: [0.6, 0], definition: {
    id: 'nearby-enemy', targetable: { restrictions: [] }, vitality: { maxHp: 1000, defense: 0, resistance: 0 }, blockable: { volume: 1 },
    allegiance: { side: 'ENEMY' }, layer: { type: 'GROUND' },
    hitbox: { shape: { type: 'CIRCLE', offset: [0, 0], radius: .1 } },
  } });
  const state = advanceBlocking(createBattleState(fixtureBattlefieldState([initialize({ id: 0, position: [0, 0], definition }), receiver])));
  assert.deepEqual(battlefieldView(state).blockingRelations, [{ blockerUnitId: 0, blockedUnitId: 1 }]);
});

test('Melantha still checks active targeting restrictions on enemies she is blocking', () => {
  const definition = create(profile());
  const attack = definition.action.definitions.values().toArray()[0];
  for (const value of [invisibleRestriction, camouflageRestriction, untargetableRestriction]) {
    const receiver = initialize({ id: 1, position: [0.6, 0], definition: {
      id: 'hidden-blocked-enemy', targetable: { restrictions: [{ id: 'innate', value }] },
      vitality: { maxHp: 1000, defense: 0, resistance: 0 }, blockable: { volume: 1 },
      allegiance: { side: 'ENEMY' }, layer: { type: 'GROUND' },
      hitbox: { shape: { type: 'CIRCLE', offset: [0, 0], radius: .1 } },
    } });
    const source = initialize({ id: 0, position: [0, 0], definition });
    const state = advanceBlocking(createBattleState(fixtureBattlefieldState([source, receiver])));

    assert.deepEqual(battlefieldView(state).blockingRelations, [{ blockerUnitId: 0, blockedUnitId: 1 }]);
    assert.deepEqual(select(state, { ...attack.attack.targetGroups[0].targeting, source: unitRef(source) }).value, []);
    const started = startAction(state, unitRef(source), attack);
    assert.deepEqual(started.value, { type: 'REJECTED', reason: 'CONDITION' });
    assert.equal(getUnit(started.state, 1).vitality.hp, 1000);
  }
});
