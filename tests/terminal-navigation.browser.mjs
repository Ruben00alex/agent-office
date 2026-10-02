// Run against this worktree's isolated Vite preview; no live office or PTY required.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('http://127.0.0.1:5199/', r => r.fulfill({ contentType: 'text/html', body: '<html><link rel="stylesheet" href="/style.css"><body><div id="modal-root"></div></body></html>' }));
  await page.goto('http://127.0.0.1:5199/');
  await page.evaluate(async () => {
    await import('/style.css');
    const terminal = await import('/ui/terminal.ts');
    const { store } = await import('/state.ts');
    window.terminal = terminal; window.store = store; window.sent = [];
    for (const [i, name] of ['Ada', 'Sam', 'Maintenance'].entries()) store.workers.set(name, {
      id: name, name, kind: 'shell', status: 'working', color: '#06d6a0', createdAt: i,
      cols: 100, rows: 30, viewers: [], viewerIds: [],
    });
    const net = { send(m) {
      sent.push(m);
      if (m.t === 'worker.attach') setTimeout(() => terminal.routeTerminalMessage({
        t: 'term.snapshot', workerId: m.workerId, cols: 100, rows: 30,
        data: Array.from({ length: 150 }, (_, i) => `Output line ${i}\r\n`).join(''),
      }), 0);
    } };
    window.open = (id, navigation = true) => terminal.openTerminal(net, id, undefined, undefined,
      navigation ? { navigation: { workers: () => [...store.workers.values()], open: id => window.open(id) } } : {});
    window.open('Ada');
  });
  await page.waitForTimeout(100);
  assert.match(await page.locator('.term-navigation').innerText(), /↑ Maintenance/);
  assert.match(await page.locator('.term-navigation').innerText(), /↓ Sam/);
  const wheel = async (delta, shiftKey = true, horizontal = false) => page.evaluate(({ delta, shiftKey, horizontal }) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, shiftKey, deltaY: horizontal ? 0 : delta, deltaX: horizontal ? delta : 0 });
    return document.querySelector('.term-host .xterm').dispatchEvent(event);
  }, { delta, shiftKey, horizontal });
  assert.equal(await wheel(-100), false);
  assert.equal(await page.evaluate(() => terminal.openTerminalFor()), 'Maintenance');
  await wheel(100); // A burst must not immediately switch again.
  assert.equal(await page.evaluate(() => terminal.openTerminalFor()), 'Maintenance');
  await page.waitForTimeout(280);
  await wheel(100, true, true);
  assert.equal(await page.evaluate(() => terminal.openTerminalFor()), 'Ada');
  await page.waitForTimeout(280);
  await wheel(100);
  assert.equal(await page.evaluate(() => terminal.openTerminalFor()), 'Sam');
  await page.waitForTimeout(100);
  await page.screenshot({ path: '/tmp/agent-office-terminal-navigation.png' });
  // Ordinary wheel reaches xterm and scrolls the real scrollback.
  const viewport = page.locator('.xterm-rows');
  const before = await viewport.innerText();
  await page.locator('.term-host').hover();
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(350);
  assert.notEqual(await viewport.innerText(), before);
  assert.equal(await page.evaluate(() => terminal.openTerminalFor()), 'Sam');
  await page.keyboard.type('hello');
  assert.equal(await page.evaluate(() => sent.filter(m => m.t === 'term.input').map(m => m.data).join('')), 'hello');
  await page.evaluate(() => { store.workers.delete('Ada'); store.emit('workers'); });
  assert.match(await page.locator('.term-navigation').innerText(), /Sam · 1\/2/);
  await page.evaluate(() => { store.workers.delete('Maintenance'); store.emit('workers'); });
  await page.waitForTimeout(280);
  await wheel(100);
  assert.match(await page.locator('.term-navigation').innerText(), /no other workers/);
  assert.equal(await page.evaluate(() => terminal.openTerminalFor()), 'Sam');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.modal.term').count(), 0);
  await page.evaluate(() => window.open('Sam', false));
  assert.equal(await page.locator('.term-navigation').count(), 0);
  assert.equal(await wheel(100), true); // Other terminal flows do not intercept Shift + wheel.
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await page.evaluate(() => sent.filter(m => m.t === 'worker.attach').length), await page.evaluate(() => sent.filter(m => m.t === 'worker.detach').length));
  assert.deepEqual(errors, []);
  console.log('Terminal navigation browser checks passed');
} finally {
  await browser.close();
}
