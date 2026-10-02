// Synthetic /lite Maintenance integration; run against this worktree's Vite on port 5199.
import { chromium } from 'playwright-core';
const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
try {
 const page = await browser.newPage({viewport:{width:1360,height:980}});
 const errors=[]; page.on('pageerror', e=>errors.push(e.message));
 await page.route('http://127.0.0.1:5199/', r=>r.fulfill({contentType:'text/html',body:'<html><link rel="stylesheet" href="/lite.css"><body class="lite"><div id="lite-sub"></div><main id="screen" class="lite-main"></main><div id="modal-root"></div></body></html>'}));
 const worker={id:'maintenance',createdAt:1,name:'Maintenance',status:'done',deskId:'station-maintenance',provider:'codex',kind:'agent',color:'#f08c00',cols:80,rows:24,viewers:[],viewerIds:[]};
 const stack={phase:'idle',changes:[{sha:'abcdef1',subject:'A stacked change'}],dirty:0,branch:'maintenance/stack'};
 await page.route('**/api/maintenance/chat?*', r=>r.fulfill({contentType:'application/json',body:JSON.stringify({worker,stack,floor:'test',richReplies:true,conversations:[],conversation:{id:'maintenance',messages:[{id:'m1',role:'assistant',content:'Ready for review',at:1}]}})}));
 await page.route('**/api/maintenance/working', r=>r.fulfill({contentType:'application/json',body:JSON.stringify({files:'',diff:'',truncated:false})}));
 await page.goto('http://127.0.0.1:5199/');
 await page.evaluate(async()=>{
  const {store}=await import('/state.ts'); store.floor='test';
  const {net}=await import('/lite/ctx.ts'); window.sent=[]; net.send=m=>sent.push(m);
  const {agentChatScreen}=await import('/lite/agents.ts'); window.screenView=agentChatScreen(['maintenance']);
  document.querySelector('#screen').append(screenView.el);
 });
 const input=page.getByRole('textbox',{name:'Message to Maintenance'});
 await input.fill('Keep the lite draft');
 for(const name of ['📌 Work','🚀 Review','💬 Chat']) {
  await page.getByRole('tab',{name:new RegExp(name)}).click();
  if(!await page.locator('.maintenance-console-host').isVisible())throw Error('Console missing on '+name);
 }
 if(await input.inputValue()!=='Keep the lite draft')throw Error('Draft lost');
 await page.getByRole('tab',{name:/🚀 Review/}).click();
 await page.getByRole('button',{name:'🚀 Commit, push & rebuild',exact:true}).click();
 await page.getByRole('button',{name:'Ship it',exact:true}).click();
 if(!await page.evaluate(()=>sent.some(m=>m.t==='maintenance.ship')))throw Error('Shipping not wired');
 await page.screenshot({path:'/tmp/maintenance-36-lite-desktop.png',animations:'disabled'});
 await page.getByRole('tab',{name:/📌 Work/}).click();
 await page.getByRole('tab',{name:/🚀 Review/}).click();
 if(!await page.getByRole('button',{name:'🔹 A stacked change abcdef1 ›'}).count() && !await page.getByText('A stacked change',{exact:true}).isVisible())throw Error('Review lost on return from Work');
 await page.setViewportSize({width:390,height:844});
 if(await page.locator('.lite-maintenance-console').isVisible())throw Error('Mobile layout changed');
 await page.getByRole('tab',{name:/💬 Chat/}).click();
 if(await input.inputValue()!=='Keep the lite draft')throw Error('Resize lost draft');
 await page.screenshot({path:'/tmp/maintenance-36-lite-mobile.png',animations:'disabled'});
 await page.evaluate(()=>screenView.dispose());
 if(!await page.evaluate(()=>sent.some(m=>m.t==='worker.detach')))throw Error('Console subscription leaked');
 if(errors.length)throw Error(errors.join('; '));
 console.log('Passed: /lite tabs, draft persistence, persistent desktop console, shipping, Review return, mobile layout and console cleanup.');
} finally {await browser.close();}
