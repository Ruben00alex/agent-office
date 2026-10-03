// Isolated Vite on 127.0.0.1:5199; synthetic data, no live office connection.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH, args:['--no-sandbox']});
try {
  for (const [width,height] of [[1360,980],[1024,600],[700,700],[600,600],[390,844],[390,500]]) {
    const page = await browser.newPage({viewport:{width,height}});
    const messages = Array.from({length:60}, (_,i)=>({id:`m${i}`,role:i%2?'assistant':'user',content:`Message ${i}: ${'A long discussion of the project. '.repeat(20)}`,at:i+1}));
    const worker = {id:'product',name:'Product Lead',deskId:'station-product',status:'idle',provider:'codex',kind:'agent',cols:80,rows:24,viewers:[],viewerIds:[]};
    const conversation = {id:'product',title:'A long project discussion',count:messages.length,updatedAt:60,messages};
    await page.route('http://127.0.0.1:5199/', r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><body><div id="modal-root"></div></body></html>'}));
    await page.route('**/api/product/chat?*',r=>r.fulfill({json:{worker,conversation,conversations:[conversation],floor:'test',richReplies:true}}));
    await page.goto('http://127.0.0.1:5199/');
    await page.evaluate(async()=>{
      const {store}=await import('/state.ts'); store.floor='test';
      const {openProductChat}=await import('/ui/product-chat.ts');openProductChat(()=>{},()=>{});
    });
    await page.locator('[data-message="m59"]').waitFor();
    const dimensions = await page.evaluate(()=>{
      const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height};};
      const list=document.querySelector('.maintenance-chat-messages');
      return {modal:box('.product-chat'),list:box('.maintenance-chat-messages'),composer:box('.maintenance-chat-composer'),send:box('.maintenance-send'),scrollHeight:list.scrollHeight,clientHeight:list.clientHeight};
    });
    console.log(`Passed Product Lead scrolling and visible controls at ${width}×${height}`);
    await page.screenshot({path:`/tmp/product-chat-layout-${width}-${height}.png`});
    assert.ok(dimensions.modal.top>=0 && dimensions.modal.bottom<=height, 'modal fits viewport');
    assert.ok(dimensions.composer.bottom<=dimensions.modal.bottom, 'composer fits modal');
    assert.ok(dimensions.send.bottom<=height && dimensions.send.left>=0 && dimensions.send.right<=width,'Send is in viewport');
    assert.ok(dimensions.list.top>=dimensions.modal.top && dimensions.list.bottom<=dimensions.composer.top, 'messages fit above composer');
    assert.ok(dimensions.clientHeight>40 && dimensions.scrollHeight>dimensions.clientHeight,'messages have a bounded scroll area');
    await page.locator('.maintenance-chat-messages').evaluate(el=>el.scrollTop=0);
    await page.locator('.maintenance-chat-messages').hover();
    await page.mouse.wheel(0,500);
    await page.waitForFunction(()=>document.querySelector('.maintenance-chat-messages').scrollTop>0);
    await page.close();
  }
} finally {await browser.close();}
