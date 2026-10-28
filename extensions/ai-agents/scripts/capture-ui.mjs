// Browser-only Webview fixtures. No VS Code profile, provider, or credentials are used.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
const root = resolve(import.meta.dirname, '../../..');
const output = resolve(process.env.UI_CAPTURE_OUTPUT || join(root, 'extensions/ai-agents/docs/evidence/ui-redesign/after'));
const bundle = process.env.UI_CAPTURE_BUNDLE && resolve(process.env.UI_CAPTURE_BUNDLE);
const scenes = (process.env.UI_CAPTURE_SCENES || 'home,empty-home,empty,chat,running,approval,plan,build,error,settings,subagent,terminal,model,model-list,mode,question,usage,queue,changes,plan-expanded,subagent-detail,banner').split(',');
const widths = (process.env.UI_CAPTURE_WIDTHS || '300,390,520').split(',').map(Number);
const themes = (process.env.UI_CAPTURE_THEMES || 'dark,light,hc').split(',');
const languages = (process.env.UI_CAPTURE_LANGUAGES || 'ja,en').split(',');
const height = Number(process.env.UI_CAPTURE_HEIGHT || 800);
const chrome = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.ttf': 'font/ttf', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = resolve(root, `.${path}`);
    if (!file.startsWith(root + sep)) throw new Error('outside root');
    if (bundle && path.startsWith('/extensions/ai-agents/dist/webview/')) file = join(bundle, path.split('/').at(-1));
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end('Not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const profile = await mkdtemp(join(tmpdir(), 'ai-agents-ui-capture-'));
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let sequence = 0;
const pending = new Map();
const exceptions = [];
function call(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolveCall, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolveCall(v); }, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const report = [];
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await delay(100); }
  }
  if (!port) throw new Error('Chrome did not start; set CHROME_PATH to a local Chrome/Chromium executable.');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, reject) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.id) { const p = pending.get(data.id); pending.delete(data.id); if (data.error) p?.reject(new Error(data.error.message)); else p?.resolve(data.result); }
    if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails.text + ': ' + (data.params.exceptionDetails.exception?.description || ''));
  });
  await call('Page.enable'); await call('Runtime.enable');
  for (const scene of scenes) for (const theme of themes) for (const lang of languages) for (const width of widths) {
    exceptions.length = 0;
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const url = `http://127.0.0.1:${server.address().port}/extensions/ai-agents/test/ui-preview/index.html?scene=${scene}&theme=${theme}&lang=${lang}&width=${width}&height=${height}&stress=1`;
    await call('Page.navigate', { url });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      ready = await evaluate('document.readyState === "complete" && window.previewReady === true');
      if (ready) break; await delay(30);
    }
    if (!ready) throw new Error(`Fixture not ready: ${url}`);
    await evaluate('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))');
    const metrics = await evaluate(`(() => {
      const frame = document.querySelector('#app').getBoundingClientRect();
      const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      const outside = [...document.querySelectorAll('button,input,select,textarea,main,.composer-card,.pending-card,.plan-view,.menu')].filter(visible).filter(e => { const r=e.getBoundingClientRect(); return r.left < -.5 || r.right > ${width}+.5; }).map(e=>e.className || e.tagName);
      const main = document.querySelector('.thread');
      const rgb = value => { const n = value.match(/[0-9.]+/g)?.map(Number) || [0,0,0]; if(value.startsWith('color(')) return [n[0]*255,n[1]*255,n[2]*255,n[3]??1]; return [n[0],n[1],n[2],n[3]??1]; };
      const mix = (a,b) => a.slice(0,3).map((v,i)=>v*a[3]+b[i]*(1-a[3]));
      const bg = e => { if(!e) return [255,255,255]; const c=rgb(getComputedStyle(e).backgroundColor); return c[3]>=1 ? c.slice(0,3) : mix(c,bg(e.parentElement)); };
      const luminance = c => c.map(v=>{const x=v/255; return x<=.04045?x/12.92:((x+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const lowContrast = [...document.querySelectorAll('.session-name,.session-time,.field,.section-label,.answer,.log-toggle,.menu-label,.access-label,textarea,.card h3,.card-kind,.plan-phase,.tok-kw,.tok-str,.tok-num,.subagent-state,.todo-progress,.todos li.active,.menu-value,.usage-panel summary,.turn-usage,.stats-add,.stats-remove')].filter(visible).filter(e=>!e.closest(':disabled')).flatMap(e=>{
        const background=bg(e), foreground=mix(rgb(getComputedStyle(e).color),background);
        const a=luminance(foreground),b=luminance(background),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
        return ratio<4.45?[{element:e.className||e.tagName,ratio:Number(ratio.toFixed(2))}]:[];
      });
      return { lowContrast, frameWidth: frame.width, pageOverflow: document.documentElement.scrollWidth > ${width}, horizontalOverflow: main.scrollWidth > main.clientWidth + 1, outside, promptHeight: document.querySelector('#prompt').getBoundingClientRect().height, threadHeight: main.clientHeight };
    })()`);
    const name = `${scene}-${width}-${theme}-${lang}`;
    const png = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(output, `${name}.png`), Buffer.from(png.data, 'base64'));
    report.push({ name, scene, width, theme, lang, ...metrics, exceptions: [...exceptions] });
    if (report.length % 18 === 0) console.log(`Captured ${report.length} screens`);
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (process.env.UI_CAPTURE_SHEETS !== '0') {
    for (const scene of scenes) {
      const rows = report.filter(r => r.scene === scene);
      const html = `<!doctype html><meta charset="utf-8"><style>body{margin:12px;font:13px system-ui;background:#ddd}section{display:grid;grid-template-columns:repeat(6,240px);gap:12px}figure{margin:0}img{display:block;width:240px}figcaption{height:28px}</style><h2>${scene}</h2><section>${rows.map(r=>`<figure><figcaption>${r.name}</figcaption><img src="${r.name}.png"></figure>`).join('')}</section>`;
      await writeFile(join(output, `${scene}-sheet.html`), html);
      await call('Emulation.setDeviceMetricsOverride', { width: 1536, height: 2200, deviceScaleFactor: 1, mobile: false });
      await call('Page.navigate', { url: `file://${join(output, `${scene}-sheet.html`)}` });
      for (let i = 0; i < 100; i++) { if (await evaluate('document.readyState === "complete" && [...document.images].every(i=>i.complete)')) break; await delay(30); }
      const png = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(output, `${scene}-sheet.png`), Buffer.from(png.data, 'base64'));
    }
  }

  const bad = report.filter(r => r.exceptions.length || r.pageOverflow || r.horizontalOverflow || r.outside.length || r.lowContrast.length);
  await writeFile(join(output, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>AI Agents UI matrix</title><style>body{font:14px system-ui;background:#ddd;color:#222}section{display:grid;grid-template-columns:repeat(6,260px);gap:12px}figure{margin:0}img{width:260px;border:1px solid #888}h2{margin-top:30px}figcaption{padding:8px 0}</style></head><body><h1>AI Agents — Webview fixture matrix</h1><p>${report.length} static fixture screenshots. View at original size to inspect text. Functional checks are separate.</p>${scenes.map(scene=>`<h2>${scene}</h2><section>${report.filter(r=>r.scene===scene).map(r=>`<figure><figcaption>${r.name}</figcaption><a href="${r.name}.png"><img src="${r.name}.png" loading="lazy"></a></figure>`).join('')}</section>`).join('')}</body></html>`);
  if (process.env.UI_CAPTURE_FUNCTIONAL !== '0') {
    const checks = [];
    const check = async (name, expression) => { if (!await evaluate(expression)) throw new Error(`Functional check failed: ${name}`); checks.push(name); };
    const navigate = async (scene) => {
      await call('Emulation.setDeviceMetricsOverride', { width: 300, height: 800, deviceScaleFactor: 1, mobile: false });
      await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/extensions/ai-agents/test/ui-preview/index.html?scene=${scene}&theme=hc&lang=en&width=300&height=800` });
      for (let i=0;i<100;i++) { if(await evaluate('document.readyState === "complete" && window.previewReady === true')) return; await delay(30); }
      throw new Error('Functional fixture not ready');
    };
    const key = async (key, code = key) => { await call('Input.dispatchKeyEvent', { type:'keyDown', key, code }); await call('Input.dispatchKeyEvent', { type:'keyUp', key, code }); };
    await navigate('chat');
    await check('completed log is collapsed', `document.querySelector('.log').hidden`);
    await evaluate(`document.querySelector('.log-toggle').click()`);
    await check('log expands with shell details', `!document.querySelector('.log').hidden && !!document.querySelector('.shell-tool')`);
    await evaluate(`document.querySelector('.change-toggle').click(); document.querySelector('.change-file .file-link').click()`);
    await check('changed file opens with conversation identity', `previewPosts.some(p=>p.type==='openDiff' && p.conversationId==='preview')`);
    await evaluate(`document.querySelector('.model-name').click(); document.querySelector('.model-menu [data-id="model"]').click()`);
    await check('model search receives focus', `document.activeElement.matches('.menu-search')`);
    await key('Escape'); await key('Escape');
    await check('Escape restores model focus', `document.activeElement.matches('.model-name') && document.querySelector('.model-menu').hidden`);
    await evaluate(`document.querySelector('.mode').click()`); await key('ArrowDown'); await key('Enter');
    await check('mode selection posts supported mode', `previewPosts.some(p=>p.type==='configure' && p.mode==='plan')`);
    await evaluate(`document.querySelector('.access-label').focus(); document.querySelector('.access-label').click()`);
    await check('settings has keyboard focus', `document.activeElement.closest('.settings-panel') !== null`);
    await evaluate(`document.querySelector('select[data-key="sandbox"]').focus(); window.previewSetState({...previewState, shell: {...previewState.shell, statusText:'Updated'}})`);
    await evaluate('new Promise(r=>requestAnimationFrame(r))');
    await check('unrelated updates preserve settings focus', `document.activeElement.matches('select[data-key="sandbox"]')`);
    await key('Escape');
    await check('settings restores trigger focus', `document.activeElement.matches('.access-label')`);
    await navigate('running');
    await evaluate(`const p=document.querySelector('#prompt'); p.value='Queued follow up'; p.dispatchEvent(new Event('input',{bubbles:true})); p.focus()`); await key('Enter');
    await check('running input queues instead of sending', `previewPosts.some(p=>p.type==='enqueue' && p.prompt==='Queued follow up') && !previewPosts.some(p=>p.type==='send')`);
    await evaluate(`document.querySelector('.stop').click()`);
    await check('Stop posts stop', `previewPosts.some(p=>p.type==='stop')`);
    await navigate('fresh');
    await evaluate(`const p=document.querySelector('#prompt'); p.value='日本語'; p.focus(); p.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); p.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true})); p.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})); p.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await check('IME confirmation does not submit', `!previewPosts.some(p=>p.type==='send')`);
    await delay(120); await key('Enter');
    await check('subsequent Enter sends Japanese input', `previewPosts.some(p=>p.type==='send' && p.prompt==='日本語')`);
    await navigate('approval');
    await evaluate(`document.querySelector('.pending-card .primary').click()`);
    await check('approval keeps request and token', `previewPosts.some(p=>p.type==='resolvePermission' && p.decision==='allow-once' && p.token==='tok')`);
    await navigate('plan');
    await evaluate(`document.querySelector('.plan-view-toggle').click(); document.querySelector('.build').click(); document.querySelector('.build').click()`);
    await check('Build submits one revision-scoped action', `previewPosts.filter(p=>p.type==='buildPlan' && p.planId==='plan' && p.revision===2).length===1`);
    await navigate('question');
    await evaluate(`document.querySelector('.choice input').click(); document.querySelector('.pending-card input[type="text"]').value='Context'; document.querySelector('.pending-card .primary').click()`);
    await check('all question answers share the request token', `previewPosts.some(p=>p.type==='resolveQuestion' && p.token==='q-token' && p.answers.note[0]==='Context' && p.answers.q[0]==='unit')`);
    await navigate('error');
    await evaluate(`document.querySelector('[data-action="retry"]').click()`);
    await check('Retry prepares the draft without sending', `document.querySelector('#prompt').value.length>0 && !previewPosts.some(p=>p.type==='send')`);
    await navigate('subagent');
    await evaluate(`document.querySelector('.subagent-panel-open').click()`);
    await check('subagent detail opens', `!document.querySelector('.subagent-detail-host').hidden`);
    await evaluate(`document.querySelector('.subagent-back').click()`);
    await check('parent conversation returns', `document.querySelector('.subagent-detail-host').hidden && !document.querySelector('.thread').hidden`);
    await navigate('chat');
    await evaluate(`window.previewSetState({...previewState,messages:{...previewState.messages,upserts:previewState.messages.upserts.map(m=>m.role==='assistant'?{...m,text:Array.from({length:120},(_,i)=>'Long paragraph '+i).join('\\n\\n')}:m)}})`);
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await evaluate(`const thread=document.querySelector('.thread'); thread.scrollTop=0; thread.dispatchEvent(new Event('scroll')); window.previewSetState({...previewState,revision:2})`);
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await check('scrolling up is preserved across updates', `document.querySelector('.thread').scrollTop===0 && !document.querySelector('.jump').hidden`);
    await evaluate(`document.querySelector('.jump').click()`);
    await check('Latest returns to the bottom', `document.querySelector('.thread').scrollTop>0`);
    await navigate('terminal');
    await evaluate(`document.querySelector('.terminal-stop').click()`);
    await check('terminal stop identifies its process', `previewPosts.some(p=>p.type==='terminateTerminal' && p.processId==='p1')`);
    await writeFile(join(output, 'functional.json'), JSON.stringify({ environment:'Chrome Webview fixtures, mocked Host protocol; not real OS IME or provider execution', checks },null,2));
    console.log(`Functional browser checks: ${checks.length} passed`);
  }
  console.log(JSON.stringify({ output, captures: report.length, layoutFindings: bad }, null, 2));
  if (bad.length) process.exitCode = 1;
} finally {
  ws?.close(); child.kill('SIGTERM'); server.close();
  await delay(500); await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
}
