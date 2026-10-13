import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createTacticalDemo } from '../../dist/legacy/tactical-demo.js';

const tables = Object.fromEntries(['chess','enemies','stages'].map(name => [name, JSON.parse(readFileSync(new URL(`../../data/${name}.json`, import.meta.url)))]));
const data = { lookup: (table, key) => tables[table]?.[key] };

test('main-mode content uses the existing legacy view for models, skills, arrows and deterministic seek', async () => {
  const fields = [], frames = [], visuals = [], events = [], projectiles = [];
  const view = {
    setStage() {}, enterBattle: field => fields.push(field), setCamera() {}, setLocalFeed() {},
    pushSnapshot: frame => frames.push(frame), pushEvents: batch => visuals.push(...batch.ev),
    setProjectiles: values => projectiles.push(values),
    debug: { interp: { snapToNewest() {}, maxExtrapolate: .2 } },
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(readFileSync(new URL(`../fixtures/arknights/${String(url).split('/').at(-1)}`, import.meta.url)));
  let demo;
  try {
    demo = await createTacticalDemo(view, {
      stageId: 'act1autochess_m01', mode: 'COMBAT', combatScenario: 'CONTENT', data,
      contentConfiguration: { mudrock: { elite: 2, level: 90, potential: 5, skillIndex: 1, skillLevel: 10, trust: 100, module: { id: 'uniequip_002_mudrok', level: 3 } } },
      onEvent: event => events.push(event),
    });
  } finally { globalThis.fetch = previousFetch; }
  assert.deepEqual(fields[0].units.map(unit => [unit.kind, unit.name, unit.spine, unit.skillIndex]), [
    ['op','泥岩','char_311_mudrok',1], ['op','玫兰莎','char_208_melan',0],
  ]);
  assert.equal(demo.stats().content.mudrock.maxHp, 4828);
  assert.equal(demo.stats().content.mudrock.shieldLayers, 1);
  assert.equal(demo.stats().skill.maxSp, 40);
  while (demo.time < 20) demo.step();
  demo.nextSkillReady();
  assert.equal(demo.stats().skill.ready, true);
  demo.command('ACTIVATE_SKILL');
  assert.equal(demo.snapshot().units.find(unit => unit.id === 1).skill.active.id, 0);
  assert.ok(visuals.some(event => event[0] === 'skill' && event[1] === 1 && event[2] === true));
  while (demo.time < 55 && demo.stats().result === null) demo.step();
  assert.ok(events.some(event => event.type === 'PROJECTILE_HIT'));
  assert.ok(events.some(event => event.type === 'SKILL_ACTIVATED' && event.unitId === 0));
  assert.ok(visuals.some(event => event[0] === 'dmg'));
  assert.ok(visuals.some(event => event[0] === 'heal'));
  assert.ok(projectiles.some(values => values.length > 0));
  const saved = JSON.parse(JSON.stringify(demo.snapshot()));
  demo.seek(0); demo.seek(55);
  assert.deepEqual(JSON.parse(JSON.stringify(demo.snapshot())), saved);
  demo.reset();
  assert.equal(demo.time, 0);
  assert.equal(demo.stats().skill.sp, 0);
  assert.equal(demo.stats().content.mudrock.shieldLayers, 1);
  assert.ok(frames.length > 1);
  demo.stop();
  assert.equal(view.debug.interp.maxExtrapolate, .2);
});
