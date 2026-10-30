// Run against an isolated, trusted gui-session.mjs Host with AI Agents visible.
// This exercises the real sidebar and mock CLI, not the ViewModel fixture.
import { readFile, writeFile, mkdir, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = await realpath(process.argv[2] || '');
const out = resolve(process.argv[3] || '');
if (!root.startsWith('/private/tmp/ai-agents-gui-acceptance-') || !process.argv[3]) throw Error('Usage: node scripts/gui-restore-acceptance.mjs <isolated-host> <evidence-dir>');
const receipt = JSON.parse(await readFile(join(root, 'session.json'), 'utf8'));
if (receipt.sessionRoot !== root || !receipt.launchArgs.includes('--remote-debugging-port=0') || receipt.launchArgs.some(x => x.includes('host-viewmodel.cjs'))) throw Error('Expected isolated CDP-enabled mock CLI Host');
const list = async () => {
  try {
    const port = (await readFile(join(receipt.paths.userData, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch { return []; }
};
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((ok, fail) => { const timer = setTimeout(() => { ws.close(); fail(Error('CDP connection timeout')); }, 3000); ws.onopen = () => { clearTimeout(timer); ok(); }; ws.onerror = e => { clearTimeout(timer); fail(e); }; });
  let id = 0; const pending = new Map(); ws.onmessage = e => { const m = JSON.parse(e.data); const entry = pending.get(m.id); if (!entry) return; pending.delete(m.id); m.error ? entry[1](Error(JSON.stringify(m.error))) : entry[0](m.result); };
  return { ws, call(method, params = {}) { return new Promise((ok, fail) => { const n = ++id; pending.set(n, [ok, fail]); ws.send(JSON.stringify({ id: n, method, params })); }); } };
}
async function attach(previousUrl) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const targets = await list(); const page = targets.find(x => x.type === 'page' && x.title.includes('[Extension Development Host]'));
    const frame = targets.find(x => x.type === 'iframe' && x.parentId === page?.id && x.url.includes('extensionId=y3162.ai-agents'));
    if (page && frame && frame.url !== previousUrl) {
      let wb, web;
      try { wb = await connect(page); web = await connect(frame); } catch { wb?.ws.close(); web?.ws.close(); await new Promise(r => setTimeout(r, 100)); continue; }
      const tree = await web.call('Page.getFrameTree');
      const active = tree.frameTree.childFrames?.find(x => x.frame.name === 'active-frame');
      if (active) { const world = await web.call('Page.createIsolatedWorld', { frameId: active.frame.id, worldName: 'restore-acceptance' }); return { wb, web, context: world.executionContextId, url: frame.url }; }
      wb.ws.close(); web.ws.close();
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error('Timeout waiting for Development Host Webview');
}
let v = await attach();
const contextTransitions = [];
const evalWeb = async expression => {
  let result;
  try { result = await v.web.call('Runtime.evaluate', { contextId: v.context, expression, returnByValue: true }); }
  catch (error) {
    if (!String(error).includes('Cannot find context')) throw error;
    contextTransitions.push({ timestamp: new Date().toISOString(), previousUrl: v.url, error: String(error) });
    v.wb.ws.close(); v.web.ws.close(); v = await attach();
    result = await v.web.call('Runtime.evaluate', { contextId: v.context, expression, returnByValue: true });
  }
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
};
const wait = async (fn, label) => { const deadline = Date.now() + 30000; let error; while (Date.now() < deadline) { try { if (await fn()) return; } catch (e) { error = e; } await new Promise(r => setTimeout(r, 100)); } throw Error(`Timeout waiting for ${label}${error ? `: ${error}` : ''}`); };
const has = async expr => Boolean(await evalWeb(expr));
const click = async selector => { if (!await evalWeb(`(()=>{const x=document.querySelector(${JSON.stringify(selector)});if(!x)return false;x.click();return true})()`)) throw Error(`Missing ${selector}`); };
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
async function capture(name) {
  await mkdir(out, { recursive: true });
  const data = JSON.parse(await evalWeb(`JSON.stringify({text:document.body.innerText,html:document.body.outerHTML,width:document.documentElement.clientWidth,theme:document.body.dataset.vscodeThemeName,scripts:[...document.scripts].map(x=>x.src),styles:[...document.querySelectorAll('link[rel=stylesheet]')].map(x=>x.href)})`));
  let hostState;
  try { hostState = JSON.parse(await readFile(join(root, 'interaction-state.json'), 'utf8')); } catch {}
  if (!data.scripts.some(x => x.includes('/dist/webview/main.js')) || !data.styles.some(x => x.includes('/dist/webview/main.css'))) throw Error('Production bundle absent');
  const screenshot = process.env.AI_AGENTS_GUI_NO_SCREENSHOTS === '1' ? null : await v.wb.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(out, `${name}.json`), JSON.stringify({ scenario: name, capturedAt: new Date().toISOString(), bundleSha256: await hash(join(receipt.paths.extension, 'dist/webview/main.js')), cssSha256: await hash(join(receipt.paths.extension, 'dist/webview/main.css')), hostState, view: data }, null, 2));
  if (screenshot) await writeFile(join(out, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
}
async function send(prompt, done) {
  const sent = await evalWeb(`(()=>{const i=document.querySelector('.composer-card textarea'),b=document.querySelector('.composer-card button.send');if(!i||!b||b.disabled)return false;i.value=${JSON.stringify(prompt)};i.dispatchEvent(new Event('input',{bubbles:true}));b.click();return true})()`);
  if (!sent) throw Error('Composer unavailable'); await wait(() => has(done), prompt);
}
async function reload() {
  // Focus the Workbench, not the webview composer, before invoking its command palette.
  const point = (await v.wb.call('Runtime.evaluate', { expression: `(()=>{const r=document.querySelector('.part.titlebar').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`, returnByValue:true })).result.value;
  await v.wb.call('Input.dispatchMouseEvent', { type:'mousePressed', x:point.x, y:point.y, button:'left', clickCount:1 });
  await v.wb.call('Input.dispatchMouseEvent', { type:'mouseReleased', x:point.x, y:point.y, button:'left', clickCount:1 });
  await v.wb.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'p', code: 'KeyP', modifiers: 12 });
  await v.wb.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', modifiers: 12 });
  await wait(async () => Boolean((await v.wb.call('Runtime.evaluate', { expression: `!!document.querySelector('.quick-input-widget input:focus')`, returnByValue: true })).result.value), 'Workbench command palette');
  await v.wb.call('Input.insertText', { text: '>Developer: Reload Window' });
  await wait(async () => Boolean((await v.wb.call('Runtime.evaluate', { expression: `document.querySelector('.quick-input-widget')?.innerText.includes('Developer: Reload Window')`, returnByValue:true })).result.value), 'Reload Window command');
  await v.wb.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await v.wb.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const previous = v.url; v.wb.ws.close(); v.web.ws.close(); v = await attach(previous);
  await wait(() => has(`!!document.querySelector('.home, .composer-card')`), 'reloaded webview');
}
try {
  await Promise.all(['gui-release-thinking','gui-update-thinking','gui-complete-thinking','gui-start-tool'].map(x => rm(join(receipt.paths.workspace, x), { force:true })));
  if (await has(`!document.querySelector('.home').hidden`)) await click('.home-start.new-chat');
  await send('GUI_THINKING_GATE', `!!document.querySelector('details.thinking[open]')`);
  await writeFile(join(receipt.paths.workspace, 'gui-release-thinking'), '');
  await wait(() => has(`document.body.textContent.includes('Synthetic thinking complete')`), 'completed thinking');
  await send('second turn', `document.body.textContent.includes('fixture answer 2: second turn')`);
  const file = join(receipt.paths.workspace, 'note.txt');
  await writeFile(file, 'original\n');
  await writeFile(file, 'changed\n');
  await send('EMIT_DIFF note.txt', `document.body.textContent.includes('fixture answer 3: EMIT_DIFF note.txt')`);
  await wait(() => has(`document.body.innerText.includes('Ready') && !!document.querySelector('button.send:not([hidden])')`), 'session A idle');
  await evalWeb(`(()=>{const b=document.querySelector('.log-toggle[data-action=toggle-log]');if(b&&b.getAttribute('aria-expanded')==='false')b.click();const t=document.querySelector('details.thinking');if(t&&!t.open)t.querySelector('summary').click()})()`);
  await wait(() => has(`!!document.querySelector('details.thinking[open]')`), 'manual Thinking before session switch');
  await capture('T07-before-switch');
  await click('button.header-btn.new-chat'); await wait(() => has(`!!document.querySelector('.composer-card textarea') && !document.body.textContent.includes('Synthetic thinking complete')`), 'new conversation');
  await send('other conversation', `document.body.textContent.includes('fixture answer 4: other conversation')`);
  await rm(join(receipt.paths.workspace, 'gui-release-thinking'), { force:true });
  await send('GUI_THINKING_GATE', `!!document.querySelector('details.thinking[open]')`);
  await writeFile(join(receipt.paths.workspace, 'gui-release-thinking'), '');
  await wait(() => has(`document.body.textContent.includes('Synthetic thinking complete') && !document.body.innerText.includes('Running')`), 'session B thinking completed');
  await evalWeb(`(()=>{for(const b of document.querySelectorAll('.log-toggle[data-action=toggle-log]'))if(b.getAttribute('aria-expanded')==='false')b.click()})()`);
  await wait(() => has(`!!document.querySelector('details.thinking:not([open])')`), 'session B thinking defaults closed');
  await capture('T07-session-b');
  await click('button.back'); await wait(() => has(`document.querySelectorAll('.session-card').length >= 2`), 'history'); await capture('T07-history');
  const selectA = `(()=>{const x=[...document.querySelectorAll('.session-card')].find(e=>e.dataset.sessionId==='fixture-thread-1');if(!x)return false;x.click();return true})()`;
  if (!await evalWeb(selectA)) throw Error('Session A missing');
  await wait(() => has(`document.body.textContent.includes('Synthetic thinking complete') && document.body.textContent.includes('second turn') && !document.querySelector('.thread').textContent.includes('other conversation')`), 'session A');
  await evalWeb(`(()=>{const b=document.querySelector('.log-toggle[data-action=toggle-log]');if(b&&b.getAttribute('aria-expanded')==='false')b.click()})()`);
  await wait(() => has(`!!document.querySelector('details.thinking[open]')`), 'manual Thinking retained after history selection'); await capture('T07-selected');
  await reload(); if (await has(`!document.querySelector('.home').hidden`) === false) await click('button.back');
  await wait(() => has(`!!document.querySelector('.session-card[data-session-id="fixture-thread-1"]')`), 'history after reload');
  if (!await evalWeb(selectA)) throw Error('Session A missing after reload');
  await wait(() => has(`document.querySelector('.thread').textContent.includes('fixture answer 2: second turn')`), 'replayed turns');
  await evalWeb(`(()=>{const b=document.querySelector('.log-toggle[data-action=toggle-log]');if(b&&b.getAttribute('aria-expanded')==='false')b.click()})()`);
  await wait(() => has(`!!document.querySelector('details.thinking')`), 'replayed Thinking');
  if (!await has(`(()=>{const t=document.querySelector('details.thinking');return !t.open && t.textContent.includes('Synthetic thinking') && !t.querySelector('summary').textContent.includes('Thinking')})()`)) throw Error('Thinking state invalid after reload');
  const rows = await evalWeb(`[...document.querySelectorAll('.thread .turn')].map(e=>e.textContent)`);
  if (rows.length !== 3 || !rows[0].includes('GUI_THINKING_GATE') || !rows[0].includes('Synthetic thinking complete') || !rows[1].includes('read fixture') || !rows[1].includes('fixture answer 2: second turn') || !rows[2].includes('EMIT_DIFF note.txt') || !rows[2].includes('fixture answer 3: EMIT_DIFF note.txt')) throw Error('History duplicated, missing, or tool/file missing');
  // A Webview replacement destroys the execution context and its DOM. Restart
  // these actual UI actions only when CDP confirms that replacement; never
  // treat an unobserved click or a timeout in the same context as success.
  let restoredToolsVerified = false;
  for (let attempt = 0; attempt < 3 && !restoredToolsVerified; attempt++) {
    const generation = contextTransitions.length;
    const stableWait = async (fn, label) => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const value = await fn();
        if (contextTransitions.length !== generation) throw Error('Webview context replaced during ' + label);
        if (value) return;
        await new Promise(r => setTimeout(r, 100));
      }
      throw Error(`Timeout waiting for ${label}`);
    };
    try {
      await stableWait(() => has(`!!document.querySelectorAll('.thread .turn')[1]?.querySelector('details.activity-group.ran .shell-tool-heading')`), 'restored tool for diagnostics');
      if (contextTransitions.length !== generation) continue;
      await evalWeb(`(()=>{const t=document.querySelectorAll('.thread .turn')[1];if(!t)return;window.__restoreTrace={started:new Date().toISOString(),turnId:t.dataset.id,events:[]};const log=(kind,e)=>{const g=t.querySelector('details.activity-group.ran'),b=t.querySelector('.shell-tool-heading');window.__restoreTrace.events.push({timestamp:new Date().toISOString(),kind,target:e?.target?.outerHTML?.slice(0,300),groupId:g?.dataset.id,groupOpen:g?.open,groupAria:g?.querySelector('summary')?.getAttribute('aria-expanded'),toolId:b?.dataset.id,detailAria:b?.getAttribute('aria-expanded'),turnConnected:t.isConnected});};document.addEventListener('click',e=>log('click',e),true);document.addEventListener('toggle',e=>log('toggle',e),true);new MutationObserver(records=>{if(window.__restoreTrace.events.length<100)log('mutation:'+records.map(r=>r.type+':'+(r.attributeName||'')).join(','));}).observe(t,{subtree:true,childList:true,attributes:true,attributeFilter:['open','aria-expanded']});log('before');})()`);
      if (contextTransitions.length !== generation) continue;
      const clicked = await evalWeb(`(()=>{const g=document.querySelectorAll('.thread .turn')[1]?.querySelector('details.activity-group.ran');if(!g)return false;if(!g.open)g.querySelector('summary').click();const b=g.querySelector('.shell-tool-heading');if(!b)return false;if(b.getAttribute('aria-expanded')!=='true')b.click();return true})()`);
      if (contextTransitions.length !== generation) continue;
      if (!clicked) throw Error('Restored tool group or detail unavailable');
      await stableWait(() => has(`!!document.querySelectorAll('.thread .turn')[1]?.querySelector('details.activity-group.ran[open] .shell-tool-heading')`), 'restored tool group open');
      await stableWait(() => has(`document.querySelectorAll('.thread .turn')[1]?.querySelector('.shell-tool-heading')?.getAttribute('aria-expanded') === 'true'`), 'restored tool detail open');
      await stableWait(() => has(`document.querySelectorAll('.thread .turn')[1]?.querySelector('.shell-command-output')?.textContent.includes('fixture content')`), 'restored tool output');
      restoredToolsVerified = true;
    } catch (error) {
      if (contextTransitions.length === generation) throw error;
    }
  }
  if (!restoredToolsVerified) throw Error('Webview context repeatedly replaced during restored tool interaction');
  if (await readFile(file, 'utf8') !== 'changed\n') throw Error('Workspace file changed unexpectedly');
  await capture('T08-T17-T18-reload');
  if (process.argv.includes('--keep-after-restore')) {
    const before = await hash(file);
    await wait(() => has(`!!document.querySelector('[data-action=keep-all]:not([disabled])') && !!document.querySelector('.review-open')`), 'restored file review');
    await click('[data-action=keep-all]');
    await wait(() => has(`!document.querySelector('[data-action=keep-all]') && !!document.querySelector('.review-open')`), 'accepted restored review');
    await wait(async () => { try { const state=JSON.parse(await readFile(join(root,'interaction-state.json'),'utf8'));return !!state.reviewAcceptance && state.changes.some(c=>c.path.endsWith('note.txt')); } catch { return false; } }, 'host accepted restored review');
    if (before !== await hash(file)) throw Error('Keep changed restored file');
    await capture('T20-integrated-keep');
  }
  await writeFile(join(out, 'trace.json'), JSON.stringify({ contextTransitions, trace: JSON.parse(await evalWeb('JSON.stringify(window.__restoreTrace ?? null)')) }, null, 2));
  await writeFile(join(out, 'result.json'), JSON.stringify({ pass:true, scenarios:['T07','T08','T17','T18'], capturedAt:new Date().toISOString() }, null, 2));
  console.log('PASS T07 T08 T17 T18');
} catch (error) {
  try { await mkdir(out, { recursive: true }); await writeFile(join(out, 'trace.json'), JSON.stringify({ contextTransitions, trace: JSON.parse(await evalWeb('JSON.stringify(window.__restoreTrace ?? null)')) }, null, 2)); } catch {}
  try { await capture('failure'); } catch { /* Preserve the original error if the target is gone. */ }
  await writeFile(join(out, 'error.txt'), String(error));
  throw error;
} finally { v.wb.ws.close(); v.web.ws.close(); }
