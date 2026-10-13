import { create, defaults } from '/dist/content/tactical/scenario.js';
import { readShield } from '/dist/content/tactical/operators/mudrock.js';
import { TICKS_PER_SECOND } from '/dist/core/tactical/tick.js';

const byId = id => document.getElementById(id);
const tables = await fetch('/fixtures/main-mode-units.json').then(response => {
  if (!response.ok) throw new Error(`数据加载失败：${response.status}`);
  return response.json();
});
const canvas = byId('battlefield');
const context = canvas.getContext('2d');
const names = { char_311_mudrok: '泥岩', char_208_melan: '玫兰莎', enemy_1000_gopro: '猎狗', enemy_1003_ncbow: '弩手' };
let configuration = defaults;
let scene;
let playing = false;
let elapsed = 0;
let previousTime;
let log = [];
let counters;

function selected() {
  const number = id => Number(byId(id).value);
  const module = byId('module').value;
  return { ...defaults, seed: number('seed'), mudrock: {
    elite: number('elite'), level: number('level'), potential: number('potential'), skillIndex: 1,
    skillLevel: number('skill-level'), trust: number('trust'),
    ...(module ? { module: { id: module, level: number('module-level') } } : {}),
  } };
}

function reset(next = configuration) {
  const prepared = create(tables, next);
  scene = prepared;
  configuration = next;
  playing = false;
  elapsed = 0;
  log = [];
  counters = { damage: 0, shield: 0, heals: 0, skills: 0, arrows: 0 };
  byId('error').textContent = '';
  render();
}

function advance(commands = []) {
  if (scene.runtime.result) return;
  const step = scene.runtime.step(commands);
  for (const event of step.events) {
    if (event.type === 'DAMAGE') {
      counters.damage++;
      if (event.amount === 0 && event.targetUnitId === 0) counters.shield++;
      log.push(`${(event.tick / 30).toFixed(1)}s #${event.targetUnitId} 伤害 ${event.amount.toFixed(1)}`);
    } else if (event.type === 'HEAL') {
      counters.heals++;
      log.push(`${(event.tick / 30).toFixed(1)}s #${event.targetUnitId} 回复 ${event.amount.toFixed(1)}`);
    } else if (event.type === 'SKILL_ACTIVATED' || event.type === 'SKILL_FINISHED') {
      if (event.type === 'SKILL_ACTIVATED') counters.skills++;
      log.push(`${(event.tick / 30).toFixed(1)}s ${event.unitId === 0 ? '泥岩' : '玫兰莎'} 技能${event.type === 'SKILL_ACTIVATED' ? '激活' : '结束'}`);
    } else if (event.type === 'PROJECTILE_HIT') counters.arrows++;
  }
  log = log.slice(-14);
}

