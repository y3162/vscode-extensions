// Exercises GUI -> sidebar -> real controller -> deterministic isolated backend.
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=await realpath(process.argv[2]||''),out=resolve(process.argv[3]||'');
if(!root.startsWith('/private/tmp/ai-agents-gui-acceptance-')||!process.argv[3])throw Error('Disposable host required');
const receipt=JSON.parse(await readFile(join(root,'session.json'),'utf8'));
if(!receipt.backend.includes('host-plan-flow.cjs'))throw Error('Plan fixture required');
const port=(await readFile(join(receipt.paths.userData,'DevToolsActivePort'),'utf8')).split('\n')[0];
const list=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page=list.find(x=>x.type==='page'&&x.title.includes('[Extension Development Host]'));
const frame=list.find(x=>x.type==='iframe'&&x.parentId===page?.id&&x.url.includes('extensionId=y3162.ai-agents'));
if(!page||!frame)throw Error('Host or Webview not found');
async function connect(target){const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((ok,fail)=>{ws.onopen=ok;ws.onerror=fail});let seq=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const [ok,fail]=pending.get(m.id);pending.delete(m.id);m.error?fail(Error(JSON.stringify(m.error))):ok(m.result)}};ws.onclose=()=>{for(const [,fail] of pending.values())fail(Error('CDP disconnected'));pending.clear()};return {ws,call:(method,params={})=>new Promise((ok,fail)=>{let id=++seq;pending.set(id,[ok,fail]);ws.send(JSON.stringify({id,method,params}))})}}
const wb=await connect(page),wv=await connect(frame);const results=[];await mkdir(out,{recursive:true});
try{
 const tree=await wv.call('Page.getFrameTree');const active=tree.frameTree.childFrames?.find(f=>f.frame.name==='active-frame');if(!active)throw Error('Webview frame missing');
 const world=await wv.call('Page.createIsolatedWorld',{frameId:active.frame.id,worldName:'plan-acceptance'});
 const evaljs=async expression=>(await wv.call('Runtime.evaluate',{contextId:world.executionContextId,expression,returnByValue:true})).result.value;
 const wait=async(predicate,label)=>{const start=Date.now(),end=start+15000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,50))}const host=await state();const dom=await evaljs("JSON.stringify({text:document.body.innerText,html:document.body.outerHTML,width:document.documentElement.clientWidth})");const geometry=(await wb.call('Runtime.evaluate',{expression:"JSON.stringify({windowWidth:innerWidth,sidebar:document.querySelector('.part.sidebar')?.getBoundingClientRect().toJSON(),sash:document.querySelector('.primary-sidebar-sash')?.getBoundingClientRect().toJSON()})",returnByValue:true})).result.value;await writeFile(join(out,'timeout.json'),JSON.stringify({label,elapsedMs:Date.now()-start,host,dom:JSON.parse(dom),geometry:JSON.parse(geometry)},null,2));throw Error(`Timeout: ${label}`)};
 const state=async()=>{try{return JSON.parse(await readFile(join(root,'plan-flow-state.json'),'utf8'))}catch{return {}}};
 const planAtFirstTurn=async()=>{const ok=await evaljs("(()=>{const turns=[...document.querySelectorAll('.thread > .turn')];const plan=document.querySelector('.thread > .plan-slot');return !!turns.length && turns[0].nextElementSibling===plan && (turns.length<2 || !!(plan.compareDocumentPosition(turns[1]) & Node.DOCUMENT_POSITION_FOLLOWING))})()");if(!ok)throw Error('Plan is not anchored after its creating turn')};
 const click=async expr=>{if(!await evaljs(expr))throw Error(`Element not available: ${expr}`)};
 const snap=async name=>{const dom=await evaljs(`JSON.stringify({text:document.body.innerText,html:document.body.outerHTML,width:document.documentElement.clientWidth,theme:document.body.dataset.vscodeThemeName,scripts:[...document.scripts].map(x=>x.src),styles:[...document.querySelectorAll('link[rel=stylesheet]')].map(x=>x.href)})`);const host=await state();const screenshot=process.env.AI_AGENTS_GUI_NO_SCREENSHOTS === '1' ? null : await wb.call('Page.captureScreenshot',{format:'png'});const bundles={};for(const f of ['main.js','main.css'])bundles[f]=createHash('sha256').update(await readFile(join(receipt.paths.extension,'dist/webview',f))).digest('hex');await writeFile(join(out,`${name}.json`),JSON.stringify({capturedAt:new Date().toISOString(),host,dom:JSON.parse(dom),bundles},null,2));if(screenshot)await writeFile(join(out,`${name}.png`),Buffer.from(screenshot.data,'base64'));results.push({name,status:'PASS'});};
 await wait(()=>evaljs("!!document.querySelector('button.mode:not([hidden])')"),'mode selector');
 await click("(() => {document.querySelector('button.mode').click();return true})()");
 await click("(() => {const e=[...document.querySelectorAll('[role=menuitem],button')].find(e=>e.textContent.trim()==='Plan'&&e.getBoundingClientRect().width);if(!e)return false;e.click();return true})()");
 await wait(async()=> (await state()).mode==='plan','Plan mode');
 async function send(text){await click(`(() => {const e=document.querySelector('textarea');if(!e)return false;e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);await wait(()=>evaljs("!!document.querySelector('button.send:not([disabled])')"),'send enabled');await click("(() => {document.querySelector('button.send').click();return true})()");}
 await send('Create a fixture plan');await wait(async()=>{const s=await state();return s.phase==='ready'&&!s.busy&&s.revision===1},'first plan');await wait(()=>evaljs("!!document.querySelector('.plan-view.phase-ready')"),'ready DOM');await planAtFirstTurn();await snap('plan-input');
 await send('Include a requested change');await wait(async()=>{const s=await state();return s.phase==='ready'&&!s.busy&&s.revision===2&&s.markdown.includes('Revised')},'revised plan');await wait(()=>evaljs("document.querySelector('.plan-view.phase-ready')?.textContent.includes('Revised')"),'revised plan DOM');await planAtFirstTurn();await snap('additional-prompt');
 await click("(() => {const b=document.querySelector('.plan-view-toggle');if(!b)return false;b.click();return true})()");
 await wait(()=>evaljs("!!document.querySelector('.plan-body')"),'expanded plan');
 await click("(() => {const b=document.querySelector('.plan-build .pill');if(!b)return false;b.click();return true})()");
 await wait(()=>evaljs("!!document.querySelector('[role=menuitem][data-id=model]')"),'model menu');
 await click("(() => {const b=document.querySelector('[role=menuitem][data-id=model]');if(!b)return false;b.click();return true})()");
 await wait(()=>evaljs("[...document.querySelectorAll('[role=menuitem],button')].some(e=>e.textContent.includes('Second Model')&&e.getBoundingClientRect().width)"),'model catalog');
 await click("(() => {const b=[...document.querySelectorAll('[role=menuitem],button')].find(e=>e.textContent.includes('Second Model')&&e.getBoundingClientRect().width);if(!b)return false;b.click();return true})()");
 await wait(()=>evaljs("document.querySelector('.plan-build .pill')?.textContent.includes('Second Model')"),'selected build model');await snap('model-selected');
 await click("(() => {const b=document.querySelector('.plan-view-toggle');if(!b)return false;b.click();return true})()");
 await wait(()=>evaljs("!document.querySelector('.plan-body') && document.querySelector('.plan-view-toggle')?.getAttribute('aria-expanded')==='false'"),'collapsed plan');await snap('plan-collapsed');
 async function build(){await wait(()=>evaljs("!!document.querySelector('.plan-view.phase-ready .build:not([disabled])')"),'enabled Build DOM');await click("(() => {const b=document.querySelector('.plan-view .build:not([disabled])');if(!b)return false;b.click();return true})()");await wait(async()=>{const s=await state();return s.phase==='building'&&s.busy},'building host');await wait(()=>evaljs("!!document.querySelector('.plan-view.phase-building') && !!document.querySelector('button.stop:not([hidden])')"),'building DOM');await wait(()=>evaljs("(()=>{const b=document.querySelector('.plan-view.phase-building .build');return !!b?.disabled && !!b.title && !!b.getAttribute('aria-label') && b.getAttribute('aria-label').includes(b.title)})()"),'disabled Build and accessible reason');}
 await build();await wait(async()=>{try{return JSON.parse(await readFile(join(root,'plan-selected-model.json'),'utf8')).model==='fixture-second'}catch{return false}},'backend model selection');await planAtFirstTurn();await snap('building');await writeFile(join(root,'plan-build-outcome'),'fail');await wait(async()=>{const s=await state();return s.phase==='ready'&&!s.busy&&s.turns.at(-1)?.status==='failed'},'build failure');await planAtFirstTurn();await snap('build-failed');
 await build();await click("(() => {const b=document.querySelector('button.stop:not([hidden])');if(!b)return false;b.click();return true})()");await wait(async()=>{const s=await state();return s.phase==='ready'&&!s.busy&&s.turns.at(-1)?.status==='cancelled'},'build stop');await planAtFirstTurn();await snap('build-stopped');
 await click("(() => {const b=document.querySelector('.plan-view-toggle');if(!b)return false;b.click();return true})()");
 await wait(()=>evaljs("!!document.querySelector('.plan-body')"),'expanded plan');
 for(let i=0;i<4;i++) {
  await wait(async()=>{const width=await evaljs('document.documentElement.clientWidth');const frame=(await wb.call('Runtime.evaluate',{expression:"[...document.querySelectorAll('iframe')].find(e=>e.src.includes('extensionId=y3162.ai-agents'))?.getBoundingClientRect().width",returnByValue:true})).result.value;return typeof frame==='number' && Math.abs(frame-width)<1},'Workbench and Webview width convergence');
  const actual=await evaljs('document.documentElement.clientWidth');if(actual===300)break;
  const box=(await wb.call('Runtime.evaluate',{expression:"(() => {const r=document.querySelector('.primary-sidebar-sash').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+100}})()",returnByValue:true})).result.value;
  const x=box.x+300-actual;
  await wb.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:box.x,y:box.y});
  await wb.call('Input.dispatchMouseEvent',{type:'mousePressed',x:box.x,y:box.y,button:'left',buttons:1,clickCount:1});
  await wb.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+10,y:box.y,button:'left',buttons:1});
  await wb.call('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:box.y,button:'left',buttons:1});
  await wb.call('Input.dispatchMouseEvent',{type:'mouseReleased',x,y:box.y,button:'left',buttons:0,clickCount:1});
  const end=Date.now()+5000;let previous=-1,stable=0;
  while(Date.now()<end){const width=await evaljs('document.documentElement.clientWidth');const sidebar=(await wb.call('Runtime.evaluate',{expression:"document.querySelector('.part.sidebar').getBoundingClientRect().width",returnByValue:true})).result.value;stable=width===previous && Math.abs(sidebar-width-3)<1 ? stable+1 : 0;if(stable>=3)break;previous=width;await new Promise(r=>setTimeout(r,50));}
 }
 await wait(()=>evaljs('document.documentElement.clientWidth===300'),'300px Webview');
 const narrow=await evaljs(`(()=>{const b=document.querySelector('.plan-view .build'), label=b.querySelector('.btn-label'), r=document.createRange();r.selectNodeContents(label);return {lines:r.getClientRects().length,height:b.getBoundingClientRect().height,width:b.getBoundingClientRect().width,scroll:document.documentElement.scrollWidth}})()`);
 if(narrow.lines!==1||narrow.height!==24||narrow.width<30||narrow.scroll>300)throw Error(`Plan controls overflow at 300px: ${JSON.stringify(narrow)}`);
 await snap('plan-300');
 const invocations=(await readFile(join(root,'plan-invocations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 if(invocations.slice(-4).map(x=>x.intent).join(',')!=='plan,revise,build,build')throw Error('Unexpected backend invocation sequence');
}catch(error){results.push({name:'plan-flow',status:'FAIL',error:String(error)});process.exitCode=1}finally{wb.ws.close();wv.ws.close();await writeFile(join(out,'results.json'),JSON.stringify({results},null,2));}
console.log(JSON.stringify(results,null,2));
