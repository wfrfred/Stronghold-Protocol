import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';
import { spineEntry } from '../../public/js/assets.js';

const manifest = JSON.parse(readFileSync(new URL('../../data/assets.json', import.meta.url)));
let fake, UnitView, renderInfo;
before(async () => {
  fake = installFakePixi();
  ({ UnitView } = await import('../../public/js/render/units.js'));
  ({ renderInfo } = await import('../../public/js/render/app.js'));
});
after(() => fake.restore());

async function viewFor(spine, animation, side = 'ally') {
  const entry = spineEntry(manifest, spine);
  assert.ok(entry, `model exists: ${spine}`);
  const assets = {
    picture: () => null, image: async () => null, spineEntry: () => entry,
    spine: { acquire: async () => ({ animations: Object.keys(entry.animations).map(name => ({ name })) }), release() {} },
  };
  const cam = () => presetCamera('prep', { width: 1280, height: 720 });
  const info = renderInfo({ id: 1, kind: side === 'ally' ? 'op' : 'enemy', side,
    defId: spine, spine, x: 5, y: 10, maxHp: 1000, skillIndex: 1, animation });
  assert.strictEqual(info.animation, animation);
  const view = new UnitView(fakeViewCtx(fake.P, { assets, cam }), info);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(view.actor);
  return view;
}

test('Mudrock plays ordinary attacks and one S2 spin without the S3 lift or skill-stop interruption', async () => {
  const view = await viewFor('char_311_mudrok', { attack: 'Attack', skillAttack: 'Skill_1', skill: 'ATTACK' });
  view.onAttack(null, 0, 'none');
  assert.equal(view.actor.current, 'Attack');
  view.actor.update(view.actor.attackUntil + 0.01);
  assert.equal(view.actor.current, 'Idle');
  view.actor.setSkill(true);
  assert.equal(view.actor.current, 'Idle');
  view.onAttack(null, 4, 'none', { skill: true });
  assert.equal(view.actor.current, 'Skill_1');
  assert.equal(view.actor.spine.state.tracks[0].loop, false);
  assert.equal(view.actor.spine.state.tracks[0].trackTime, 0, 'a cast without wind-up plays the full spin');
  view.actor.setSkill(false);
  assert.equal(view.actor.current, 'Skill_1');
  view.actor.update(view.actor.attackUntil - view.actor.clock + 0.01);
  assert.equal(view.actor.current, 'Idle');
});

test('Melantha attack buff rests between real attacks instead of autoplaying Attack_Loop', async () => {
  const view = await viewFor('char_208_melan', { skill: 'BUFF' });
  view.actor.setSkill(true);
  assert.equal(view.actor.current, 'Idle');
  view.onAttack(null, 0, 'none');
  assert.equal(view.actor.current, 'Attack_Loop');
  assert.equal(view.actor.spine.state.tracks[0].loop, false);
  view.actor.update(view.actor.attackUntil - view.actor.clock + 0.01);
  assert.equal(view.actor.mode, 'base');
  assert.equal(view.actor.spine.state.tracks[0].loop, false, 'only the closing attack clip plays before queued Idle');
  assert.equal(view.actor.current, 'Attack_End');
  view.actor.setSkill(false);
  assert.equal(view.actor.current, 'Attack_End', 'ending the buff does not interrupt an attack');
});

test('Mudrock S2 with buffered wind-up completes the remaining spin without holding its last frame', async () => {
  const view = await viewFor('char_311_mudrok', { attack: 'Attack', skillAttack: 'Skill_1', skill: 'ATTACK' });
  assert.equal(view.windUp(0.1, 'none', { skill: true }), true);
  const actor = view.actor;
  const hit = actor._hitTime('Skill_1', actor.dur('Skill_1'));
  actor.spine.state.tracks[0].trackTime = hit;
  view.onAttack(null, 4, 'none', { skill: true });
  assert.ok(Math.abs(actor.attackUntil - actor.clock - (actor.dur('Skill_1') - hit)) < 1e-9);
  actor.update(actor.attackUntil - actor.clock + 0.01);
  assert.equal(actor.current, 'Idle');
});

test('crossbow shot finishes its real recovery before walking and has no melee lunge', async () => {
  const view = await viewFor('enemy_1003_ncbow', { recoverySeconds: 6 / 30, lunge: false }, 'enemy');
  view.atkInterval = 3;
  view.onAttack({ x: 6, y: 10 }, 0, 'none');
  assert.equal(view.actor.current, 'Attack');
  assert.equal(view.lunge, 0);
  assert.ok(Math.abs(view.actor.attackUntil - view.actor.clock - 0.2) < 1e-9);
  view.actor.setBase('move');
  view.actor.update(0.19);
  assert.equal(view.actor.current, 'Attack');
  view.actor.update(0.02);
  assert.equal(view.actor.mode, 'base');
  assert.equal(view.actor.current, 'Move_Loop');
});
