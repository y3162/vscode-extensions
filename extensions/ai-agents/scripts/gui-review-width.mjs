// Measure pending Review in the actual Development Host sidebar.
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const root = await realpath(process.argv[2] || '');
const output = resolve(process.argv[3] || '');
if (!root.startsWith('/private/tmp/ai-agents-gui-acceptance-') || !process.argv[3]) throw Error('Disposable session and output required');
const receipt = JSON.parse(await readFile(join(root, 'session.json'), 'utf8'));
if (!receipt.backend.includes('host-review.cjs')) throw Error('Review fixture required');
const bundleSha256 = Object.fromEntries(await Promise.all(['main.js','main.css'].map(async file => [file, createHash('sha256').update(await readFile(join(receipt.paths.extension,'dist/webview',file))).digest('hex')])));
async function wait(fn, label) { const end = Date.now()+15000; while(Date.now()<end) { try { const x=await fn(); if(x) return x; } catch (error) { if(error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; } await new Promise(r=>setTimeout(r,100)); } throw Error(`Timeout: ${label}`); }
const id=randomUUID(); await writeFile(join(root,'review-request.json'),JSON.stringify({id,action:'setup'}));
await wait(async()=>JSON.parse(await readFile(join(root,'review-result.json'),'utf8')).id===id,'setup');
const port=(await readFile(join(receipt.paths.userData,'DevToolsActivePort'),'utf8')).split('\n')[0];
const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page=targets.find(x=>x.type==='page'&&x.title.includes('[Extension Development Host]'));
const frame=targets.find(x=>x.type==='iframe'&&x.parentId===page?.id&&x.url.includes('extensionId=y3162.ai-agents'));
if (!page || !frame) throw Error('Workbench or webview missing');
async function connect(t) {const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((ok,fail)=>{ws.onopen=ok;ws.onerror=fail;});let i=0;const p=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){const [ok,fail,timer]=p.get(m.id);p.delete(m.id);clearTimeout(timer);m.error?fail(Error(JSON.stringify(m.error))):ok(m.result);}};ws.onclose=()=>{for(const [,fail,timer] of p.values()){clearTimeout(timer);fail(Error('CDP connection closed'));}p.clear()};return {ws,call:(method,params={})=>new Promise((ok,fail)=>{const n=++i;const timer=setTimeout(()=>{p.delete(n);fail(Error(`CDP timeout: ${method}`))},10000);p.set(n,[ok,fail,timer]);try{ws.send(JSON.stringify({id:n,method,params}));}catch(error){clearTimeout(timer);p.delete(n);fail(error)}})};}
const wb=await connect(page), web=await connect(frame);
const active=(await web.call('Page.getFrameTree')).frameTree.childFrames?.find(x=>x.frame.name==='active-frame');
if (!active) throw Error('Active frame missing');
const world=await web.call('Page.createIsolatedWorld',{frameId:active.frame.id,worldName:'review-width'});
const evalW=async expression=>(await wb.call('Runtime.evaluate',{expression,returnByValue:true})).result.value;
const evalV=async expression=>(await web.call('Runtime.evaluate',{expression,contextId:world.executionContextId,returnByValue:true})).result.value;
await mkdir(output,{recursive:true}); const results=[];
try {
  await wait(()=>evalV("document.querySelector('[data-action=keep-all]') && document.querySelector('.review-open')"),'pending review');
  await evalW("document.querySelector('[aria-label^=\"Hide Secondary Side Bar\"]')?.click()");
  for (const theme of ['Dark Modern', 'Light Modern', 'Default High Contrast']) {
   const themeId=randomUUID(); await writeFile(join(root,'review-request.json'),JSON.stringify({id:themeId,action:'theme',theme}));
   await wait(async()=>JSON.parse(await readFile(join(root,'review-result.json'),'utf8')).id===themeId,`theme ${theme}`);
   await wait(()=>evalV(`document.body.dataset.vscodeThemeName===${JSON.stringify(theme === 'Default High Contrast' ? 'Dark High Contrast' : theme)}`),`rendered theme ${theme}`);
   for (const width of [300,390,600,1000]) {
    for (let i=0;i<4;i++) {
      const box=await evalW("(() => {const r=document.querySelector('.primary-sidebar-sash').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+100}})()");
      const actual=await evalV('document.documentElement.clientWidth');
      const x=box.x+width-actual;
      await wb.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:box.x,y:box.y});
      await wb.call('Input.dispatchMouseEvent',{type:'mousePressed',x:box.x,y:box.y,button:'left',buttons:1,clickCount:1});
      await wb.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+10,y:box.y,button:'left',buttons:1});
      await wb.call('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:box.y,button:'left',buttons:1});
      await wb.call('Input.dispatchMouseEvent',{type:'mouseReleased',x,y:box.y,button:'left',buttons:0,clickCount:1});
      const measured=await wait(()=>evalV('document.documentElement.clientWidth'),'measured width');
      if (measured===width) break;
    }
    const data=await evalV(`JSON.stringify({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,theme:document.body.className,themeName:document.body.dataset.vscodeThemeName,html:document.documentElement.outerHTML,buttons:[...document.querySelectorAll('.review-bar button')].map(e=>({text:e.innerText,rect:e.getBoundingClientRect().toJSON()})),scripts:[...document.scripts].map(e=>e.src),styles:[...document.querySelectorAll('link[rel=stylesheet]')].map(e=>e.href)})`);
    const view=JSON.parse(data); const screenshot=process.env.AI_AGENTS_GUI_NO_SCREENSHOTS === '1' ? null : await wb.call('Page.captureScreenshot',{format:'png'});
    const checks={width:view.width===width,theme:view.themeName===(theme === 'Default High Contrast' ? 'Dark High Contrast' : theme),noOverflow:view.scrollWidth<=view.width,buttons:view.buttons.length>=4&&view.buttons.every(b=>b.rect.width>0&&b.rect.left>=0&&b.rect.right<=view.width),production:view.scripts.some(s=>s.includes('/dist/webview/main.js'))&&view.styles.some(s=>s.includes('/dist/webview/main.css'))};
    results.push({theme,width,actualWidth:view.width,status:Object.values(checks).every(Boolean)?'PASS':'FAIL',checks});
    const stem=`${theme.replaceAll(' ','-')}-${width}`;
    await writeFile(join(output,`${stem}.json`),JSON.stringify({capturedAt:new Date().toISOString(),bundleSha256,...view,checks},null,2));
    if (screenshot) await writeFile(join(output,`${stem}.png`),Buffer.from(screenshot.data,'base64'));
   }
  }
} finally {wb.ws.close();web.ws.close();await writeFile(join(output,'results.json'),JSON.stringify({capturedAt:new Date().toISOString(),results},null,2));}
if (results.length!==12||results.some(r=>r.status!=='PASS')) process.exitCode=1;
