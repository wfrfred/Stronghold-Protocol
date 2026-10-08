import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createTacticalDemo } from '../../dist/legacy/tactical-demo.js';

const tables = Object.fromEntries(['chess', 'enemies', 'stages'].map(name => [
  name, JSON.parse(readFileSync(new URL(`../../data/${name}.json`, import.meta.url), 'utf8')),
]));
const data = { lookup: (table, key) => tables[table]?.[key] };

async function createDemo(combatScenario) {
  const frames = [];
  const visuals = [];
  const events = [];
  const view = {
    setStage() {}, enterBattle() {}, setCamera() {}, setLocalFeed() {},
    pushSnapshot: snapshot => frames.push(snapshot),
    pushEvents: batch => visuals.push(...batch.ev),
    debug: { interp: { snapToNewest() {}, maxExtrapolate: 0.2 } },
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(readFileSync(
    new URL(`../fixtures/arknights/${String(url).split('/').at(-1)}`, import.meta.url),
  ));

  try {
    const demo = await createTacticalDemo(view, {
      stageId: 'act1autochess_m01', mode: 'COMBAT', combatScenario, data,
      onEvent: event => events.push(event),
    });
    return { demo, frames, visuals, events };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test('legacy render demo charges the real beta skill and projects its temporary attack increase', async () => {
  const { demo, frames, events, visuals } = await createDemo('SKILL');
  assert.equal(demo.stats().skill.sp, 0);
  assert.equal(demo.stats().skill.maxSp, 37);
  demo.nextSkillReady();
  assert.equal(demo.stats().skill.ready, true);
  assert.equal(visuals.some(event => event[0] === 'dmg'), false);
  assert.equal(events.filter(event => event.type === 'DAMAGE').at(-1).amount, 312);
  assert.equal(frames.at(-1).units.find(unit => unit[0] === 0)[5], 37);

  demo.command('ACTIVATE_SKILL');
  assert.equal(demo.stats().skill.active, true);
  assert.equal(demo.stats().skill.sp, 0);
  assert.ok(visuals.some(event => event[0] === 'skill' && event[2] === true));
  const activeTuple = frames.at(-1).units.find(unit => unit[0] === 0);
  assert.equal(activeTuple[7] & 16, 16);
  assert.ok(activeTuple[5] > 0 && activeTuple[5] <= 37);
  while (demo.time < 40) demo.step();
  assert.equal(Math.round(events.filter(event => event.type === 'DAMAGE').at(-1).amount * 10), 4212);

  const replay = { snapshot: demo.snapshot(), stats: demo.stats(), frame: frames.at(-1) };
  demo.seek(0);
  demo.seek(40);
  assert.deepEqual({ snapshot: demo.snapshot(), stats: demo.stats(), frame: frames.at(-1) }, replay);

  demo.command('FINISH_SKILL');
  assert.equal(demo.stats().skill.active, false);
  assert.equal(frames.at(-1).units.find(unit => unit[0] === 0)[7] & 16, 0);
  while (demo.time < 43) demo.step();
  assert.equal(events.filter(event => event.type === 'DAMAGE').at(-1).amount, 312);
  demo.reset();
  assert.equal(demo.time, 0);
  assert.equal(demo.stats().skill.sp, 0);
  assert.equal(demo.stats().attackCount, 0);
  demo.stop();
});

test('the demo ends the beta skill naturally and resumes SP recovery', async () => {
  const { demo, events } = await createDemo('SKILL');
  demo.nextSkillReady();
  demo.command('ACTIVATE_SKILL');
  const active = demo.snapshot().units.find(unit => unit.id === 0).skill.active;
  while (demo.time < active.endsAtTick / 30 + 2) demo.step();
  assert.equal(demo.stats().skill.active, false);
  assert.ok(demo.stats().skill.sp > 0);
  assert.equal(events.filter(event => event.type === 'DAMAGE').at(-1).amount, 312);
  assert.ok(events.some(event => event.type === 'SKILL_FINISHED'));
  demo.stop();
});

for (const type of ['NEURAL', 'EROSION', 'BURN', 'NECROSIS']) {
  test(`legacy render demo projects ${type} accumulation, burst and recovery`, async () => {
    const { demo, frames, visuals } = await createDemo(`ELEMENT_${type}`);
    demo.step();
    assert.equal(demo.stats().elementType, type);
    assert.equal(demo.stats().element.remainingEp, 600);
    const name = type === 'NECROSIS' ? 'apoptosis' : type.toLowerCase();
    assert.deepEqual(frames.at(-1).elem, [[1, name, 0.4, 0, 0]]);
    assert.equal(frames.at(-1).units.find(unit => unit[0] === 1)[4], 200000);

    while (demo.stats().elementBurstCount === 0 && demo.time < 10) demo.step();
    assert.ok(visuals.some(event => event[0] === 'fx' && event[1] === 'burst' && event[4].element === name));
    demo.seek(10);
    const snapshot = demo.snapshot();
    const target = snapshot.units.find(unit => unit.id === 1);
    assert.deepEqual(target.position, [6, 5]);
    assert.equal(target.elemental.recovery.type, type);
    assert.ok(demo.stats().elementDamageCount >= 3);
    assert.equal(demo.stats().elementBurstCount, 1);
    const duration = type === 'NECROSIS' ? 15 : type === 'EROSION' ? 8 : 10;
    assert.deepEqual(frames.at(-1).elem, [[
      1, name, 1, target.elemental.recovery.endsAtTick / 30, duration,
    ]]);

    demo.seek(0);
    demo.seek(10);
    assert.deepEqual(demo.snapshot(), snapshot);
    demo.reset();
    assert.equal(demo.stats().elementDamageCount, 0);
    assert.equal(demo.stats().elementBurstCount, 0);
    assert.deepEqual(frames.at(-1).elem, []);
    demo.stop();
  });
}
