// Synthetic integration: run against this worktree's isolated Vite on port 5199.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
 for (const kind of ['product', 'maintenance']) for (const lite of [false, true]) {
  const name = kind === 'product' ? 'Product Lead' : 'Maintenance';
  const page = await browser.newPage();
  let worker = { id: kind, name, deskId: `station-${kind}`, status: 'needs_input', provider: 'codex', kind: 'agent', cols: 80, rows: 24, viewers: [], viewerIds: [] };
  let terminalInputRequired = false;
  const conversation = { id: kind, title: 'Earlier discussion', count: 1, updatedAt: 1, messages: [{ id: 'old', role: 'user', content: 'Remember this discussion', at: 1 }] };
  await page.route('http://127.0.0.1:5199/', r => r.fulfill({contentType:'text/html', body:'<html><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/lite.css"><body><main id="screen"></main><div id="modal-root"></div></body></html>'}));
  await page.route(`**/api/${kind}/chat?*`, r => r.fulfill({json:{worker, terminalInputRequired, conversations:[conversation], conversation:worker ? conversation : undefined, floor:'test', richReplies:true}}));
  await page.goto('http://127.0.0.1:5199/');
  await page.exposeFunction('requireTerminal', () => { terminalInputRequired = true; });
  await page.exposeFunction('killSession', () => { worker = undefined; });
  await page.evaluate(async ({lite,kind}) => {
   const {store} = await import('/state.ts'); store.floor = 'test'; window.sent=[];
   if(kind==='product') localStorage.setItem('agent-office.product-draft-v1',JSON.stringify({'test:product':'Saved kiosk draft'}));
   const send = m => { window.sent.push(m); if(m.t==='worker.kill') window.killSession(); };
   if(lite) {
    const {agentWorkspace} = await import('/ui/maintenance-workspace.ts');
    window.view = agentWorkspace(kind, {send,subscribe:receive=>{window.receive=receive;return ()=>{};},subtitle:()=>{},navigate:()=>{},terminal:()=>{}});
    document.querySelector('#screen').append(window.view.el);
   } else {
    const {openAgentChat} = await import('/ui/agent-chat-modal.ts'); window.view = openAgentChat(kind,send,{watch:()=>{},correct:()=>{}});
   }
  }, {lite,kind});
  await page.getByText('Remember this discussion', {exact:true}).waitFor();
  if(kind==='product') assert.equal(await page.getByRole('textbox',{name:`Message to ${name}`}).inputValue(),'Saved kiosk draft','existing Product Lead draft survives consolidation');
  const sendButton = page.getByRole('button',{name:'Send',exact:true});
  assert.equal(await sendButton.isEnabled(), true, 'stale attention status allows chat replies');
  await page.getByRole('textbox',{name:`Message to ${name}`}).fill('Ship the desktop app');
  await sendButton.click();
  const sent = await page.evaluate(kind=>window.sent.find(m=>m.t===`${kind}.chat.send`),kind);
  assert.equal(sent.prompt, 'Ship the desktop app');
  assert.ok(sent.thread === undefined || sent.thread === kind, 'reply targets the current conversation');
  assert.equal(sent.newConversation, undefined);
  await page.evaluate(async ({lite,id,kind}) => {
    const receipt = {t:`${kind}.chat.sent`,id,workerId:kind};
    if(lite) window.receive(receipt);
    else (await import('/ui/agent-chat-modal.ts')).onAgentChatSent(receipt);
  }, {lite,id:sent.id,kind});
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>(b.getAttribute('aria-label')==='Send')&&!b.disabled));
  await page.screenshot({path:`/tmp/${kind}-reply-${lite?'lite':'3d'}.png`});
  await page.evaluate(()=>window.requireTerminal());
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>(b.getAttribute('aria-label')==='Send')&&b.disabled));
  assert.equal(await sendButton.isDisabled(), true, 'confirmed terminal prompt remains protected');
  await page.close();
 }
 console.log('Passed: Maintenance and Product Lead replies with stale attention status and confirmed terminal prompt protection in 3D and lite.');
} finally { await browser.close(); }
