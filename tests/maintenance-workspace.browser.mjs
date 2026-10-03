// Both shells exercise the same workspace, against synthetic API/transport fixtures only.
// Run with this worktree's Vite on 5199 and CHROMIUM_PATH set.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 980 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const repo = 'fixture/agent-office';
  let worker = { id: 'maintenance', name: 'Maintenance', status: 'done', deskId: 'station-maintenance', kind: 'agent', provider: 'codex', color: '#f08c00', createdAt: 1, cols: 80, rows: 24, viewers: [], viewerIds: [] };
  const stack = { phase: 'idle', dirty: 0, branch: 'maintenance/stack', changes: [{ sha: 'abcdef1', subject: 'Shared workspace change' }] };
  const image = { id: 'aabbccdd-0000-4000-8000-123456789abc', name: 'draft.png', type: 'image/png', size: 1 };
  const threads = {
    maintenance: { id: 'maintenance', title: 'Current task', createdAt: 1, updatedAt: 2, messages: [{ id: 'ready', role: 'assistant', content: '**Ready** for review', at: 1 }] },
    archive: { id: 'archive', title: 'Earlier task', createdAt: 1, updatedAt: 1, messages: [{ id: 'old', role: 'assistant', content: 'Archived response', at: 1 }] },
  };
  const issue = { number: 42, title: 'Queued feature', state: 'OPEN', url: `https://github.com/${repo}/issues/42`, labels: [{ name: 'maintenance:queued', color: 'f08c00' }], assignees: [] };
  await page.route('http://127.0.0.1:5199/', route => route.fulfill({ contentType: 'text/html', body: '<html><link rel="stylesheet" href="/lite.css"><body><div id="lite-sub"></div><main id="screen" class="lite-main"></main><div id="modal-root"></div></body></html>' }));
  await page.route('**/api/maintenance/chat?*', route => {
    const id = new URL(route.request().url()).searchParams.get('thread') ?? worker.id;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ worker, stack, richReplies: true, floor: 'fixture', work: [], conversations: Object.values(threads).map(({ messages, ...thread }) => ({ ...thread, count: messages.length })), conversation: threads[id] }) });
  });
  await page.route('**/api/maintenance/working', route => route.fulfill({ contentType: 'application/json', body: '{"files":"","diff":"","truncated":false}' }));
  await page.route('**/api/maintenance/change?*', route => route.fulfill({ contentType: 'application/json', body: '{"diff":"+ shared change","truncated":false}' }));
  await page.route('**/api/maintenance/image?*', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aIl8AAAAASUVORK5CYII=', 'base64') }));
  await page.goto('http://127.0.0.1:5199/');
  await page.evaluate(async ({ repo, issue, stack, image }) => {
    const { store } = await import('/state.ts'); window.store = store; store.floor = 'fixture'; store.maintenance = stack;
    store.maintenanceIssues = { repo, items: [issue], fetchedAt: 1, loading: false };
    const chat = await import('/ui/maintenance-chat.ts'); window.chat = chat;
    const terminal = await import('/ui/terminal.ts');
    const { net } = await import('/lite/ctx.ts');
    window.sent = []; window.watches = [];
    window.send = message => {
      sent.push(message);
      if (message.t === 'worker.attach') setTimeout(() => terminal.routeTerminalMessage({ t: 'term.snapshot', workerId: message.workerId, cols: 80, rows: 24, data: 'Fixture console\r\n' }), 0);
    };
    net.send = send;
    localStorage.clear();
    localStorage.setItem('agent-office.maintenance-draft-v1', JSON.stringify({ maintenance: { text: 'Migrated kiosk draft', attachments: [image] } }));
    window.openHost = async host => {
      if (host === '3d') {
        document.body.classList.remove('lite');
        window.view = chat.openMaintenanceChat(send, { correct() {}, watch: (...args) => watches.push(args) }, () => {});
      } else {
        document.body.classList.add('lite');
        const { agentChatScreen } = await import('/lite/agents.ts');
        window.view = agentChatScreen(['maintenance']);
        document.querySelector('#screen').append(view.el);
      }
    };
    window.closeHost = () => { if (view.close) view.close(); else { view.dispose(); view.el.remove(); } };
  }, { repo, issue, stack, image });
  const input = page.getByRole('textbox', { name: 'Message to Maintenance' });
  for (const host of ['3d', 'lite']) {
    await page.evaluate(host => openHost(host), host);
    await page.getByRole('tab', { name: /💬 Chat/ }).click();
    await page.locator('[data-message="ready"]').waitFor();
    if (host === '3d') {
      // Production can load style.css after the workspace CSS; its old kiosk rules must not squeeze the workspace into a column.
      await page.addStyleTag({ url: '/style.css?direct' });
      const fill = await page.evaluate(() => {
        const box = el => document.querySelector(el).getBoundingClientRect();
        return { layout: box('.maintenance-chat-layout').right, workspace: box('.lite-maintenance-workspace').right };
      });
      assert.ok(Math.abs(fill.layout - fill.workspace) < 2, `workspace fills the kiosk: ${JSON.stringify(fill)}`);
    }
    assert.equal(await input.inputValue(), host === '3d' ? 'Migrated kiosk draft' : 'Shared draft from 3d');
    assert.equal(await page.getByRole('button', { name: 'Remove draft.png', exact: true }).count(), 1);
    await input.fill(`Shared draft from ${host}`);
    for (const label of [/📌 Work/, /🚀 Review/, /💬 Chat/]) {
      await page.getByRole('tab', { name: label }).click();
      assert.equal(await page.locator('.maintenance-console-host').isVisible(), true);
    }
    assert.equal(await input.inputValue(), `Shared draft from ${host}`);
    await page.getByRole('tab', { name: /🚀 Review/ }).click();
    await page.getByRole('button', { name: '🧪 Run typecheck, tests & build', exact: true }).click();
    assert.ok(await page.evaluate(() => sent.some(message => message.t === 'maintenance.check')));
    await page.getByRole('button', { name: /🚀 Commit, push & rebuild/ }).click();
    await page.getByRole('button', { name: 'Ship it', exact: true }).click();
    assert.ok(await page.evaluate(() => sent.some(message => message.t === 'maintenance.ship')));
    if (host === '3d') {
      await page.locator('.lp-subview .lp-row').click();
      await page.getByRole('button', { name: '✍️ Correct this change', exact: true }).click();
      assert.match(await input.inputValue(), /Please correct stacked change abcdef1/);
      await page.getByRole('button', { name: 'Earlier task', exact: false }).click();
      await page.locator('[data-message="old"]').waitFor();
      assert.equal(await input.isDisabled(), true);
      await page.getByRole('button', { name: 'Current conversation', exact: true }).click();
      await page.locator('[data-message="ready"]').waitFor();
      await input.fill('Shared draft from 3d');
      // A shared history sheet closes independently of its parent kiosk modal.
      await page.getByRole('button', { name: 'Conversations', exact: true }).click();
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog', { name: 'Maintenance engineering workspace' }).count(), 1);
    }
    await page.getByRole('tab', { name: /📌 Work/ }).click();
    await page.getByRole('button', { name: 'Start next queued issue', exact: true }).click();
    const dispatched = await page.evaluate(() => sent.filter(message => message.t === 'maintenance.chat.send').at(-1));
    assert.equal(dispatched.maintenanceIssue, 42); assert.equal(dispatched.newConversation, true);
    // Rejecting dispatch retains the original draft and does not kill the worker.
    if (host === '3d') await page.evaluate(id => chat.onMaintenanceChatSent({ t: 'maintenance.chat.sent', id, error: 'Fixture rejection' }), dispatched.id);
    if (host === '3d') {
      await page.getByRole('tab', { name: /💬 Chat/ }).click();
      assert.equal(await input.inputValue(), 'Shared draft from 3d');
    }
    await page.screenshot({ path: `/tmp/maintenance-shared-${host}.png`, animations: 'disabled' });
    await page.evaluate(() => closeHost());
    assert.ok(await page.evaluate(() => sent.some(message => message.t === 'worker.detach')));
  }
  assert.equal(await page.evaluate(() => sent.some(message => message.t === 'worker.kill')), false);
  assert.deepEqual(errors, []);
  console.log('Passed: both hosts use shared tabs/actions/console, cross-view text and screenshot drafts, legacy migration, read-only archive, corrections, nested Esc, issue dispatch and cleanup.');
} finally { await browser.close(); }
