// Isolated Work panel; run against this worktree's Vite on port 5199. No GitHub writes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let fail = true;
  const posts = [];
  await page.route('http://127.0.0.1:5199/', r => r.fulfill({ contentType: 'text/html', body: '<html><link rel="stylesheet" href="/style.css"><body><div id="panel"></div></body></html>' }));
  await page.route('**/api/maintenance/queue', r => {
    posts.push(r.request().postDataJSON());
    return r.fulfill({ status: fail ? 400 : 200, contentType: 'application/json', body: JSON.stringify(fail ? { error: 'Close denied' } : { ok: true }) });
  });
  await page.goto('http://127.0.0.1:5199/');
  await page.evaluate(async () => {
    const { workPanel } = await import('/ui/maintenance-work.ts');
    const { store } = await import('/state.ts');
    const repo = 'fork/office';
    const issue = (number, state = 'OPEN') => ({ number, state, title: `Issue ${number}`, url: `https://github.com/${repo}/issues/${number}`, labels: [], assignees: [] });
    store.maintenanceIssues = { repo, items: [issue(1), issue(2), issue(3, 'CLOSED')], fetchedAt: 1, loading: false };
    const state = { work: [1, 2].map(number => ({ ...issue(number), repo, status: number === 1 ? 'review' : 'running', workerId: `worker-${number}`, attachments: [], commits: [] })) };
    window.sent = []; window.refreshes = 0;
    const render = () => document.getElementById('panel').replaceChildren(workPanel(state, m => sent.push(m), () => {}, () => {}, () => {
      window.refreshes++;
      store.maintenanceIssues.items[0].state = 'CLOSED'; state.work.shift(); render();
    }, () => {}));
    render();
  });
  const close = page.getByRole('button', { name: 'Close issue #1', exact: true });
  assert.equal(await close.isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Close issue #2', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Close issue #3', exact: true }).count(), 0);
  await page.screenshot({ path: '/tmp/maintenance-close-work.png', animations: 'disabled' });
  await close.click();
  await page.getByRole('alert').filter({ hasText: "Couldn't close #1: Close denied" }).waitFor();
  assert.equal(await close.isEnabled(), true, 'Failed close allows retry');
  assert.equal(await page.evaluate(() => refreshes), 0);
  fail = false;
  await close.click();
  await page.waitForFunction(() => refreshes === 1);
  assert.deepEqual(posts, [{ number: 1, close: true }, { number: 1, close: true }]);
  assert.deepEqual(await page.evaluate(() => sent), [{ t: 'maintenance.issues' }]);
  assert.equal(await close.count(), 0);
  const historical = page.locator('article').filter({ hasText: '#1 · Issue 1' });
  assert.equal(await historical.count(), 1, 'Closed GitHub history remains');
  assert.equal(await historical.getByText('Session:', { exact: false }).count(), 0, 'Local work no longer renders');
  assert.deepEqual(errors, []);
  console.log('Passed: close availability, active-session guard, failure/retry, refresh and closed history without work tracking.');
} finally { await browser.close(); }
