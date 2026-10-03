// Synthetic integration: run against this worktree's isolated Vite on port 5199.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
 for (const lite of [false, true]) {
  const page = await browser.newPage();
  let worker = { id: 'product', name: 'Product Lead', deskId: 'station-product', status: 'needs_input', provider: 'codex', kind: 'agent', cols: 80, rows: 24, viewers: [], viewerIds: [] };
  const conversation = { id: 'product', title: 'Earlier discussion', count: 1, updatedAt: 1, messages: [{ id: 'old', role: 'user', content: 'Remember this discussion', at: 1 }] };
  await page.route('http://127.0.0.1:5199/', r => r.fulfill({contentType:'text/html', body:'<html><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/lite.css"><body><main id="screen"></main><div id="modal-root"></div></body></html>'}));
  await page.route('**/api/product/chat?*', r => r.fulfill({json:{worker, conversations:[conversation], conversation:worker ? conversation : undefined, floor:'test', richReplies:true}}));
  await page.goto('http://127.0.0.1:5199/');
  await page.exposeFunction('killSession', () => { worker = undefined; });
  await page.evaluate(async lite => {
   const {store} = await import('/state.ts'); store.floor = 'test'; window.sent=[];
   const send = m => { window.sent.push(m); if(m.t==='worker.kill') window.killSession(); };
   if(lite) {
    const {agentWorkspace} = await import('/ui/maintenance-workspace.ts');
    window.view = agentWorkspace('product', {send,subscribe:()=>()=>{},subtitle:()=>{},navigate:()=>{},terminal:()=>{}});
    document.querySelector('#screen').append(window.view.el);
   } else {
    const {openProductChat} = await import('/ui/product-chat.ts'); window.view = openProductChat(send,()=>{});
   }
  }, lite);
  await page.getByText('Remember this discussion', {exact:true}).waitFor();
  if(lite) await page.evaluate(() => window.view.menu().find(a => a.label==='End the session').run());
  else await page.getByRole('button',{name:'End session',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'End session',exact:true}).click();
  const send = page.getByRole('button',{name:'Send',exact:true});
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b=>(b.textContent==='Send'||b.getAttribute('aria-label')==='Send')&&!b.disabled));
  assert.deepEqual(await page.evaluate(()=>window.sent.find(m=>m.t==='worker.kill')), {t:'worker.kill', workerId:'product'});
  await page.getByRole('textbox',{name:'Message to Product Lead'}).fill('Fresh context');
  await send.click();
  assert.equal(await page.evaluate(()=>window.sent.find(m=>m.t==='product.chat.send')?.newConversation),true);
  await page.screenshot({path:`/tmp/product-session-${lite?'lite':'3d'}.png`});
  await page.close();
 }
 console.log('Passed: active session termination and fresh-conversation sends in 3D and lite.');
} finally { await browser.close(); }
