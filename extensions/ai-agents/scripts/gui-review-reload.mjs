// Continue gui-review.mjs --keep-only through a real workbench reload.
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const root = await realpath(process.argv[2] || '');
const output = resolve(process.argv[3] || '');
if (!root.startsWith('/private/tmp/ai-agents-gui-acceptance-') || !process.argv[3]) throw new Error('Disposable session and output required');
const receipt = JSON.parse(await readFile(join(root, 'session.json'), 'utf8'));
if (!receipt.backend.includes('host-review.cjs')) throw new Error('Review fixture required');
const bundleSha256 = Object.fromEntries(await Promise.all(['main.js', 'main.css'].map(async file => [file, createHash('sha256').update(await readFile(join(receipt.paths.extension, 'dist/webview', file))).digest('hex')])));
await mkdir(output, { recursive: true });
async function wait(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { const result = await fn(); if (result) return result; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Timeout waiting for ${label}`);
}
async function request(action) {
  const id = randomUUID();
  await writeFile(join(root, 'review-request.json'), JSON.stringify({ id, action }));
  return wait(async () => { const data = JSON.parse(await readFile(join(root, 'review-result.json'), 'utf8')); return data.id === id && data; }, action);
}
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let id = 0; const pending = new Map();
  ws.onmessage = event => { const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  return { ws, call(method, params = {}) { return new Promise((ok, fail) => { const n = ++id; pending.set(n, m => m.error ? fail(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id: n, method, params })); }); } };
}
let wb, web; const assertions = [];
try {
  const before = await request('state');
  if (!before.acceptance || before.changes.length !== 2) throw new Error('Run gui-review.mjs --keep-only first');
  await rm(join(root, 'review-ready'), { force: true });
  await request('reload');
  await wait(async () => Boolean(await readFile(join(root, 'review-ready'))), 'fixture after reload');
  const [port] = (await readFile(join(receipt.paths.userData, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  const targets = await wait(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find(x => x.type === 'page' && x.title.includes('[Extension Development Host]'));
    const frame = list.find(x => x.type === 'iframe' && x.parentId === page?.id && x.url.includes('extensionId=y3162.ai-agents'));
    return page && frame && { page, frame };
  }, 'reloaded targets');
  wb = await connect(targets.page); web = await connect(targets.frame);
  const active = await wait(async () => (await web.call('Page.getFrameTree')).frameTree.childFrames?.find(x => x.frame.name === 'active-frame'), 'active frame');
  let world = await web.call('Page.createIsolatedWorld', { frameId: active.frame.id, worldName: 'ai-agents-review-reload' });
  const view = async expression => {
    let result;
    try { result = await web.call('Runtime.evaluate', { contextId: world.executionContextId, expression, returnByValue: true }); }
    catch (error) {
      if (!String(error).includes('Cannot find context')) throw error;
      const tree = await web.call('Page.getFrameTree');
      const frame = tree.frameTree.childFrames?.find(x => x.frame.name === 'active-frame');
      if (!frame) throw error;
      world = await web.call('Page.createIsolatedWorld', { frameId: frame.frame.id, worldName: 'ai-agents-review-reload' });
      result = await web.call('Runtime.evaluate', { contextId: world.executionContextId, expression, returnByValue: true });
    }
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const assert = (name, value) => { assertions.push({ name, pass: !!value }); if (!value) throw new Error(name); };
  const capture = async name => {
    const dom = await view("JSON.stringify({html:document.documentElement.outerHTML,width:document.documentElement.clientWidth,theme:document.body.className,themeName:document.body.dataset.vscodeThemeName,scripts:[...document.scripts].map(e=>e.src),styles:[...document.querySelectorAll('link[rel=stylesheet]')].map(e=>e.href)})");
    const screenshot = process.env.AI_AGENTS_GUI_NO_SCREENSHOTS === '1' ? null : await wb.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(output, `${name}.json`), JSON.stringify({ capturedAt: new Date().toISOString(), bundleSha256, ...JSON.parse(dom) }, null, 2));
    if (screenshot) await writeFile(join(output, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
  };
  await wait(() => view("!!document.querySelector('button.back')"), 'reloaded sidebar');
  await view("document.querySelector('button.back').click()");
  await wait(() => view("[...document.querySelectorAll('.session-card')].some(e=>e.textContent.includes('Review fixture'))"), 'saved review history');
  assert('history selected via GUI', await view("(() => {const e = [...document.querySelectorAll('.session-card')].find(e=>e.textContent.includes('Review fixture')); if (!e) return false; e.click(); return true;})()"));
  await wait(() => view("document.querySelector('.review-open') && !document.querySelector('[data-action=keep-all]') && document.querySelector('.change-toggle')?.innerText.includes('2')"), 'restored accepted review');
  const after = await request('state');
  assert('acceptance and changes restored', !!after.acceptance && after.changes.length === 2 && JSON.stringify(after.acceptance) === JSON.stringify(before.acceptance));
  assert('files unchanged after reload', JSON.stringify(after.contents) === JSON.stringify(before.contents));
  await capture('reloaded');
  await request('new-change');
  await wait(() => view("document.querySelector('[data-action=keep-all]') && document.querySelector('.change-toggle')?.innerText.includes('3')"), 'new pending review');
  const revised = await request('state');
  assert('new file makes restored review pending', revised.changes.length === 3 && await readFile(join(receipt.paths.workspace, 'review-third.txt'), 'utf8') === 'after third\n');
  await capture('reloaded-new-change');
} catch (error) {
  await writeFile(join(output, 'error.txt'), String(error));
  process.exitCode = 1;
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify({ capturedAt: new Date().toISOString(), assertions }, null, 2));
  wb?.ws.close(); web?.ws.close();
}
