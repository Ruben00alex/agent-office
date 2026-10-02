// Isolated mobile UI harness; no connection to the running office.
// Run this worktree's Vite on 127.0.0.1:5199 and set CHROMIUM_PATH.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let status = 'done';
  const product = () => ({ id: 'product', name: 'Product Lead', deskId: 'station-product', provider: 'claude', status, kind: 'agent', createdAt: 1, cols: 80, rows: 24, viewers: [], viewerIds: [] });
  const threads = {
    product: { id: 'product', title: 'Current discussion', count: 1, updatedAt: 2, messages: [{ id: 'current', role: 'user', content: 'Previous context', at: 2 }] },
    old: { id: 'old', title: 'Earlier discussion', count: 1, updatedAt: 1, messages: [{ id: 'archived', role: 'user', content: 'Archived context', at: 1 }] },
  };
  await page.route('http://127.0.0.1:5199/', r => r.fulfill({ contentType: 'text/html', body: '<html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/lite.css"><body class="lite"><header class="lite-bar"><div class="lite-heading"><h1 id="lite-title">Agents</h1><p id="lite-sub"></p></div></header><main id="screen" class="lite-main"></main><nav class="lite-nav"></nav><div id="toasts"></div><div id="modal-root"></div></body></html>' }));
  await page.route('**/api/product/chat?*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ worker: product(), floor: 'test', richReplies: true, conversations: Object.values(threads), conversation: threads[new URL(r.request().url()).searchParams.get('thread') ?? 'product'] }) }));
  await page.goto('http://127.0.0.1:5199/');
  await page.evaluate(async () => {
    const agents = await import('/lite/agents.ts');
    const { store } = await import('/state.ts');
    const { net } = await import('/lite/ctx.ts');
    window.store = store; window.sent = []; net.send = m => sent.push(m);
    store.floor = 'test';
    window.mount = kind => {
      window.active?.dispose?.();
      window.active = kind === 'product' ? agents.agentChatScreen(['product']) : agents.agentsScreen();
      document.getElementById('screen').replaceChildren(active.el);
      document.getElementById('lite-title').textContent = active.title;
    };
    window.boardStatus = (desk, status) => {
      store.workers.set(desk, { id: desk, name: 'Board agent', deskId: desk, provider: 'claude', status, kind: 'agent', createdAt: 1, cols: 80, rows: 24, viewers: [], viewerIds: [] });
      store.emit('workers');
    };
    mount('agents');
  });
  const checkLayout = async () => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'horizontal overflow');
    for (const button of await page.getByRole('button', { name: '➕ New conversation', exact: true }).all()) {
      const box = await button.boundingBox();
      assert.ok(box.height >= 44 && box.width >= 44, 'small touch target');
    }
  };
  await checkLayout();
  await page.screenshot({ path: '/tmp/issue25-mobile-agents.png', fullPage: true });
  for (const [name, desk] of [['Issues agent', 'station-issues'], ['PR agent', 'station-pulls']]) {
    const section = page.getByRole('region', { name, exact: true });
    const fresh = section.getByRole('button', { name: '➕ New conversation', exact: true });
    await page.evaluate(([desk]) => boardStatus(desk, 'working'), [desk]);
    await fresh.tap();
    await page.getByText(/is busy. Wait for it to finish before starting fresh/).last().waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.evaluate(([desk]) => boardStatus(desk, 'needs_input'), [desk]);
    await fresh.tap();
    await page.getByText(/waiting on an answer. Open its terminal/).last().waitFor();
    await page.evaluate(([desk]) => boardStatus(desk, 'done'), [desk]);
    await fresh.tap();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill(`Fresh ${desk}`);
    await dialog.getByRole('button', { name: 'Send ✨', exact: true }).tap();
    const message = await page.evaluate(() => sent.at(-1));
    assert.equal(message.t, 'station.prompt'); assert.equal(message.deskId, desk); assert.equal(message.newConversation, true);
    await page.waitForTimeout(200);
    await section.getByRole('button', { name: new RegExp(name) }).first().tap();
    await page.getByRole('dialog').getByRole('textbox').fill('Continue');
    await page.getByRole('dialog').getByRole('button', { name: 'Send ✨', exact: true }).tap();
    assert.equal(await page.evaluate(() => sent.at(-1).newConversation), undefined);
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => { document.getElementById('toasts').replaceChildren(); mount('product'); });
  await page.locator('[data-message="current"]').waitFor();
  await checkLayout();
  await page.screenshot({ path: '/tmp/issue25-mobile-product-narrow.png', fullPage: true });
  await page.getByRole('button', { name: '➕ New conversation', exact: true }).tap();
  await page.locator('.lp-chat-empty').waitFor();
  assert.equal(await page.locator('[data-message="current"]').count(), 0);
  await page.getByRole('button', { name: '🕘 History', exact: true }).tap();
  await page.getByRole('button', { name: /Earlier discussion/ }).tap();
  await page.locator('[data-message="archived"]').waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message to Product Lead' }).isDisabled(), true);
  await page.getByRole('button', { name: '➕ New conversation', exact: true }).tap();
  await page.getByRole('textbox', { name: 'Message to Product Lead' }).fill('Fresh product topic');
  await page.getByRole('button', { name: 'Send', exact: true }).tap();
  const freshProduct = await page.evaluate(() => sent.at(-1));
  assert.equal(freshProduct.t, 'product.chat.send'); assert.equal(freshProduct.newConversation, true); assert.equal(freshProduct.thread, undefined);
  for (status of ['working', 'needs_input']) {
    await page.evaluate(() => mount('product'));
    await page.locator('[data-message="current"]').waitFor();
    await page.getByRole('button', { name: '➕ New conversation', exact: true }).tap();
    await page.getByText(status === 'needs_input' ? 'Product Lead is waiting for an answer or approval. Open its terminal from ⋯ before starting a new conversation.' : 'Wait for the current reply to finish before starting a new conversation.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
  }
  status = 'done';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => mount('product'));
  await page.locator('[data-message="current"]').waitFor();
  await checkLayout();
  await page.screenshot({ path: '/tmp/issue25-mobile-product.png', fullPage: true });
  await page.evaluate(() => active.dispose());
  assert.deepEqual(errors, []);
  console.log('Mobile fresh-conversation controls, routing, history, busy feedback and touch layout passed.');
} finally { await browser.close(); }
