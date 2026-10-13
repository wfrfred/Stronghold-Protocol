import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { startTacticalDemo } from '../../scripts/tactical-demo.mjs';

const chrome = process.env.CHROME_PATH;
const enabled = process.env.SP_E2E === '1' && chrome !== undefined && existsSync(chrome);

test('main-mode content renders in the existing demo with configuration, models, skills and replay', { skip: !enabled }, async () => {
  const server = await startTacticalDemo({ port: 0 });
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--ozone-platform=headless', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.__demo?.ready === true, { timeout: 45000 });
    assert.equal(new URL(page.url()).pathname, '/dev/render-demo.html');
    assert.equal(await page.$eval('#scene', element => element.value), 'core-content');
    assert.equal(await page.$eval('#content-controls', element => element.hidden), false);
    await page.click('#step');
    await page.waitForFunction(() => window.__demo.stats().spine?.ready >= 4, { timeout: 30000 });
    assert.equal((await page.evaluate(() => window.__demo.stats())).core.tickIndex, 1);
    await page.select('#content-module', 'uniequip_002_mudrok');
    await page.select('#content-module-level', '3');
    await page.$eval('#content-level', element => { element.value = '90'; });
    await page.$eval('#content-potential', element => { element.value = '5'; });
    await page.$eval('#content-skill-level', element => { element.value = '10'; });
    await page.click('#content-controls button[type="submit"]');
    await page.waitForFunction(() => window.__demo.stats().core?.content?.mudrock.maxHp === 4828);
    assert.equal((await page.evaluate(() => window.__demo.stats())).core.tickIndex, 0);
    await page.click('#next-skill-ready');
    await page.waitForFunction(() => window.__demo.stats().core.skill.ready === true);
    await page.click('#activate-skill');
    await page.waitForFunction(() => window.__demo.stats().core.skill.active === true);
    await page.evaluate(() => window.__demo.scene.seek(55));
    const stats = await page.evaluate(() => window.__demo.stats());
    assert.ok(stats.core.damageCount > 0);
    assert.ok(stats.core.attackCount > 0);
    assert.ok(stats.spine.ready >= 4);
    assert.equal(stats.spine.failed, 0);
    assert.deepEqual(errors, []);
    await page.waitForFunction(() => document.querySelector('#core-result').hidden === false);
    await page.locator('#reset').click();
    await page.waitForFunction(() => window.__demo.stats().core?.tickIndex === 0);
    assert.equal((await page.evaluate(() => window.__demo.stats())).core.content.mudrock.shieldLayers, 1);
    await page.evaluate(() => window.__demo.setScene('core-skill'));
    await page.waitForFunction(() => window.__demo.stats().scene === 'core-skill');
    assert.equal((await page.evaluate(() => window.__demo.stats())).core.skill.maxSp, 37);
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