function render() {
  const snapshot = scene.runtime.snapshot();
  context.clearRect(0, 0, canvas.width, canvas.height);
  const point = position => [50 + position[0] * 100, 50 + position[1] * 100];
  context.strokeStyle = '#33473c';
  for (let row = 0; row < 5; row++) for (let col = 0; col < 10; col++) {
    context.fillStyle = row === 1 || row === 3 ? '#253c30' : '#1b2922';
    context.fillRect(col * 100, row * 100, 100, 100);
    context.strokeRect(col * 100, row * 100, 100, 100);
  }
  for (const relation of snapshot.blockingRelations) {
    const blocker = snapshot.units.find(unit => unit.id === relation.blockerUnitId);
    const blocked = snapshot.units.find(unit => unit.id === relation.blockedUnitId);
    if (!blocker || !blocked) continue;
    context.strokeStyle = '#83ddb4';
    context.beginPath();context.moveTo(...point(blocker.position));context.lineTo(...point(blocked.position));context.stroke();
  }
  for (const projectile of snapshot.projectiles.instances) {
    const [x, y] = point(projectile.position);
    context.fillStyle = '#ffd675';context.fillRect(x - 5, y - 2, 10, 4);
  }
  for (const unit of snapshot.units) {
    const [x, y] = point(unit.position);
    const ally = unit.allegiance?.side === 'ALLY';
    const shield = readShield(unit);
    context.fillStyle = ally ? '#53bb97' : unit.definition.id === 'enemy_1003_ncbow' ? '#d6a362' : '#c77268';
    context.beginPath();context.arc(x, y, ally ? 23 : 14, 0, Math.PI * 2);context.fill();
    if (shield?.layers) {
      context.strokeStyle = '#8edcf7';context.lineWidth = 3;
      context.beginPath();context.arc(x, y, 30, 0, Math.PI * 2);context.stroke();context.lineWidth = 1;
    }
    const hp = unit.vitality.hp / unit.definition.vitality.maxHp;
    context.fillStyle = '#14201a';context.fillRect(x - 28, y - 40, 56, 5);
    context.fillStyle = '#9fdd94';context.fillRect(x - 28, y - 40, 56 * hp, 5);
    context.fillStyle = '#e4eeea';context.font = '13px system-ui';context.textAlign = 'center';
    context.fillText(`${names[unit.definition.id]} #${unit.id}`, x, y + 46);
    if (shield) context.fillText(`盾 ${shield.layers}`, x, y + 5);
  }
  const heroStats = snapshot.units.filter(unit => unit.allegiance?.side === 'ALLY').map(unit => {
    const shield = readShield(unit);
    return `${names[unit.definition.id]} HP ${unit.vitality.hp.toFixed(0)} / ${unit.definition.vitality.maxHp.toFixed(0)}\n` +
      `基础ATK ${unit.definition.offense.attack.toFixed(1)}  DEF ${unit.definition.defense.defense.toFixed(1)}  SP ${unit.skill.sp}/${unit.definition.skill.spCost}` +
      (shield ? `\n盾 ${shield.layers} · 充能 ${(shield.timer / 30).toFixed(1)}s` : '') +
      `\n技能 ${unit.skill.active ? '激活中' : '待机'}`;
  });
  byId('clock').textContent = `${(snapshot.tickIndex / 30).toFixed(2)} s${snapshot.result ? ` · ${snapshot.result.reason === 'TIME_LIMIT' ? '到达时间限制' : '练习结束'}` : ''}`;
  byId('stats').textContent = heroStats.join('\n\n') + `\n\n阻挡 ${snapshot.blockingRelations.length} · 敌人 ${snapshot.units.length - heroStats.length}\n伤害 ${counters.damage} · 挡伤 ${counters.shield} · 回复 ${counters.heals}\n技能激活 ${counters.skills} · 弩箭命中 ${counters.arrows}`;
  byId('events').textContent = log.join('\n');
  byId('play').textContent = playing ? '暂停' : '播放';
  const guard = snapshot.units.find(unit => unit.id === 1);
  byId('skill').disabled = !guard || guard.skill.active !== null || guard.skill.sp < guard.definition.skill.spCost || snapshot.result !== null;
}

function perform(action) {
  try { action();render(); } catch (error) {
    playing = false;
    byId('play').textContent = '播放';
    byId('error').textContent = error.message;
  }
}
byId('configuration').addEventListener('submit', event => { event.preventDefault();perform(() => reset(selected())); });
byId('play').addEventListener('click', () => perform(() => { playing = !playing;elapsed = 0; }));
byId('step').addEventListener('click', () => perform(() => { playing = false;advance(); }));
byId('second').addEventListener('click', () => perform(() => { playing = false;for (let tick = 0; tick < 30; tick++) advance(); }));
byId('reset').addEventListener('click', () => perform(() => reset()));
byId('skill').addEventListener('click', () => perform(() => advance([{ type: 'ACTIVATE_SKILL', unitId: 1 }])));
function frame(time) {
  if (playing) perform(() => {
    elapsed += Math.min(0.1, (time - (previousTime ?? time)) / 1000) * TICKS_PER_SECOND;
    while (elapsed >= 1 && !scene.runtime.result) { advance();elapsed--; }
    if (scene.runtime.result) playing = false;
  });
  previousTime = time;
  requestAnimationFrame(frame);
}
reset();
requestAnimationFrame(frame);
