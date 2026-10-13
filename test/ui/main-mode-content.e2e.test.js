import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { startTacticalDemo } from '../../scripts/tactical-demo.mjs';

const chrome = process.env.CHROME_PATH;
const enabled = process.env.SP_E2E === '1' && chrome !== undefined && existsSync(chrome);

test('main-mode demo applies configuration, steps, runs skills and arrows, and resets', { skip: !enabled }, async () => {
  const server = await startTacticalDemo({ port: 0 });
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(new URL(page.url()).pathname, '/dev/content-demo.html');
    await page.waitForFunction(() => document.querySelector('#stats').textContent.includes('泥岩'));
    await page.click('#step');
    assert.match(await page.$eval('#clock', element => element.textContent), /0\.03 s/);
    await page.select('#module', 'uniequip_002_mudrok');
    await page.select('#module-level', '3');
    await page.$eval('#level', element => { element.value = '90'; });
    await page.$eval('#potential', element => { element.value = '5'; });
    await page.$eval('#skill-level', element => { element.value = '10'; });
    await page.click('button[type="submit"]');
    assert.match(await page.$eval('#clock', element => element.textContent), /^0\.00 s$/);
    assert.match(await page.$eval('#stats', element => element.textContent), /4828 \/ 4828/);
    assert.match(await page.$eval('#stats', element => element.textContent), /ATK 962\.0  DEF 691\.0/);
    await page.evaluate(() => {
      for (let second = 0; second < 55; second++) {
        document.querySelector('#second').click();
        if (!document.querySelector('#skill').disabled) document.querySelector('#skill').click();
      }
    });
    const stats = await page.$eval('#stats', element => element.textContent);
    assert.match(stats, /技能激活 [1-9]\d*/);
    assert.match(stats, /弩箭命中 [1-9]\d*/);
    assert.equal(await page.$eval('#error', element => element.textContent), '');
    assert.deepEqual(errors, []);
    await page.click('#reset');
    assert.match(await page.$eval('#stats', element => element.textContent), /盾 1/);
    assert.match(await page.$eval('#clock', element => element.textContent), /^0\.00 s$/);
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
