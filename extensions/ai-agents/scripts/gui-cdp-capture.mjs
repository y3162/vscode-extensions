// Capture only a session created by gui-session.mjs with AI_AGENTS_GUI_CDP=1.
import { readFile, writeFile, mkdir, realpath, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = await realpath(process.argv[2] || '');
const output = resolve(process.argv[3] || '');
if (!root.startsWith('/private/tmp/ai-agents-gui-acceptance-') || !process.argv[3]) throw new Error('Usage: node scripts/gui-cdp-capture.mjs <isolated-session-root> <output-directory>');
const receipt = JSON.parse(await readFile(join(root, 'session.json'), 'utf8'));
if (receipt.sessionRoot !== root || !receipt.launchArgs.includes('--remote-debugging-port=0')) throw new Error('Not an isolated CDP-enabled session');
process.kill(receipt.processId, 0);
const [port, browserPath] = (await readFile(join(receipt.paths.userData, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
if (!/^\d+$/.test(port) || !browserPath?.startsWith('/devtools/browser/')) throw new Error('Invalid profile debugging endpoint');
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(x => x.type === 'page' && x.title.includes('[Extension Development Host]'));
const frame = list.find(x => x.type === 'iframe' && x.parentId === page?.id && x.url.includes('extensionId=y3162.ai-agents'));
if (!page || !frame) throw new Error('Development Host or AI Agents webview not visible');
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let id = 0; const pending = new Map();
  ws.onmessage = event => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } };
  return { ws, call(method, params = {}) { return new Promise((ok, fail) => { const n = ++id; pending.set(n, m => m.error ? fail(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id: n, method, params })); }); } };
}
const workbench = await connect(page); const webview = await connect(frame);
try {
  const targets = await workbench.call('Target.getTargets');
  const tree = await webview.call('Page.getFrameTree');
  const active = tree.frameTree.childFrames?.find(x => x.frame.name === 'active-frame');
  if (!active) throw new Error('Webview active-frame not found');
  const world = await webview.call('Page.createIsolatedWorld', { frameId: active.frame.id, worldName: 'ai-agents-acceptance' });
  const evaluate = async expression => (await webview.call('Runtime.evaluate', { contextId: world.executionContextId, expression, returnByValue: true })).result.value;
  const waitFor = async (expression, label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const scenarioArg = process.argv.find(arg => arg.startsWith('--scenario='));
  if (scenarioArg) {
    if (!receipt.launchArgs.some(arg => arg.includes('host-viewmodel.cjs'))) throw new Error('Not a ViewModel fixture host');
    const scenario = scenarioArg.slice('--scenario='.length);
    if (!/^T0[1-6]$/.test(scenario)) throw new Error('Unknown fixture scenario');
    const session = process.argv.includes('--session-b') ? 'b' : 'a';
    const id = crypto.randomUUID();
    await writeFile(join(root, 'viewmodel-scenario.json'), JSON.stringify({ id, scenario, session }));
    const deadline = Date.now() + 15000;
    let response;
    while (Date.now() < deadline) {
      try { response = JSON.parse(await readFile(join(root, 'viewmodel-result.json'), 'utf8')); } catch {}
      if (response?.id === id) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (response?.id !== id) throw new Error('Timed out waiting for fixture Host');
    const condition = scenario === 'T05' ? "document.body.innerText.includes('Fixture turn complete') && !document.body.innerText.includes('Running')"
      : scenario === 'T02' ? "document.querySelector('.thinking')?.textContent.includes('Fixture thinking updated')"
      : scenario === 'T03' ? "document.querySelector('.thinking summary')?.textContent.includes('Thought')"
      : scenario === 'T04' ? "document.querySelector('.thinking summary')?.textContent.includes('Thought') && document.body.innerText.includes('Running')"
      : "document.querySelector('.thinking summary')?.textContent.includes('Thinking')";
    await waitFor(condition, scenario);
    if (process.argv.includes('--expect-open')) await waitFor("!!document.querySelector('details.thinking[open]')", 'thinking open');
    if (process.argv.includes('--expect-closed')) await waitFor("!!document.querySelector('details.thinking:not([open])')", 'thinking closed');
  }
  if (process.argv.includes('--open-chat')) {
    const opened = await webview.call('Runtime.evaluate', { contextId: world.executionContextId, expression: `(() => { const button = document.querySelector('.home-start.new-chat'); if (!button || !button.getBoundingClientRect().width) return false; button.click(); return true; })()`, returnByValue: true });
    if (!opened.result.value) throw new Error('Visible New chat button not found');
    await waitFor("!!document.querySelector('.composer-card textarea')", 'composer');
  }
  if (process.argv.includes('--send-thinking')) {
    await Promise.all(['gui-release-thinking', 'gui-update-thinking', 'gui-complete-thinking', 'gui-start-tool'].map(name => rm(join(receipt.paths.workspace, name), { force: true })));
    const sent = await webview.call('Runtime.evaluate', { contextId: world.executionContextId, expression: `(() => { const input = document.querySelector('.composer-card textarea'); const button = document.querySelector('.composer-card button.send'); if (!input || !button || button.disabled || !input.getBoundingClientRect().width) return false; input.value = 'GUI_THINKING_GATE'; input.dispatchEvent(new Event('input', { bubbles: true })); button.click(); return true; })()`, returnByValue: true });
    if (!sent.result.value) throw new Error('Visible composer not found');
    await waitFor("!!document.querySelector('details.thinking[open]')", 'running thinking');
  }
  if (process.argv.includes('--close-thinking')) {
    if (!await evaluate("(() => { const e = document.querySelector('details.thinking[open] summary'); if (!e) return false; e.click(); return true; })()")) throw new Error('Open thinking not found');
    await waitFor("!!document.querySelector('details.thinking:not([open])')", 'thinking closed');
  }
  if (process.argv.includes('--open-thinking')) {
    if (!await evaluate("(() => { const e = document.querySelector('details.thinking:not([open]) summary'); if (!e) return false; e.click(); return true; })()")) throw new Error('Closed thinking not found');
    await waitFor("!!document.querySelector('details.thinking[open]')", 'thinking open');
  }
  if (process.argv.includes('--update-thinking')) {
    await writeFile(join(receipt.paths.workspace, 'gui-update-thinking'), '');
    await waitFor("document.querySelector('details.thinking')?.textContent.includes('acceptance updated')", 'updated thinking');
  }
  if (process.argv.includes('--complete-thinking')) {
    await writeFile(join(receipt.paths.workspace, 'gui-complete-thinking'), '');
    await waitFor("document.querySelector('.thinking summary')?.textContent.includes('Thought') && document.body.innerText.includes('Running')", 'completed thinking during running turn');
  }
  if (process.argv.includes('--start-tool')) {
    await writeFile(join(receipt.paths.workspace, 'gui-start-tool'), '');
    await waitFor("document.body.innerText.includes('Running fixture tool') && document.querySelector('.thinking summary')?.textContent.includes('Thought')", 'running tool after thinking');
  }
  if (process.argv.includes('--release-thinking')) {
    await writeFile(join(receipt.paths.workspace, 'gui-release-thinking'), '');
    await waitFor("document.body.innerText.includes('Synthetic thinking complete') && !document.body.innerText.includes('Running')", 'completed turn');
  }
  const expression = `JSON.stringify({url:location.href,bodyClass:document.body.className,text:document.body.innerText,html:document.body.outerHTML,scripts:[...document.scripts].map(e=>e.src),stylesheets:[...document.querySelectorAll('link[rel=stylesheet]')].map(e=>e.href),elements:[...document.querySelectorAll('.composer-card,.composer-row,.activity-row,.bubble.user-card,.thinking,button,textarea')].map(e=>{const s=getComputedStyle(e);return {tag:e.tagName,className:e.className,text:e.innerText,open:e instanceof HTMLDetailsElement ? e.open : undefined,ariaExpanded:e.querySelector('summary')?.getAttribute('aria-expanded'),rect:e.getBoundingClientRect().toJSON(),display:s.display,fontSize:s.fontSize,lineHeight:s.lineHeight,borderRadius:s.borderRadius,borderColor:s.borderTopColor,height:s.height,maxWidth:s.maxWidth}})})`;
  const evaluation = await webview.call('Runtime.evaluate', { contextId: world.executionContextId, expression, returnByValue: true });
  if (!evaluation.result.value) throw new Error('Webview DOM evaluation failed');
  const view = JSON.parse(evaluation.result.value);
  const visible = selector => view.elements.filter(e => e.className.split(' ').includes(selector) && e.rect.width > 0 && e.rect.height > 0);
  const assertions = [
    { name: 'production webview script', pass: view.scripts.some(src => src.includes('/dist/webview/main.js')) },
    { name: 'production webview stylesheet', pass: view.stylesheets.some(src => src.includes('/dist/webview/main.css')) },
    ...(scenarioArg ? [
      { name: 'fixture thinking rendered with matching aria-expanded', pass: view.elements.some(e => e.className === 'thinking' && e.ariaExpanded === String(e.open)) },
      { name: 'scenario state', pass: (() => {
        const thought = view.elements.find(e => e.className === 'thinking');
        const scenario = scenarioArg.slice('--scenario='.length);
        if (!thought) return false;
        if (scenario === 'T01') return thought.open && thought.ariaExpanded === 'true';
        if (scenario === 'T02') return !thought.open && thought.ariaExpanded === 'false' && view.html.includes('Fixture thinking updated');
        if (scenario === 'T03' || scenario === 'T04') return (process.argv.includes('--expect-open') ? thought.open : !thought.open) && /Thought/.test(thought.text) && view.text.includes('Running');
        if (scenario === 'T05') return !thought.open && view.text.includes('Fixture turn complete') && !view.text.includes('Running');
        return true;
      })() },
      ...(process.argv.includes('--expect-open') ? [{ name: 'thinking open', pass: view.elements.some(e => e.className === 'thinking' && e.open && e.ariaExpanded === 'true') }] : []),
      ...(process.argv.includes('--expect-closed') ? [{ name: 'thinking closed', pass: view.elements.some(e => e.className === 'thinking' && !e.open && e.ariaExpanded === 'false') }] : []),
    ] : process.argv.includes('--open-chat') ? [
      { name: 'visible composer', pass: visible('composer-card').length === 1 },
      { name: 'composer action row is 28px', pass: visible('composer-row').some(e => Math.abs(e.rect.height - 28) < 0.1) },
      { name: 'composer radius is 12px', pass: visible('composer-card').some(e => e.borderRadius === '12px') },
    ] : process.argv.includes('--send-thinking') ? [
      { name: 'running thinking visible and open', pass: visible('thinking').some(e => e.open && /Synthetic thinking for GUI acceptance/.test(e.text) && /Thinking/.test(e.text)) },
    ] : process.argv.includes('--close-thinking') || process.argv.includes('--open-thinking') || process.argv.includes('--update-thinking') || process.argv.includes('--complete-thinking') || process.argv.includes('--start-tool') || process.argv.includes('--release-thinking') ? [
      { name: 'thinking choice', pass: view.elements.some(e => e.className === 'thinking' && e.open === process.argv.includes('--open-thinking')) },
      ...(process.argv.includes('--release-thinking') ? [{ name: 'turn completed', pass: view.text.includes('Synthetic thinking complete') && !view.text.includes('Running') }] : []),
    ] : [{ name: 'visible Home New chat', pass: visible('home-start').length === 1 }]),
  ];
  const dom = await webview.call('DOM.getDocument', { depth: -1, pierce: true });
  const snapshot = await webview.call('DOMSnapshot.captureSnapshot', { computedStyles: ['display', 'font-size', 'line-height', 'border-radius'] });
  const screenshot = await workbench.call('Page.captureScreenshot', { format: 'png' });
  await mkdir(output, { recursive: true });
  await Promise.all([
    writeFile(join(output, 'capture.json'), JSON.stringify({ capturedAt: new Date().toISOString(), receipt, targets, tree, assertions, webview: view, dom, snapshot }, null, 2)),
    writeFile(join(output, 'workbench.png'), Buffer.from(screenshot.data, 'base64')),
  ]);
  console.log(`Captured Development Host evidence in ${output}`);
  if (assertions.some(item => !item.pass)) { console.error('GUI_ASSERTION_FAILED', JSON.stringify(assertions)); process.exitCode = 1; }
} finally { workbench.ws.close(); webview.ws.close(); }
