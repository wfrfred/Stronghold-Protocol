import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { create, defaults } from '../../dist/content/tactical/scenario.js';
import { readShield } from '../../dist/content/tactical/operators/mudrock.js';

const data = JSON.parse(readFileSync(new URL('../fixtures/arknights/main-mode-units.json', import.meta.url)));
const json = value => JSON.parse(JSON.stringify(value));

test('main-mode content runs deterministic shield, skill, blocking and projectile settlement end to end', () => {
  const configuration = { ...defaults, mudrock: { ...defaults.mudrock,
    level: 90, potential: 5, skillLevel: 10,
    module: { id: 'uniequip_002_mudrok', level: 3 },
  } };
  const first = create(data, configuration).runtime;
  const second = create(data, configuration).runtime;
  const before = first.snapshot();
  const events = [];
  let hasBlocking = false;
  let triggeredMelantha = false;
  while (first.result === null) {
    const guard = first.snapshot().units.find(unit => unit.id === 1);
    const commands = !triggeredMelantha && guard?.skill.sp >= guard?.definition.skill.spCost
      ? [{ type: 'ACTIVATE_SKILL', unitId: 1 }] : [];
    if (commands.length) triggeredMelantha = true;
    const step = first.step(commands);
    const replay = second.step(commands);
    assert.deepEqual(json(step), json(replay));
    events.push(...step.events);
    hasBlocking ||= first.snapshot().blockingRelations.length > 0;
  }
  assert.deepEqual(json(first.snapshot()), json(second.snapshot()));
  assert.ok(hasBlocking);
  assert.ok(events.some(event => event.type === 'PROJECTILE_HIT'));
  assert.ok(events.some(event => event.type === 'HEAL' && event.targetUnitId === 0));
  assert.ok(events.some(event => event.type === 'DAMAGE' && event.targetUnitId === 0 && event.amount === 0));
  assert.ok(events.some(event => event.type === 'SKILL_ACTIVATED' && event.unitId === 0));
  assert.ok(events.some(event => event.type === 'SKILL_FINISHED' && event.unitId === 0));
  assert.ok(events.some(event => event.type === 'SKILL_ACTIVATED' && event.unitId === 1));
  assert.ok(events.some(event => event.type === 'DAMAGE' && event.sourceUnitId === 0 && event.amount > 0));
  assert.equal(before.units.length, 2);
  assert.equal(before.units[0].vitality.hp, before.units[0].definition.vitality.maxHp);
  assert.equal(readShield(before.units[0]).layers, 1);
  assert.equal(before.units[1].skill.active, null);
});

test('main-mode preparation rejects an unavailable configuration before constructing battle', () => {
  assert.throws(() => create(data, { ...defaults, mudrock: { ...defaults.mudrock,
    elite: 1, level: 60, skillLevel: 10,
  } }), /mastery|精|unlock|elite|phase|skill level/i);
});
