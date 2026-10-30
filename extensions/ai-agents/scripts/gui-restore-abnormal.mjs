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
const evalWeb = async expression => {
  let result;
  try { result = await v.web.call('Runtime.evaluate', { contextId: v.context, expression, returnByValue: true }); }
  catch (error) {
    if (!String(error).includes('Cannot find context')) throw error;
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
  if (!data.scripts.some(x=>x.includes('/dist/webview/main.js')) || !data.styles.some(x=>x.includes('/dist/webview/main.css'))) throw Error('Production bundle absent');
  await writeFile(join(out, `${name}.json`), JSON.stringify({scenario:name,capturedAt:new Date().toISOString(),bundleSha256:await hash(join(receipt.paths.extension,'dist/webview/main.js')),cssSha256:await hash(join(receipt.paths.extension,'dist/webview/main.css')),view:data},null,2));
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
async function selectHistory() {
  if (await has(`document.querySelector('.home').hidden`)) await click('button.back');
  await wait(() => has(`!!document.querySelector('.session-card[data-session-id="fixture-thread-1"]')`), 'session in history');
  await click('.session-card[data-session-id="fixture-thread-1"]');
}
try {
  await Promise.all(['gui-release-thinking','gui-update-thinking','gui-complete-thinking','gui-start-tool','fixture-resume-failure','fixture-history-incomplete'].map(x => rm(join(receipt.paths.workspace,x), {force:true})));
  if (await has(`!document.querySelector('.home').hidden`)) await click('.home-start.new-chat');
  await send('GUI_THINKING_GATE', `!!document.querySelector('details.thinking[open]')`);
  await writeFile(join(receipt.paths.workspace,'gui-complete-thinking'),'');
  await wait(() => has(`document.querySelector('.thinking summary')?.textContent.includes('Thought')`),'completed Thinking');
  await writeFile(join(receipt.paths.workspace,'gui-start-tool'),'');
  await wait(() => has(`document.querySelector('.thread').textContent.includes('Running')`),'incomplete tool');
  await capture('running-before-reload');
  await reload(); await selectHistory();
  await wait(() => has(`document.querySelector('.thread').textContent.includes('Run state unknown after reload')`),'unknown interrupted turn');
  const unknown = await evalWeb(`document.querySelector('.thread').textContent`);
  if (unknown.includes('Running')) throw Error('Interrupted tool incorrectly shown as running');
  await capture('interrupted-unknown');
  await writeFile(join(receipt.paths.workspace,'fixture-resume-failure'),'');
  await reload(); await selectHistory();
  await wait(() => has(`document.body.textContent.includes('fixture history unavailable')`),'resume failure');
  if (!await has(`document.body.textContent.includes('Error')`)) throw Error('Resume failure not displayed as error');
  await capture('resume-failure');
  await rm(join(receipt.paths.workspace,'fixture-resume-failure'));
  await writeFile(join(receipt.paths.workspace,'fixture-history-incomplete'),'');
  await reload(); await selectHistory();
  await wait(() => has(`document.body.textContent.includes('Codex CLI のターン履歴を検証できません')`),'incomplete history error');
  if (!await has(`document.body.textContent.includes('Error')`)) throw Error('Incomplete history not displayed as error');
  await capture('incomplete-history');
  await writeFile(join(out,'result.json'),JSON.stringify({pass:true,scenarios:['running-reload-unknown','incomplete-tool','resume-failure','incomplete-history'],capturedAt:new Date().toISOString()},null,2));
  console.log('PASS interrupted reload, incomplete tool, resume failure, incomplete history');
} finally {
  await writeFile(join(receipt.paths.workspace,'gui-release-thinking'),'').catch(()=>{});
  await Promise.all(['fixture-resume-failure','fixture-history-incomplete'].map(x=>rm(join(receipt.paths.workspace,x),{force:true})));
  v.wb.ws.close(); v.web.ws.close();
}
