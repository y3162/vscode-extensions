// Measure an actual Development Host sidebar after moving its workbench sash.
// The host must use the isolated ViewModel fixture, never a user's profile.
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const root = await realpath(process.argv[2] || '');
const output = resolve(process.argv[3] || '');
if (!root.startsWith('/private/tmp/ai-agents-gui-acceptance-') || !process.argv[3]) throw Error('Expected isolated session root and evidence directory');
const receipt = JSON.parse(await readFile(join(root, 'session.json'), 'utf8'));
if (!receipt.launchArgs.some(x => x.includes('host-viewmodel.cjs'))) throw Error('Expected isolated ViewModel host');
const port = (await readFile(join(receipt.paths.userData, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(x => x.type === 'page' && x.title.includes('[Extension Development Host]'));
if (!page) throw Error('Workbench target missing');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const [ok, fail] = pending.get(m.id); pending.delete(m.id); m.error ? fail(Error(JSON.stringify(m.error))) : ok(m.result); } };
const call = (method, params = {}) => new Promise((ok, fail) => { const id = ++seq; pending.set(id, [ok, fail]); ws.send(JSON.stringify({id, method, params})); });
const evaluate = async expression => (await call('Runtime.evaluate', {expression, returnByValue: true})).result.value;
const pause = () => new Promise(r => setTimeout(r, 100));
async function theme(name) {
  const id = crypto.randomUUID();
  await writeFile(join(root, 'viewmodel-scenario.json'), JSON.stringify({id, scenario: 'theme', theme: name}));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { try { if (JSON.parse(await readFile(join(root, 'viewmodel-result.json'), 'utf8')).id === id) return; } catch {} await pause(); }
  throw Error(`Theme update timeout: ${name}`);
}
async function resize(width, correction = 0) {
  const r = await evaluate(`(() => { const r = document.querySelector('.primary-sidebar-sash').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+100}; })()`);
  await call('Input.dispatchMouseEvent', {type:'mouseMoved', x:r.x, y:r.y});
  await call('Input.dispatchMouseEvent', {type:'mousePressed', x:r.x, y:r.y, button:'left', buttons:1, clickCount:1});
  // Sidebar begins at x=50; the embedded content is 3px narrower than its sash width.
  const x = correction ? r.x + correction : 50 + width + 3;
  await call('Input.dispatchMouseEvent', {type:'mouseMoved', x, y:r.y, button:'left', buttons:1});
  await call('Input.dispatchMouseEvent', {type:'mouseReleased', x, y:r.y, button:'left', buttons:0, clickCount:1});
}
await mkdir(output, {recursive:true});
const results=[];
try {
  for (const name of ['Dark Modern', 'Light Modern', 'Default High Contrast']) {
    await theme(name);
    for (const width of [300,390,600,1000]) {
      await resize(width);
      const dir=join(output, name.replaceAll(' ','-'), String(width));
      let run, data;
      for (let attempt=0; attempt<3; attempt++) {
        // The workbench iframe can resize before its out-of-process document.
        // Do not correct the sash using a stale document width.
        const deadline=Date.now()+15000;
        do {
          run=spawnSync(process.execPath, ['scripts/gui-cdp-capture.mjs',root,dir,'--scenario=T04','--layout-interactions'], {encoding:'utf8',timeout:30000});
          if (run.status !== 0) break;
          data=JSON.parse(await readFile(join(dir,'capture.json'),'utf8'));
          const frame=data.workbenchGeometry.frames.find(f=>f.src.includes('extensionId=y3162.ai-agents') && f.visible==='visible' && f.display!=='none');
          if (frame && Math.abs(frame.rect.width-data.outerGeometry.width)<1 && data.outerGeometry.width===data.webview.webviewWidth) break;
          data=undefined;
          await pause();
        } while(Date.now()<deadline);
        if (run.status !== 0 || !data) break;
        const correction=width-data.webview.webviewWidth;
        if (!correction) break;
        await resize(width, correction);
      }
      if (run.status !== 0 || !data) {results.push({theme:name,width,status:'FAIL',error:run.status !== 0 ? (run.stderr || run.stdout) : 'Webview geometry did not converge'}); continue;}
      const geometry=await evaluate("JSON.stringify({windowWidth:innerWidth,sidebar:document.querySelector('.part.sidebar')?.getBoundingClientRect().toJSON(),sash:document.querySelector('.primary-sidebar-sash')?.getBoundingClientRect().toJSON()})");
      const view=data.webview;
      const card=view.elements.find(e=>e.className.includes('user-card'));
      const activity=view.elements.find(e=>e.className.includes('activity-row') && e.rect.width > 0);
      const shown = className => view.elements.some(e => e.className.split(' ').includes(className) && e.rect.width > 0 && e.rect.height > 0);
      const composer=view.elements.find(e=>e.className.includes('composer-card'));
      const checks={width:view.webviewWidth===width,theme:view.theme===(name === 'Default High Contrast' ? 'Dark High Contrast' : name),noHorizontalOverflow:view.scrollWidth<=view.webviewWidth,
        production: data.assertions.every(x=>x.pass), composer: view.elements.some(e=>e.className.includes('composer-card') && e.borderRadius==='12px'),
        row:view.elements.some(e=>e.className.includes('composer-row') && Math.abs(e.rect.height-28)<0.1),
        column: Boolean(card && composer && card.rect.width <= 640 && Math.abs(card.rect.width - composer.rect.width) < 1 && (width !== 1000 || card.rect.width === 640 && Math.abs(card.rect.left - (width - 640) / 2) < 1)),
        activity: Boolean(activity && activity.fontSize === '14px' && activity.lineHeight === '22px'),
        focus: Boolean(data.interactions?.focused && data.interactions.focusOutline !== 'none' && data.interactions.focusWidth !== '0px'), scroll: Boolean(data.interactions?.top === 0 && data.interactions.bottom > 0 && data.interactions.scrollHeight > data.interactions.clientHeight),
        font: Boolean(view.font), border: Boolean(composer?.borderColor && composer.borderColor !== 'transparent'), model: shown('model-name'), mode: shown('mode'), send: shown('send'), stop: shown('stop')};
      results.push({theme:name,width,actualWidth:view.webviewWidth,geometry:JSON.parse(geometry),status:Object.values(checks).every(Boolean)?'PASS':'FAIL',checks,evidence:dir});
    }
  }
} finally { ws.close(); await writeFile(join(output,'matrix.json'),JSON.stringify({capturedAt:new Date().toISOString(),results},null,2)); }
console.log(JSON.stringify(results,null,2));
if (results.length!==12 || results.some(x=>x.status!=='PASS')) process.exitCode=1;
