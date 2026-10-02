// Run this worktree's Vite on 127.0.0.1:5199; no live office connection.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const shell = readFileSync(new URL('../src/client/lite.html', import.meta.url), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
  await page.route('http://127.0.0.1:5199/', r => r.fulfill({ contentType: 'text/html', body: shell }));
  await page.goto('http://127.0.0.1:5199/');
  await page.evaluate(async () => {
    const { store } = await import('/state.ts');
    const ctx = await import('/lite/ctx.ts');
    window.ctx = ctx; window.sent = []; ctx.net.send = m => sent.push(m);
    store.project = { name: 'Test', provider: 'claude' };
    store.workers.set('test', { id: 'test', name: 'Ready worker', deskId: 'desk-1', kind: 'agent', status: 'done', color: '#fff' });
    ctx.sendToWorker('Hand issue #27 to a worker', { initial: 'Independent task', newTask: true, issue: 27 });
  });
  await page.getByRole('button', { name: /Ready worker/ }).tap();
  await page.getByRole('button', { name: 'Send ✨', exact: true }).tap();
  assert.deepEqual(await page.evaluate(() => sent.at(-1)), { t: 'worker.prompt', workerId: 'test', prompt: 'Independent task', newTask: true, issue: 27 });
  await page.evaluate(() => ctx.sendToWorker('Ask about issue #27', { context: 'Current task context' }));
  await page.getByRole('button', { name: /Ready worker/ }).tap();
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Follow-up');
  await page.getByRole('button', { name: 'Send ✨', exact: true }).tap();
  const followup = await page.evaluate(() => sent.at(-1));
  assert.equal(followup.newTask, false);
  assert.equal(followup.prompt, 'Current task context\n\nFollow-up');
  console.log('Mobile independent task handoff and current-task follow-up passed.');
} finally { await browser.close(); }
