// Exercises real Sidebar review handlers against files in an isolated GUI session.
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const root = await realpath(process.argv[2] || '');
const output = resolve(process.argv[3] || '');
if (!root.startsWith('/private/tmp/ai-agents-gui-acceptance-') || !process.argv[3]) throw new Error('Expected isolated session and evidence directory');
const receipt = JSON.parse(await readFile(join(root, 'session.json'), 'utf8'));
if (receipt.sessionRoot !== root || !receipt.backend.includes('host-review.cjs')) throw new Error('Review fixture required');
const deadlineWait = async (fn, label) => {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Timeout waiting for ${label}`);
};
const endpoint = await deadlineWait(async () => {
  try { return await readFile(join(receipt.paths.userData, 'DevToolsActivePort'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}, 'CDP endpoint');
const [port] = endpoint.trim().split('\n');
await deadlineWait(async () => { try { await readFile(join(root, 'review-ready')); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; } }, 'review fixture');
const request = async action => {
  const id = randomUUID();
  await writeFile(join(root, 'review-request.json'), JSON.stringify({ id, action }));
  return deadlineWait(async () => { try { const result = JSON.parse(await readFile(join(root, 'review-result.json'), 'utf8')); return result.id === id && result; } catch { return false; } }, action);
};
const targets = await deadlineWait(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(x => x.type === 'page' && x.title.includes('[Extension Development Host]'));
  const frame = list.find(x => x.type === 'iframe' && x.parentId === page?.id && x.url.includes('extensionId=y3162.ai-agents'));
  return page && frame && { page, frame };
}, 'workbench and webview');
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let id = 0; const pending = new Map();
  ws.onmessage = event => { const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  return { ws, call(method, params = {}) { return new Promise((ok, fail) => { const n = ++id; pending.set(n, m => m.error ? fail(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id: n, method, params })); }); } };
}
const wb = await connect(targets.page); const web = await connect(targets.frame);
await mkdir(output, { recursive: true });
const assertions = [];
let captureFailure;
try {
  const tree = await web.call('Page.getFrameTree');
  const active = tree.frameTree.childFrames?.find(x => x.frame.name === 'active-frame');
  if (!active) throw new Error('Webview active-frame missing');
  let world = await web.call('Page.createIsolatedWorld', { frameId: active.frame.id, worldName: 'ai-agents-review-acceptance' });
  const evaluate = async (client, expression, contextId) => {
    const response = await client.call('Runtime.evaluate', { expression, ...(contextId ? { contextId } : {}), returnByValue: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const view = async expression => {
    try { return await evaluate(web, expression, world.executionContextId); }
    catch (error) {
      if (!String(error).includes('Cannot find context')) throw error;
      const currentTree = await web.call('Page.getFrameTree');
      const current = currentTree.frameTree.childFrames?.find(x => x.frame.name === 'active-frame');
      if (!current) throw error;
      world = await web.call('Page.createIsolatedWorld', { frameId: current.frame.id, worldName: 'ai-agents-review-acceptance' });
      return evaluate(web, expression, world.executionContextId);
    }
  };
  const workbench = expression => evaluate(wb, expression);
  const waitView = (expression, label) => deadlineWait(() => view(expression), label);
  const assert = (name, pass) => { assertions.push({ name, pass: Boolean(pass) }); if (!pass) throw new Error(`Assertion failed: ${name}`); };
  const capture = async name => {
    const dom = await view(`JSON.stringify({html:document.documentElement.outerHTML,width:document.documentElement.clientWidth,theme:document.body.dataset.vscodeThemeName,themeKind:document.body.className,scripts:[...document.scripts].map(x=>x.src),styles:[...document.querySelectorAll('link[rel=stylesheet]')].map(x=>x.href)})`);
    const screenshot = process.env.AI_AGENTS_GUI_NO_SCREENSHOTS === '1' ? null : await wb.call('Page.captureScreenshot', { format: 'png' });
    const bundles = {};
    for (const file of ['main.js', 'main.css']) bundles[file] = createHash('sha256').update(await readFile(join(receipt.paths.extension, 'dist', 'webview', file))).digest('hex');
    await writeFile(join(output, `${name}.json`), JSON.stringify({ scenario: name, capturedAt: new Date().toISOString(), bundles, ...JSON.parse(dom) }, null, 2));
    if (screenshot) await writeFile(join(output, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
  };
  captureFailure = () => capture('failure');
  const click = selector => view(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled || !e.getBoundingClientRect().width) return false; e.click(); return true; })()`);
  const disk = () => Promise.all(['review-first.txt', 'review-second.txt'].map(f => readFile(join(receipt.paths.workspace, f))));
  const hashes = bytes => bytes.map(b => createHash('sha256').update(b).digest('hex'));
  await request('setup');
  await waitView("document.querySelector('[data-action=undo-all]:not(:disabled)') && document.querySelector('[data-action=keep-all]') && document.querySelector('.review-open')", 'review controls');
  assert('two pending files', await view("document.querySelector('.change-toggle')?.innerText.includes('2')"));
  const scripts = await view("[...document.scripts].map(x=>x.src).join(' ')");
  const styles = await view("[...document.querySelectorAll('link[rel=stylesheet]')].map(x=>x.href).join(' ')");
  assert('production assets', scripts.includes('/dist/webview/main.js') && styles.includes('/dist/webview/main.css'));
  await capture('pending');
  assert('review click', await click('.review-open'));
  await deadlineWait(() => workbench("document.body.innerText.includes('AI Agents (2 files)')"), 'two-file review editor');
  const beforeKeep = hashes(await disk());
  assert('keep click', await click('[data-action=keep-all]'));
  await waitView("!document.querySelector('[data-action=keep-all]') && !!document.querySelector('.review-open')", 'accepted review');
  const kept = await request('state');
  assert('keep preserved file hashes', JSON.stringify(beforeKeep) === JSON.stringify(hashes(await disk())));
  assert('host recorded acceptance and retained files', Boolean(kept.acceptance) && kept.changes.length === 2);
  await capture('kept');
  if (process.argv.includes('--keep-only')) {
    await request('flush');
  } else {
  await request('new-change');
  await waitView("document.querySelector('[data-action=keep-all]') && document.querySelector('.change-toggle')?.innerText.includes('3')", 'new change becomes pending');
  const revised = await request('state');
  assert('new file returns accepted review to pending', revised.changes.length === 3 && (await readFile(join(receipt.paths.workspace, 'review-third.txt'), 'utf8')) === 'after third\n');
  await capture('new-change');
  await request('setup');
  await waitView("document.querySelector('[data-action=undo-all]:not(:disabled)')", 'undo enabled');
  assert('double undo click', await view("(() => { const e = document.querySelector('[data-action=undo-all]'); if (!e || e.disabled) return false; e.click(); e.click(); return true; })()"));
  await deadlineWait(() => workbench("!![...document.querySelectorAll('.monaco-dialog-box [role=button]')].find(e => e.innerText.trim() === 'Undo All')"), 'confirmation');
  assert('confirmation precedes file changes', JSON.stringify(beforeKeep) === JSON.stringify(hashes(await disk())));
  await capture('confirmation');
  assert('confirmation click', await workbench("(() => { const e = [...document.querySelectorAll('.monaco-dialog-box [role=button]')].find(e => e.innerText.trim() === 'Undo All'); if (!e) return false; e.click(); return true; })()"));
  await deadlineWait(async () => (await disk()).map(b => b.toString()).join('') === 'before 0\nbefore 1\n', 'files restored');
  await waitView("!document.querySelector('.review-bar')", 'review cleared');
  assert('double click leaves no second dialog', !await workbench("!!document.querySelector('.monaco-dialog-box')"));
  const undone = await request('state');
  assert('host cleared restored changes', undone.changes.length === 0);
  await capture('undone');
  await request('setup');
  await waitView("document.querySelector('[data-action=undo-all]:not(:disabled)')", 'undo enabled before conflict');
  assert('conflict undo click', await click('[data-action=undo-all]'));
  await deadlineWait(() => workbench("!![...document.querySelectorAll('.monaco-dialog-box [role=button]')].find(e => e.innerText.trim() === 'Undo All')"), 'conflict confirmation');
  await writeFile(join(receipt.paths.workspace, 'review-second.txt'), 'external edit\n');
  assert('conflict confirmation click', await workbench("(() => { const e = [...document.querySelectorAll('.monaco-dialog-box [role=button]')].find(e => e.innerText.trim() === 'Undo All'); if (!e) return false; e.click(); return true; })()"));
  await waitView("document.body.innerText.includes('Files changed after confirmation')", 'conflict report');
  const conflicted = await request('state');
  assert('conflict preserves both files and review', JSON.stringify((await disk()).map(b => b.toString())) === JSON.stringify(['after 0\n', 'external edit\n']) && conflicted.changes.length === 2);
  await capture('conflict');
  await request('partial');
  await waitView("document.querySelector('[data-action=undo-all]:not(:disabled)')", 'partial failure preflight');
  assert('partial failure undo click', await click('[data-action=undo-all]'));
  await deadlineWait(() => workbench("!![...document.querySelectorAll('.monaco-dialog-box [role=button]')].find(e => e.innerText.trim() === 'Undo All')"), 'partial failure confirmation');
  assert('partial failure confirmation click', await workbench("(() => { const e = [...document.querySelectorAll('.monaco-dialog-box [role=button]')].find(e => e.innerText.trim() === 'Undo All'); if (!e) return false; e.click(); return true; })()"));
  await waitView("document.body.innerText.includes('Undo All did not finish')", 'partial failure report');
  const partial = await request('state');
  assert('partial failure reports and retains only failed file', partial.changes.length === 1 && JSON.stringify(partial.contents) === JSON.stringify(['before 0\n', 'after 1\n']));
  await capture('partial-failure');
  for (const [action, expected] of [
    ['rename', '移動'], ['outside', 'ワークスペース外'], ['missing-baseline', '変更前'],
    ['symlink', '通常ファイル以外'], ['dirty', '未保存'],
  ]) {
    await request(action);
    await waitView(`document.querySelector('[data-action=undo-all]')?.disabled && document.querySelector('.review-note')?.textContent.includes(${JSON.stringify(expected)})`, `${action} disabled with reason`);
    assert(`${action} blocks undo with reason`, true);
    await capture(`blocked-${action}`);
  }
  }
} catch (error) {
  await writeFile(join(output, 'error.txt'), String(error));
  try { await captureFailure?.(); } catch { /* Preserve the original failure if the target disappeared. */ }
  process.exitCode = 1;
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify({ capturedAt: new Date().toISOString(), sessionRoot: root, assertions }, null, 2));
  wb.ws.close(); web.ws.close();
}
