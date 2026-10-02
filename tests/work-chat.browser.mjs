// Isolated Vite UI fixture; never connects to the live office or a model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 } });
    const shell = readFileSync(new URL('../src/client/lite.html', import.meta.url), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
    await page.route('http://127.0.0.1:5199/', r => r.fulfill({ contentType: 'text/html', body: shell }));
    await page.goto('http://127.0.0.1:5199/');
    await page.evaluate(async () => {
      const { openWorkChat } = await import('/ui/work-chat.ts');
      window.sent = [];
      window.receive = null;
      window.launch = () => openWorkChat({ up: true, send: m => sent.push(m) }, { id: 'worker-1', name: 'Ada', provider: 'claude', status: 'working' }, fn => { window.receive = fn; return () => { window.receive = null; }; });
      launch();
    });
    await page.getByRole('textbox', { name: 'Question about work' }).fill('What are you testing?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    const request = await page.evaluate(() => sent[0]);
    assert.equal(request.t, 'worker.work.ask');
    assert.equal(request.question, 'What are you testing?');
    assert.equal(await page.getByRole('button', { name: 'Ask', exact: true }).isDisabled(), true);
    await page.evaluate(() => receive({ t: 'worker.work.answer', id: sent[0].id, model: 'haiku', answer: 'Ada is checking the worker chat.' }));
    await page.getByText('Ada is checking the worker chat.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Ask', exact: true }).isDisabled(), false);
    await page.screenshot({ path: `/tmp/work-chat-${mobile ? 'mobile' : 'desktop'}.png` });
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.evaluate(() => receive({ t: 'worker.work.answer', id: sent[1].id, model: 'haiku', error: 'Model unavailable' }));
    await page.getByText('Model unavailable', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await page.evaluate(() => receive), null);
    await page.evaluate(() => launch());
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.ok((await page.evaluate(() => sent)).every(m => m.t === 'worker.work.ask'));
    await page.close();
  }
  console.log('Desktop and mobile observer chat: requests, replies, errors, pending state, close, and Esc passed.');
} finally { await browser.close(); }
