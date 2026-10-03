// Synthetic issue crafter and Work lanes: no live office, model or GitHub writes.
// Start this worktree's Vite client on 127.0.0.1:5199, then set CHROMIUM_PATH.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const repo = 'Ruben00alex/agent-office';
  const posted = [];
  let jobs = [];
  await page.route('http://127.0.0.1:5199/', r => r.fulfill({ contentType: 'text/html', body: '<html><link rel="stylesheet" href="/style.css"><body><div id="work" style="width:760px;margin:20px;"></div><div id="modal-root"></div><div id="toasts"></div></body></html>' }));
  await page.route('**/api/maintenance/issue-jobs', r => r.fulfill({ json: { jobs } }));
  await page.route('**/api/maintenance/issue', async r => {
    const body = r.request().postDataJSON(); posted.push(body);
    if (body.messages) {
      const id = `job-${posted.length}`;
      const turn = body.messages.filter(m => m.role === 'user').length;
      jobs = [{ id, title: body.title, body: body.body, status: 'drafting', queue: body.queue, writer: body.writer, attachments: [] }];
      // The writer answers on the next poll.
      setTimeout(() => { jobs = [{ ...jobs[0], status: 'ready', draft: turn === 1
        ? { reply: 'I drafted the issue from the Work tab code. Should finished issues close automatically when they ship?', title: 'Work tab queue never moves finished issues', body: '## Problem\nFinished issues stay **In progress**.\n\n## Acceptance criteria\n- Finished work moves to review', labels: ['bug', 'ui'] }
        : { reply: 'Added auto-closing on ship to the scope.', title: body.title, body: `${body.body}\n- Shipped work closes its issue`, labels: ['bug', 'ui', 'polish'] } }]; }, 300);
      return r.fulfill({ status: 202, json: jobs[0] });
    }
    return r.fulfill({ json: { ok: true } });
  });
  await page.goto('http://127.0.0.1:5199/');
  await page.evaluate(async repo => {
    const { store } = await import('/state.ts');
    const issue = (number, title, extra = {}) => ({ number, title, state: 'OPEN', url: `https://github.com/${repo}/issues/${number}`, author: 'Ruben00alex', labels: [], assignees: ['Ruben00alex'], updatedAt: new Date(Date.now() - number * 3600e3).toISOString(), createdAt: '', body: '', comments: 0, ...extra });
    const queued = { labels: [{ name: 'maintenance:queued', color: 'f08c00' }], assignees: [] };
    store.maintenanceIssues = { repo, fetchedAt: Date.now(), loading: false, items: [
      issue(51, 'Fix Product Lead blocking conversation replies', { assignees: [], labels: [{ name: 'bug', color: 'd73a4a' }] }),
      issue(45, 'Services board inaccessible over Tailscale', { labels: [{ name: 'server', color: 'bfdadc' }] }),
      issue(43, 'Polish Maintenance issue cards', { labels: [{ name: 'polish', color: 'f9d0c4' }, { name: 'ui', color: 'c5def5' }] }),
      issue(37, 'Approval grace period badge', { doneBy: 'commit 5a5d260 on main' }),
      issue(41, 'Add Maintenance lock-in mode', queued), issue(26, 'Give wall agents the shared chat UI', queued), issue(18, 'Exclude the Issues agent from worker limits', queued),
      issue(29, 'Make the 2D view polished', {}),
      issue(49, 'Missing close button and stale work items', { state: 'CLOSED' }), issue(48, 'Product Lead chat zoomed in', { state: 'CLOSED' }),
    ] };
    window.store = store;
    window.work = await import('/ui/maintenance-work.ts');
    window.crafter = await import('/ui/maintenance-issue-crafter.ts');
    const item = (number, status, commits = []) => ({ repo, number, title: '', url: '', status, by: 'Alex', at: 1, attachments: [], commits, workerId: status === 'running' || status === 'review' ? 'maintenance' : undefined });
    const state = { worker: { id: 'maintenance', status: 'working' }, work: [item(29, 'running'), item(43, 'review'), item(45, 'review', [{ sha: 'abc1234def', subject: 'Relay Tailscale service ports' }]), item(37, 'done', [{ sha: '5a5d260aaa', subject: 'Quiet the approval badge' }]), item(51, 'paused')], stack: { changes: [], phase: 'idle' } };
    window.renderWork = () => { const { head, list } = window.work.workPanelParts(state, () => {}, () => {}, () => {}, () => {}, () => {}); document.getElementById('work').replaceChildren(head, list); };
    window.renderWork();
  }, repo);

  // Lanes: in progress first, finished work waiting for review, then the queue oldest first.
  const lanes = await page.$$eval('.work-lane h4', hs => hs.map(h => h.textContent));
  assert.deepEqual(lanes.map(l => l.replace(/\d+$/, '')), ['🚧 In progress', '👀 Needs review', '⏳ Queued', '📥 Backlog', '✅ Closed']);
  assert.deepEqual(await page.$$eval('.lane-review .issue-number', n => n.map(x => x.textContent)), ['#37', '#43', '#45'], 'assigned issues whose agent finished leave In progress');
  assert.deepEqual(await page.$$eval('.lane-queued .issue-number', n => n.map(x => x.textContent)), ['#18', '#26', '#41']);
  assert.equal(await page.locator('.maintenance-add-orb').count(), 0, 'the orb only shows while drafting');
  assert.equal(await page.locator('details.lane-closed').getAttribute('open'), null, 'closed issues stay folded away');
  await page.locator('#work').screenshot({ path: '/tmp/maintenance-work-lanes.png', animations: 'disabled' });

  // The crafter: chat on the left, the issue filled in on the right.
  await page.evaluate(() => crafter.openIssueCrafter({ saved: () => { window.saved = true; } }));
  assert.equal(await page.getByRole('button', { name: 'Create issue' }).isDisabled(), true, 'a new issue is always the writer’s draft');
  await page.getByRole('textbox', { name: 'Message the issue writer' }).fill('The Work tab queue never updates when the agent finishes');
  await page.keyboard.press('Enter');
  await page.locator('.crafter-typing').waitFor();
  await page.evaluate(() => window.renderWork());
  assert.equal(await page.locator('.maintenance-add-orb').count() >= 1, true, 'the + Add issue orb shows while drafting');
  await page.screenshot({ path: '/tmp/maintenance-crafter-drafting.png', animations: 'disabled' });
  await page.getByText('Should finished issues close automatically').waitFor({ timeout: 5000 });
  assert.equal(await page.getByRole('textbox', { name: 'Issue title' }).inputValue(), 'Work tab queue never moves finished issues');
  assert.deepEqual(await page.$$eval('.crafter-label[aria-pressed="true"]', b => b.map(x => x.textContent)), ['bug', 'ui']);
  // A hand edit, then a refinement: the writer gets the edited draft and the whole conversation.
  await page.getByRole('textbox', { name: 'Issue title' }).fill('Work tab: move finished issues on');
  await page.getByRole('textbox', { name: 'Message the issue writer' }).fill('Yes, close them when they ship');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText('Added auto-closing on ship').waitFor({ timeout: 5000 });
  const turn = posted.filter(p => p.messages).at(-1);
  assert.equal(turn.title, 'Work tab: move finished issues on');
  assert.deepEqual(turn.messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.match(await page.locator('.crafter-preview').innerText(), /Shipped work closes its issue/);
  await page.screenshot({ path: '/tmp/maintenance-crafter.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Create issue' }).click();
  await page.locator('.issue-crafter').waitFor({ state: 'detached' });
  const created = posted.at(-1);
  assert.equal(created.confirm, true);
  assert.deepEqual(created.labels, ['bug', 'ui', 'polish']);
  assert.ok(await page.evaluate(() => window.saved));
  await page.setViewportSize({ width: 420, height: 860 });
  await page.evaluate(() => crafter.openIssueCrafter({ saved: () => {} }));
  await page.screenshot({ path: '/tmp/maintenance-crafter-narrow.png', animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log('Passed: lanes, review lane for finished work, drafting-only orb, crafter chat turns, hand edits kept, labels, create.');
} finally { await browser.close(); }
