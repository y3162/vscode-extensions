// Development Host component screenshots at two measured actual widths.
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
const root=await realpath(process.argv[2]||''), output=resolve(process.argv[3]||'');
if (!root.startsWith('/private/tmp/ai-agents-gui-acceptance-') || !process.argv[3]) throw Error('Isolated host required');
const receipt=JSON.parse(await readFile(join(root,'session.json'),'utf8'));
if (!receipt.launchArgs.some(x=>x.includes('host-visual.cjs'))) throw Error('Visual fixture required');
const id=crypto.randomUUID();
await writeFile(join(root,'interaction-request.json'),JSON.stringify({id,action:'layout'}));
const end=Date.now()+15000;
let layoutReady=false;
while(Date.now()<end){try{if(JSON.parse(await readFile(join(root,'interaction-switch.json'),'utf8')).id===id){layoutReady=true;break}}catch{} await new Promise(r=>setTimeout(r,50));}
if(!layoutReady) throw Error('Component layout fixture did not acknowledge the request');
const port=(await readFile(join(receipt.paths.userData,'DevToolsActivePort'),'utf8')).split('\n')[0];
const page=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x=>x.type==='page'&&x.title.includes('[Extension Development Host]'));
if (!page) throw Error('Workbench not found');
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((ok,fail)=>{ws.onopen=ok;ws.onerror=fail});
let seq=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const [ok,fail]=pending.get(m.id);pending.delete(m.id);m.error?fail(Error(JSON.stringify(m.error))):ok(m.result)}};
const call=(method,params={})=>new Promise((ok,fail)=>{let n=++seq;pending.set(n,[ok,fail]);ws.send(JSON.stringify({id:n,method,params}))});
async function resize(width, correction=0){
 // Some hosts open the auxiliary bar after startup, constraining the primary
 // sidebar. Close it only when actually visible, then wait for its layout.
 const hidden=(await call('Runtime.evaluate',{expression:"(() => {const bar=document.querySelector('.part.auxiliarybar');if(!bar || !bar.getBoundingClientRect().width)return true;document.querySelector('[aria-label^=\"Hide Secondary Side Bar\"]')?.click();return false})()",returnByValue:true})).result.value;
 if(!hidden){const deadline=Date.now()+5000;let closed=false;while(Date.now()<deadline){closed=(await call('Runtime.evaluate',{expression:"!document.querySelector('.part.auxiliarybar')?.getBoundingClientRect().width",returnByValue:true})).result.value;if(closed)break;await new Promise(r=>setTimeout(r,50));}if(!closed)throw Error('Secondary sidebar did not close');}
 const r=(await call('Runtime.evaluate',{expression:"(() => {const r=document.querySelector('.primary-sidebar-sash').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+100}})()",returnByValue:true})).result.value;const x=correction?r.x+correction+Math.sign(correction):50+width+3;for(const e of [{type:'mouseMoved',x:r.x,y:r.y},{type:'mousePressed',x:r.x,y:r.y,button:'left',buttons:1,clickCount:1},{type:'mouseMoved',x:x+10,y:r.y,button:'left',buttons:1},{type:'mouseMoved',x,y:r.y,button:'left',buttons:1},{type:'mouseReleased',x,y:r.y,button:'left',buttons:0,clickCount:1}])await call('Input.dispatchMouseEvent',e);
 const end=Date.now()+5000;let previous=-1,stable=0;while(Date.now()<end){const current=(await call('Runtime.evaluate',{expression:"document.querySelector('.part.sidebar').getBoundingClientRect().width",returnByValue:true})).result.value;stable=current===previous?stable+1:0;if(stable>=2)return;previous=current;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Sidebar layout did not settle');}
await mkdir(output,{recursive:true}); const results=[];
try {
 await call('Runtime.evaluate',{expression:"document.querySelector('[aria-label^=\"Hide Secondary Side Bar\"]')?.click()",returnByValue:true});
 for(const [component,initial,visible] of [['plan','--plan-ready','--plan-ready'],['approval','--permission-request=width-approval','--permission-visible']]) {
  let first=true;
  for(const width of [390,1000]) {
   await resize(width); const dir=join(output,component,String(width)); let data,run;
   for(let attempt=0;attempt<3;attempt++) {
    run=spawnSync(process.execPath,['scripts/gui-cdp-capture.mjs',root,dir,first?initial:visible],{encoding:'utf8',timeout:30000}); first=false;
    if(run.status!==0) break;
    data=JSON.parse(await readFile(join(dir,'capture.json'),'utf8'));
    const delta=width-data.webview.webviewWidth;if(!delta)break;await resize(width,delta);
   }
   const checks={capture:run.status===0,width:data?.webview.webviewWidth===width,theme:data?.webview.theme==='Dark Modern',overflow:data?.webview.scrollWidth<=data?.webview.webviewWidth};
   const geometry=(await call('Runtime.evaluate',{expression:"JSON.stringify({width:innerWidth,sash:document.querySelector('.primary-sidebar-sash')?.getBoundingClientRect().toJSON(),sidebar:document.querySelector('.part.sidebar')?.getBoundingClientRect().toJSON()})",returnByValue:true})).result.value;
   results.push({component,width,actualWidth:data?.webview.webviewWidth,geometry:JSON.parse(geometry),checks,status:Object.values(checks).every(Boolean)?'PASS':'FAIL',evidence:dir,error:run.status!==0?run.stderr:undefined});
  }
 }
 // Resolve the pending approval before starting a parent and two synthetic children.
 const approved=spawnSync(process.execPath,['scripts/gui-cdp-capture.mjs',root,join(output,'approval','resolved'),'--permission-decision=deny'],{encoding:'utf8',timeout:30000});
 if(approved.status!==0) throw Error(`Approval resolution failed: ${approved.stderr}`);
 const childId=crypto.randomUUID();
 await writeFile(join(root,'interaction-request.json'),JSON.stringify({id:childId,action:'visual-subagents'}));
 const childEnd=Date.now()+15000;let ready=false;
 while(Date.now()<childEnd){try{if(JSON.parse(await readFile(join(root,'interaction-switch.json'),'utf8')).id===childId){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50));}
 if(!ready)throw Error('Subagent setup timed out');
 for(const width of [390,1000]) {
  await resize(width);const dir=join(output,'subagent',String(width));let data,run;
  for(let attempt=0;attempt<3;attempt++){
   run=spawnSync(process.execPath,['scripts/gui-cdp-capture.mjs',root,dir,'--subagent-visible'],{encoding:'utf8',timeout:30000});if(run.status!==0)break;
   data=JSON.parse(await readFile(join(dir,'capture.json'),'utf8'));const delta=width-data.webview.webviewWidth;if(!delta)break;await resize(width,delta);
  }
  const checks={capture:run.status===0,width:data?.webview.webviewWidth===width,theme:data?.webview.theme==='Dark Modern',overflow:data?.webview.scrollWidth<=data?.webview.webviewWidth};
  results.push({component:'subagent',width,actualWidth:data?.webview.webviewWidth,checks,status:Object.values(checks).every(Boolean)?'PASS':'FAIL',evidence:dir,error:run.status!==0?run.stderr:undefined});
 }
}finally{ws.close();await writeFile(join(output,'results.json'),JSON.stringify({capturedAt:new Date().toISOString(),results},null,2))}
console.log(JSON.stringify(results,null,2));if(results.length!==6||results.some(x=>x.status!=='PASS'))process.exitCode=1;
