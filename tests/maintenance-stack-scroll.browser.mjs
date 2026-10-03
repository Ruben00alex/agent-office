// Run against this worktree's Vite on port 5199 with CHROMIUM_PATH set.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const stack = { phase: 'idle', dirty: 0, branch: 'maintenance/stack', changes: Array.from({ length: 30 }, (_, i) => ({ sha: String(i).padStart(7, '0'), subject: `Stack change ${i}` })) };
  await page.route('http://127.0.0.1:5199/', r => r.fulfill({ contentType: 'text/html', body: '<html><link rel="stylesheet" href="/style.css"><body><div id="modal-root"></div></body></html>' }));
  await page.route('**/api/maintenance/chat?*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ stack, richReplies: true, conversations: [], floor: 'test' }) }));
  await page.route('**/api/maintenance/working', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ files: '', diff: '', truncated: false }) }));
  await page.goto('http://127.0.0.1:5199/');
  await page.evaluate(async stack => {
    const { store } = await import('/state.ts');
    store.floor = 'test'; store.maintenance = stack;
    const { openMaintenanceChat } = await import('/ui/maintenance-chat.ts');
    openMaintenanceChat(() => {}, { correct() {}, watch() {} });
  }, stack);
  await page.locator('.maintenance-rail-commit').first().waitFor();
  assert.equal(await page.locator('.maintenance-rail-commit').count(), 30);
  await page.getByRole('tab', { name: /🚀 Review/ }).click();
  for (const [width, height] of [[1640, 1000], [1024, 768], [800, 900], [390, 844], [700, 480]]) {
    await page.setViewportSize({ width, height });
    const result = await page.evaluate(() => {
      const rail = document.querySelector('.maintenance-console-rail');
      const main = document.querySelector('.maintenance-chat-main');
      const stack = document.querySelector('.lp-scroll');
      stack.scrollTop = stack.scrollHeight;
      stack.scrollIntoView({ block: 'end' });
      const last = [...stack.querySelectorAll('.lp-row')].at(-1).getBoundingClientRect();
      const bounds = stack.getBoundingClientRect();
      return { rail: rail.getBoundingClientRect().height, main: main.getBoundingClientRect().height, scroll: stack.scrollTop, reachable: last.bottom <= bounds.bottom && last.top >= bounds.top && last.bottom <= innerHeight && last.top >= 0, body: document.documentElement.scrollHeight <= innerHeight, width: document.documentElement.scrollWidth <= innerWidth };
    });
    if (width > 960) assert.ok(Math.abs(result.rail - result.main) < 2, JSON.stringify({ width, result }));
    assert.ok(result.scroll > 0 && result.reachable && result.body && result.width, JSON.stringify({ width, result }));
    await page.screenshot({ path: `/tmp/maintenance-stack-${width}.png`, animations: 'disabled' });
  }
  console.log('Passed: all 30 Review commits reachable, equal desktop panel heights and no document overflow across five viewports.');
} finally { await browser.close(); }
