// Synthetic integration: run against this worktree's isolated Vite on port 5199.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
 for (const lite of [false, true]) {
  const page = await browser.newPage();
  let worker = { id: 'product', name: 'Product Lead', deskId: 'station-product', status: 'needs_input', provider: 'codex', kind: 'agent', cols: 80, rows: 24, viewers: [], viewerIds: [] };
  let terminalInputRequired = false;
  const conversation = { id: 'product', title: 'Earlier discussion', count: 1, updatedAt: 1, messages: [{ id: 'old', role: 'user', content: 'Remember this discussion', at: 1 }] };
  await page.route('http://127.0.0.1:5199/', r => r.fulfill({contentType:'text/html', body:'<html><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/lite.css"><body><main id="screen"></main><div id="modal-root"></div></body></html>'}));
  await page.route('**/api/product/chat?*', r => r.fulfill({json:{worker, terminalInputRequired, conversations:[conversation], conversation:worker ? conversation : undefined, floor:'test', richReplies:true}}));
  await page.goto('http://127.0.0.1:5199/');
  await page.exposeFunction('requireTerminal', () => { terminalInputRequired = true; });
  await page.exposeFunction('killSession', () => { worker = undefined; });
  await page.evaluate(async lite => {
   const {store} = await import('/state.ts'); store.floor = 'test'; window.sent=[];
   const send = m => { window.sent.push(m); if(m.t==='worker.kill') window.killSession(); };
   if(lite) {
    const {agentWorkspace} = await import('/ui/maintenance-workspace.ts');
    window.view = agentWorkspace('product', {send,subscribe:receive=>{window.receive=receive;return ()=>{};},subtitle:()=>{},navigate:()=>{},terminal:()=>{}});
    document.querySelector('#screen').append(window.view.el);
   } else {
    const {openProductChat} = await import('/ui/product-chat.ts'); window.view = openProductChat(send,()=>{});
   }
  }, lite);
  await page.getByText('Remember this discussion', {exact:true}).waitFor();
  const sendButton = page.getByRole('button',{name:'Send',exact:true});
  assert.equal(await sendButton.isEnabled(), true, 'stale attention status allows chat replies');
  await page.getByRole('textbox',{name:lite?'Message to Product Lead':'Message to the Product Lead'}).fill('Ship the desktop app');
  await sendButton.click();
  const sent = await page.evaluate(()=>window.sent.find(m=>m.t==='product.chat.send'));
  assert.equal(sent.prompt, 'Ship the desktop app');
  assert.ok(sent.thread === undefined || sent.thread === 'product', 'reply targets the current conversation');
  assert.equal(sent.newConversation, undefined);
  await page.evaluate(async ({lite,id}) => {
    const receipt = {t:'product.chat.sent',id,workerId:'product'};
    if(lite) window.receive(receipt);
    else (await import('/ui/product-chat.ts')).onProductChatSent(receipt);
  }, {lite,id:sent.id});
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>(b.textContent==='Send'||b.getAttribute('aria-label')==='Send')&&!b.disabled));
  await page.screenshot({path:`/tmp/product-reply-${lite?'lite':'3d'}.png`});
  await page.evaluate(()=>window.requireTerminal());
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>(b.textContent==='Send'||b.getAttribute('aria-label')==='Send')&&b.disabled));
  assert.equal(await sendButton.isDisabled(), true, 'confirmed terminal prompt remains protected');
  await page.close();
 }
 console.log('Passed: Product Lead replies with stale attention status and confirmed terminal prompt protection in 3D and lite.');
} finally { await browser.close(); }
