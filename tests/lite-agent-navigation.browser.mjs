// Isolated mobile router regression; never connects to the running office.
// Run this worktree's Vite on 127.0.0.1:5199 and set CHROMIUM_PATH.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const shell = readFileSync(new URL('../src/client/lite.html', import.meta.url), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
  await page.route('http://127.0.0.1:5199/', r => r.fulfill({ contentType: 'text/html', body: shell }));
  await page.route('**/api/maintenance/chat?*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ conversations: [], richReplies: true, floor: 'test', work: [] }) }));
  await page.route('**/api/product/chat?*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ conversations: [], richReplies: true, floor: 'test' }) }));
  await page.goto('http://127.0.0.1:5199/#/agent/maintenance');
  await page.evaluate(async () => {
    const app = await import('/lite/app.ts');
    const agents = await import('/lite/agents.ts');
    const { store } = await import('/state.ts');
    const { net } = await import('/lite/ctx.ts');
    window.sent = []; net.send = m => sent.push(m);
    store.floor = 'test';
    app.route('workers', 'workers', () => ({ title: 'Workers', el: document.createElement('div') }));
    app.route('agents', 'agents', agents.agentsScreen);
    app.route('agent', 'agents', agents.agentChatScreen);
    app.startRouter();
  });
  assert.equal(await page.locator('#lite-tabs').isVisible(), false, 'chat hides the tabs');
  const allAgents = page.getByRole('button', { name: '🧭 All agents', exact: true });
  const box = await allAgents.boundingBox();
  assert.ok(box.height >= 44 && box.width >= 44, 'agent navigation needs a touch target');
  await page.getByRole('textbox', { name: 'Message to Maintenance' }).fill('Keep my Maintenance draft');
  await page.screenshot({ path: '/tmp/issue25-maintenance-all-agents.png', fullPage: true });
  await allAgents.tap();
  await page.getByRole('heading', { name: 'Agents', exact: true }).waitFor();
  assert.equal(await page.locator('#lite-tabs').isVisible(), true);
  for (const name of ['Issues agent', 'PR agent']) {
    await page.getByRole('region', { name, exact: true }).getByRole('button', { name: '➕ New conversation', exact: true }).tap();
    await page.getByRole('dialog').getByRole('textbox').fill(`Start ${name}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Send ✨', exact: true }).tap();
    const message = await page.evaluate(() => sent.at(-1));
    assert.equal(message.t, 'station.prompt'); assert.equal(message.newConversation, true);
    await page.waitForTimeout(200);
  }
  await page.getByRole('button', { name: /Product Lead Think the project through/ }).tap();
  await page.getByRole('button', { name: '➕ New conversation', exact: true }).tap();
  await page.getByRole('textbox', { name: 'Message to Product Lead' }).fill('Start Product Lead');
  await page.getByRole('button', { name: 'Send', exact: true }).tap();
  assert.equal(await page.evaluate(() => sent.at(-1).t), 'product.chat.send');
  assert.equal(await page.evaluate(() => sent.at(-1).newConversation), true);
  await allAgents.tap();
  await page.getByRole('button', { name: /Maintenance Changes the office itself/ }).tap();
  await page.waitForFunction(() => document.querySelector('textarea')?.value === 'Keep my Maintenance draft');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await allAgents.isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await allAgents.tap();
  await page.getByRole('heading', { name: 'Agents', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Maintenance-to-agent-list touch navigation, all three conversation starts, and draft preservation passed.');
} finally { await browser.close(); }
