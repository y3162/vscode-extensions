// Capture only a session created by gui-session.mjs with AI_AGENTS_GUI_CDP=1.
import { readFile, writeFile, mkdir, realpath, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
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
  ws.onmessage = event => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) { pending.get(message.id).resolve(message); pending.delete(message.id); } };
  ws.onclose = () => { for (const item of pending.values()) item.reject(new Error('CDP connection closed')); pending.clear(); };
  return { ws, call(method, params = {}) { return new Promise((ok, fail) => { const n = ++id; pending.set(n, { resolve: m => m.error ? fail(new Error(JSON.stringify(m.error))) : ok(m.result), reject: fail }); try { ws.send(JSON.stringify({ id: n, method, params })); } catch (error) { pending.delete(n); fail(error); } }); } };
}
const workbench = await connect(page); const webview = await connect(frame);
try {
  const targets = await workbench.call('Target.getTargets');
  const tree = await webview.call('Page.getFrameTree');
  const workbenchGeometry = (await workbench.call('Runtime.evaluate', {returnByValue: true, expression: `JSON.stringify({at:Date.now(), windowWidth:innerWidth, sidebar:document.querySelector('.part.sidebar')?.getBoundingClientRect().toJSON(), frames:[...document.querySelectorAll('iframe')].map(e=>({src:e.src, rect:e.getBoundingClientRect().toJSON(), visible:getComputedStyle(e).visibility, display:getComputedStyle(e).display}))})`})).result.value;
  const outerGeometry = (await webview.call('Runtime.evaluate', {returnByValue: true, expression: `JSON.stringify({at:Date.now(), width:innerWidth, documentWidth:document.documentElement.clientWidth, frames:[...document.querySelectorAll('iframe')].map(e=>({name:e.name, rect:e.getBoundingClientRect().toJSON(), visible:getComputedStyle(e).visibility, display:getComputedStyle(e).display}))})`})).result.value;
  const active = tree.frameTree.childFrames?.find(x => x.frame.name === 'active-frame');
  if (!active) throw new Error('Webview active-frame not found');
  const world = await webview.call('Page.createIsolatedWorld', { frameId: active.frame.id, worldName: 'ai-agents-acceptance' });
  const evaluate = async expression => (await webview.call('Runtime.evaluate', { contextId: world.executionContextId, expression, returnByValue: true })).result.value;
  const waitFor = async (expression, label) => {
    const started = Date.now();
    const deadline = started + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await mkdir(output, { recursive: true });
    const dom = await evaluate("JSON.stringify({html:document.body.outerHTML,text:document.body.innerText,width:document.documentElement.clientWidth})");
    const host = {};
    for (const name of ['viewmodel-result.json', 'interaction-state.json']) {
      try { host[name] = JSON.parse(await readFile(join(root, name), 'utf8')); } catch {}
    }
    await writeFile(join(output, 'timeout.json'), JSON.stringify({label, expression, elapsedMs: Date.now() - started, host, dom: JSON.parse(dom)}, null, 2));
    throw new Error(`Timed out waiting for ${label}`);
  };
  const scenarioArg = process.argv.find(arg => arg.startsWith('--scenario='));
  if (scenarioArg) {
    if (!receipt.launchArgs.some(arg => arg.includes('host-viewmodel.cjs'))) throw new Error('Not a ViewModel fixture host');
    const scenario = scenarioArg.slice('--scenario='.length);
    if (!/^T0[1-6]$/.test(scenario)) throw new Error('Unknown fixture scenario');
    const session = process.argv.includes('--session-b') ? 'b' : 'a';
    const id = crypto.randomUUID();
    await writeFile(join(root, 'viewmodel-scenario.json'), JSON.stringify({ id, scenario, session, layout: process.argv.includes('--layout-interactions') }));
    const deadline = Date.now() + 15000;
    let response;
    while (Date.now() < deadline) {
      try { response = JSON.parse(await readFile(join(root, 'viewmodel-result.json'), 'utf8')); } catch {}
      if (response?.id === id) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (response?.id !== id) throw new Error('Timed out waiting for fixture Host');
    if (scenario === 'T05') {
      await waitFor("document.querySelector('.turn.done .answer')?.textContent.includes('Fixture turn complete')", 'completed answer DOM');
      await evaluate("document.querySelector('.turn.done .answer').scrollIntoView({block:'center'})");
      await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    }
    const condition = scenario === 'T05' ? "document.body.innerText.includes('Fixture turn complete') && !document.body.innerText.includes('Running')"
      : scenario === 'T02' ? "document.querySelector('.thinking')?.textContent.includes('Fixture thinking updated')"
      : scenario === 'T03' ? "document.querySelector('.thinking summary')?.textContent.includes('Thought')"
      : scenario === 'T04' ? "document.querySelector('.thinking summary')?.textContent.includes('Thought') && document.body.innerText.includes('Running')"
      : "document.querySelector('.thinking summary')?.textContent.includes('Thinking')";
    await waitFor(condition, scenario);
    if (process.argv.includes('--expect-open') && !process.argv.includes('--ensure-open')) await waitFor("!!document.querySelector('details.thinking[open]')", 'thinking open');
    if (process.argv.includes('--expect-closed')) await waitFor("!!document.querySelector('details.thinking:not([open])')", 'thinking closed');
  }
  const approvalUnsupported = process.argv.includes('--approval-unsupported');
  const approvalStart = process.argv.find(arg => arg.startsWith('--approval-flow-start='));
  const approvalFinish = process.argv.find(arg => arg.startsWith('--approval-flow-finish='));
  if (approvalUnsupported) {
    let state; const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { try { state = JSON.parse(await readFile(join(root, 'interaction-state.json'), 'utf8')); break; } catch {} await new Promise(r => setTimeout(r, 50)); }
    if (state.provider !== 'codex' || state.backend !== 'cli') throw Error('Expected unsupported Codex CLI capability');
    if (!await evaluate("(()=>{const b=document.querySelector('button.access-label');if(!b||!b.getBoundingClientRect().width)return false;b.click();return true})()")) throw Error('Settings button missing');
    await waitFor("!!document.querySelector('.settings-panel:not([hidden])')", 'settings');
    if (await evaluate("!!document.querySelector('.settings-panel select[data-key=approval]') || !!document.querySelector('.pending-target') || [...document.querySelectorAll('.settings-panel button')].some(b => /Auto-approve|自動承認/.test(b.textContent))")) throw Error('Unsupported CLI exposed approval UI');
    await evaluate("document.querySelector('.settings-panel .panel-bar button').click()");
  }
  if (approvalStart) {
    const kind = approvalStart.split('=')[1];
    if (!['allow','deny'].includes(kind)) throw Error('Invalid approval flow');
    if (!await evaluate(`(()=>{const i=document.querySelector('.composer-card textarea');if(!i)return false;i.value='approval flow ${kind}';i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)) throw Error('Approval flow composer unavailable');
    await waitFor("!!document.querySelector('.composer-card button.send:not([disabled])')", 'approval flow send');
    await evaluate("document.querySelector('.composer-card button.send').click()");
    await waitFor("!!document.querySelector('.pending-target') && !!document.querySelector('button.stop:not([hidden])')", 'backend waiting for permission');
  }
  if (approvalFinish) {
    const kind = approvalFinish.split('=')[1];
    if (!['allow','deny'].includes(kind)) throw Error('Invalid approval outcome');
    await waitFor(`document.body.innerText.includes('Fixture command ${kind === 'deny' ? 'denied' : 'executed'}') && !document.querySelector('.pending-target') && !document.body.innerText.includes('Running')`, 'backend after permission');
    const deadline = Date.now() + 15000; let flow;
    while (Date.now() < deadline) { try { flow = JSON.parse(await readFile(join(root, `approval-flow-${kind}.json`), 'utf8')); break; } catch {} await new Promise(r => setTimeout(r, 50)); }
    if (flow?.decision !== (kind === 'deny' ? 'deny' : 'allow-once') || flow.effect !== (kind === 'allow')) throw Error('Backend permission outcome mismatch');
    let effect = false; try { effect = (await readFile(join(receipt.paths.workspace, 'approval-command-effect.txt'), 'utf8')) === 'allowed\n'; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (effect !== (kind === 'allow')) throw Error('Backend effect mismatch');
  }
  const permissionRequest = process.argv.find(arg => arg.startsWith('--permission-request='));
  const permissionVisible = process.argv.includes('--permission-visible');
  const permissionDecision = process.argv.find(arg => arg.startsWith('--permission-decision='));
  if (permissionRequest || permissionDecision) {
    if (!receipt.launchArgs.some(arg => (arg.includes('host-interaction.cjs') || arg.includes('host-visual.cjs')))) throw new Error('Not an interaction fixture host');
    if (permissionRequest) {
      await writeFile(join(root, 'interaction-request.json'), JSON.stringify({ id: permissionRequest.split('=')[1], detail: 'printf fixture\nfile: fixture.txt' }));
      await waitFor("document.querySelector('.pending-target')?.textContent.includes('printf fixture')", 'permission request');
    }
    if (permissionDecision) {
      const decision = permissionDecision.split('=')[1];
      if (!['allow-once', 'allow-session', 'deny'].includes(decision)) throw new Error('Invalid decision');
      if (!await evaluate(`(() => {const b = document.querySelector('[data-decision="${decision}"]'); if (!b || b.disabled) return false; b.click(); const choices=[...document.querySelectorAll('.pending-card .card-actions button')]; if (!choices.length || choices.some(x=>!x.disabled)) return false; choices.at(-1).dispatchEvent(new MouseEvent('click',{bubbles:true})); return true})()`)) throw new Error('Permission button missing or duplicate prevention failed');
      await waitFor("!document.querySelector('.pending-target')", 'permission resolved');
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        try { const result = JSON.parse(await readFile(join(root, 'interaction-result.json'), 'utf8')); if (result.decision === decision && result.token === null) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const result = JSON.parse(await readFile(join(root, 'interaction-result.json'), 'utf8'));
      if (result.decision !== decision || result.token !== null) throw new Error('Controller permission result mismatch');
    }
  }
  const planInspect = process.argv.includes('--plan-inspect');
  const planReady = process.argv.includes('--plan-ready');
  const planView = process.argv.includes('--plan-view');
  const planBuild = process.argv.includes('--plan-build');
  if (planReady || planView || planBuild) {
    if (!receipt.launchArgs.some(arg => (arg.includes('host-interaction.cjs') || arg.includes('host-visual.cjs')))) throw new Error('Not an interaction fixture host');
    if (planReady) {
      await writeFile(join(root, 'interaction-request.json'), JSON.stringify({id: 'plan-ready', action: 'plan'}));
      await waitFor("!!document.querySelector('.plan-view.phase-ready .build:not([disabled])')", 'ready plan');
    }
    if (planView) {
      if (!await evaluate("(() => {const b=document.querySelector('.plan-view-toggle'); if(!b) return false; b.click(); return true})()")) throw new Error('View Plan button not found');
      await waitFor("!!document.querySelector('.plan-body') && document.querySelector('.plan-view-toggle')?.getAttribute('aria-expanded') === 'true'", 'expanded plan');
    }
    if (planBuild) {
      if (!await evaluate("(() => {const b=document.querySelector('.plan-view .build:not([disabled])'); if(!b) return false; b.click(); return true})()")) throw new Error('Enabled Build button not found');
      await waitFor("!!document.querySelector('.plan-view.phase-implemented')", 'implemented plan');
      const end = Date.now() + 15000;
      let state;
      while (Date.now() < end) {
        try { state = JSON.parse(await readFile(join(root, 'interaction-state.json'), 'utf8')); if (state.phase === 'implemented' && !state.busy) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (state?.phase !== 'implemented' || state.busy) throw new Error('Controller plan did not finish');
      const invocations = JSON.parse(await readFile(join(receipt.paths.workspace, 'invocations.json'), 'utf8'));
      if (!invocations.some(item => item.prompt.includes('Implement the following plan') && item.prompt.includes('Implement fixture behavior'))) throw new Error('Mock backend did not receive plan');
    }
  }
  const subagentArg = process.argv.find(arg => arg.startsWith('--subagent='));
  if (subagentArg) {
    if (!receipt.launchArgs.some(arg => (arg.includes('host-interaction.cjs') || arg.includes('host-visual.cjs')))) throw new Error('Not an interaction fixture host');
    const stage = subagentArg.split('=')[1];
    if (stage === 'start') {
      const id=crypto.randomUUID();
      await writeFile(join(root, 'interaction-request.json'), JSON.stringify({ id, action: 'subagent-setup' }));
      const deadline=Date.now()+15000; let ready=false;
      while(Date.now()<deadline){try{ready=JSON.parse(await readFile(join(root,'interaction-result.json'),'utf8')).id===id;if(ready)break}catch{} await new Promise(resolve=>setTimeout(resolve,50));}
      if(!ready) throw Error('Timeout preparing mock subagent session');
      if (!await evaluate(`(() => { const input=document.querySelector('.composer-card textarea'); if(!input)return false; input.value='Fixture parent'; input.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`)) throw Error('Parent composer missing');
      await waitFor("!!document.querySelector('.composer-card button.send:not([disabled])')", 'parent send enabled');
      await evaluate("document.querySelector('.composer-card button.send').click()");
      await waitFor("document.body.innerText.includes('Fixture parent') && !!document.querySelector('.composer-card button.stop:not([hidden])')", 'parent running');
      const readyBy=Date.now()+15000; let backendReady=false;
      while(Date.now()<readyBy){try{backendReady=Boolean(JSON.parse(await readFile(join(root,'interaction-state.json'),'utf8')).childReady);if(backendReady)break}catch{} await new Promise(resolve=>setTimeout(resolve,50));}
      if(!backendReady) throw Error('Timeout waiting for mock parent run');
      const state = JSON.parse(await readFile(join(root, 'interaction-state.json'), 'utf8'));
      if (state.children?.length || await evaluate("!!document.querySelector('.subagent[data-subagent-id]')")) throw Error('Subagent appeared before any child event');
    } else {
      const [child,status] = stage.split(':');
      await writeFile(join(root, 'interaction-request.json'), JSON.stringify({ id: crypto.randomUUID(), action: 'subagent-event', child, status }));
      const deadline = Date.now()+15000;
      let matched=false;
      while(Date.now()<deadline) {
        try { const state=JSON.parse(await readFile(join(root,'interaction-state.json'),'utf8'));
          matched=child==='finish' ? !state.busy : child==='wait' ? Boolean(state.waiting)===(status==='running') : state.children?.some(x=>x.id===child&&x.status===status);
          if(matched) break;
        } catch {}
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      if(!matched) throw Error(`Controller did not observe ${stage}`);
      if (child!=='wait' && child!=='finish') await waitFor(`document.querySelector('button.subagent[data-subagent-id="${child}"]')?.classList.contains('${status}')`, `child ${child} ${status}`);
      if (child==='wait' && status==='running') await waitFor("document.body.innerText.includes('Waiting for subagent')", 'parent waiting');
      if (child==='finish') await waitFor("document.body.innerText.includes('Ready') && !document.body.innerText.includes('Waiting for subagent')", 'parent resumed and ready');
    }
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
  if (process.argv.includes('--ensure-open')) {
    if (!await evaluate("(() => { const e = document.querySelector('details.thinking'); if (!e) return false; if (!e.open) e.querySelector('summary').click(); return true; })()")) throw new Error('Thinking not found');
    await waitFor("!!document.querySelector('details.thinking[open]')", 'thinking open');
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
    await waitFor("document.querySelector('.turn.done .answer')?.textContent.includes('Synthetic thinking complete')", 'completed turn DOM');
    await evaluate("document.querySelector('.turn.done .answer').scrollIntoView({block:'center'})");
    await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await waitFor("document.body.innerText.includes('Synthetic thinking complete') && !document.body.innerText.includes('Running')", 'completed turn');
  }
  let interactions;
  if (process.argv.includes('--layout-interactions')) interactions = await evaluate(`(() => { const input=document.querySelector('.composer-card textarea'), thread=document.querySelector('.thread'), composer=document.querySelector('.composer-card'); input.focus(); const focused=document.activeElement===input, style=getComputedStyle(composer); const before=thread.scrollTop; thread.scrollTop=0; const top=thread.scrollTop; thread.scrollTop=thread.scrollHeight; return {focused, focusOutline:style.outlineStyle, focusColor:style.outlineColor, focusWidth:style.outlineWidth, before, top, bottom:thread.scrollTop, scrollHeight:thread.scrollHeight, clientHeight:thread.clientHeight}; })()`);
  const expression = `JSON.stringify({url:location.href,bodyClass:document.body.className,webviewWidth:document.documentElement.clientWidth,webviewHeight:document.documentElement.clientHeight,scrollWidth:document.documentElement.scrollWidth,theme:document.body.dataset.vscodeThemeName,foreground:getComputedStyle(document.body).color,background:getComputedStyle(document.body).backgroundColor,font:getComputedStyle(document.body).fontFamily,text:document.body.innerText,html:document.body.outerHTML,scripts:[...document.scripts].map(e=>e.src),stylesheets:[...document.querySelectorAll('link[rel=stylesheet]')].map(e=>e.href),elements:[...document.querySelectorAll('.composer-card,.composer-row,.activity-row,.activity-group > summary,.bubble.user-card,.thinking,button,textarea')].map(e=>{const s=getComputedStyle(e);return {tag:e.tagName,className:e.className,text:e.innerText,open:e instanceof HTMLDetailsElement ? e.open : undefined,ariaExpanded:e.querySelector('summary')?.getAttribute('aria-expanded'),rect:e.getBoundingClientRect().toJSON(),display:s.display,fontSize:s.fontSize,lineHeight:s.lineHeight,borderRadius:s.borderRadius,borderColor:s.borderTopColor,height:s.height,maxWidth:s.maxWidth}})})`;
  if (process.argv.includes('--subagent-visible')) await waitFor("document.body.innerText.includes('Fixture alpha') && document.body.innerText.includes('Fixture beta') && document.documentElement.outerHTML.includes('running')", 'two running subagents');
  const evaluation = await webview.call('Runtime.evaluate', { contextId: world.executionContextId, expression, returnByValue: true });
  if (!evaluation.result.value) throw new Error('Webview DOM evaluation failed');
  const view = JSON.parse(evaluation.result.value);
  const visible = selector => view.elements.filter(e => e.className.split(' ').includes(selector) && e.rect.width > 0 && e.rect.height > 0);
  const subagentVisible = process.argv.includes('--subagent-visible');
  const assertions = [
    { name: 'production webview script', pass: view.scripts.some(src => src.includes('/dist/webview/main.js')) },
    { name: 'production webview stylesheet', pass: view.stylesheets.some(src => src.includes('/dist/webview/main.css')) },
    ...(approvalUnsupported ? [{ name: 'unsupported approval controls hidden', pass: !view.html.includes('data-key="approval"') && !view.html.includes('pending-target') }] : approvalStart ? [{ name: 'backend waiting for approval', pass: view.text.includes('printf fixture') && view.html.includes('pending-target') }] : approvalFinish ? [{ name: 'backend completed permission decision', pass: view.text.includes(approvalFinish.endsWith('deny') ? 'Fixture command denied' : 'Fixture command executed') && !view.html.includes('pending-target') }] : scenarioArg ? [
      { name: 'fixture thinking rendered with matching aria-expanded', pass: view.elements.some(e => e.className === 'thinking' && e.ariaExpanded === String(e.open)) },
      { name: 'scenario state', pass: (() => {
        const thought = view.elements.find(e => e.className === 'thinking');
        const scenario = scenarioArg.slice('--scenario='.length);
        if (!thought) return false;
        if (scenario === 'T01') return thought.open && thought.ariaExpanded === 'true';
        if (scenario === 'T02') return !thought.open && thought.ariaExpanded === 'false' && view.html.includes('Fixture thinking updated');
        if (scenario === 'T03' || scenario === 'T04') return (process.argv.includes('--expect-open') ? thought.open : !thought.open) && /Thought/.test(thought.text) && view.text.includes('Running');
        if (scenario === 'T05') return !thought.open && view.text.includes('Fixture turn complete') && !view.text.includes('Running');
        if (scenario === 'T06') return thought.ariaExpanded === String(thought.open) && (process.argv.includes('--expect-open') ? thought.open : process.argv.includes('--expect-closed') ? !thought.open : false);
        return false;
      })() },
      ...(process.argv.includes('--expect-open') ? [{ name: 'thinking open', pass: view.elements.some(e => e.className === 'thinking' && e.open && e.ariaExpanded === 'true') }] : []),
      ...(process.argv.includes('--expect-closed') ? [{ name: 'thinking closed', pass: view.elements.some(e => e.className === 'thinking' && !e.open && e.ariaExpanded === 'false') }] : []),
    ] : subagentVisible ? [{ name: 'two running children rendered', pass: view.text.includes('Fixture alpha') && view.text.includes('Fixture beta') && view.html.includes('running') }] : subagentArg ? [{ name: 'parent and child state rendered', pass: view.text.includes('Fixture parent') && (subagentArg.endsWith('start') || subagentArg.includes('wait:') || subagentArg.includes('finish:') || view.html.includes('Fixture ')) }] : planInspect ? [{ name: 'expanded plan and selected model', pass: view.html.includes('plan-body') && view.text.includes('Second Model') }] : planReady ? [{ name: 'ready plan with enabled Build', pass: view.html.includes('phase-ready') && view.text.includes('Fixture Plan') }] : planView ? [{ name: 'expanded Markdown plan', pass: view.html.includes('plan-body') && view.text.includes('Implement fixture behavior') }] : planBuild ? [{ name: 'build finished in DOM and controller', pass: view.html.includes('phase-implemented') }] : (permissionRequest || permissionVisible) ? [{ name: 'permission request and choices rendered', pass: view.text.includes('printf fixture') && view.html.includes('file: fixture.txt') && ['allow-once', 'allow-session', 'deny'].every(x => view.html.includes(`data-decision=\"${x}\"`)) }] : permissionDecision ? [{ name: 'permission resolved in DOM and controller', pass: !view.html.includes('pending-target') }] : process.argv.includes('--open-chat') ? [
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
  const screenshot = process.env.AI_AGENTS_GUI_NO_SCREENSHOTS === '1' ? null : await workbench.call('Page.captureScreenshot', { format: 'png' });
  await mkdir(output, { recursive: true });
  const bundles = {};
  for (const name of ['main.js', 'main.css']) {
    const path = join(receipt.paths.extension, 'dist', 'webview', name);
    bundles[name] = { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
  }
  await Promise.all([
    writeFile(join(output, 'capture.json'), JSON.stringify({ capturedAt: new Date().toISOString(), scenario: scenarioArg?.slice('--scenario='.length) ?? subagentArg ?? (planReady ? 'plan-ready' : planView ? 'plan-view' : planBuild ? 'plan-build' : permissionRequest ?? permissionDecision ?? null), receipt, bundles, targets, tree, workbenchGeometry: JSON.parse(workbenchGeometry), outerGeometry: JSON.parse(outerGeometry), assertions, interactions, webview: view, dom, snapshot }, null, 2)),
    ...(screenshot ? [writeFile(join(output, 'workbench.png'), Buffer.from(screenshot.data, 'base64'))] : []),
  ]);
  console.log(`Captured Development Host evidence in ${output}`);
  if (assertions.some(item => !item.pass)) { console.error('GUI_ASSERTION_FAILED', JSON.stringify(assertions)); process.exitCode = 1; }
} catch (error) {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'error.txt'), String(error));
  try {
    if (process.env.AI_AGENTS_GUI_NO_SCREENSHOTS !== '1') {
      const screenshot = await workbench.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(output, 'failure.png'), Buffer.from(screenshot.data, 'base64'));
    }
    const failureTree = await webview.call('Page.getFrameTree');
    await writeFile(join(output, 'failure-frame-tree.json'), JSON.stringify({ capturedAt: new Date().toISOString(), failureTree }, null, 2));
    const active = failureTree.frameTree.childFrames?.find(item => item.frame.name === 'active-frame');
    if (active) {
      const world = await webview.call('Page.createIsolatedWorld', { frameId: active.frame.id, worldName: 'ai-agents-failure-evidence' });
      const result = await webview.call('Runtime.evaluate', { contextId: world.executionContextId, expression: 'JSON.stringify({ text: document.body?.innerText, html: document.documentElement?.outerHTML })', returnByValue: true });
      await writeFile(join(output, 'failure-dom.json'), JSON.stringify({ capturedAt: new Date().toISOString(), dom: JSON.parse(result.result.value) }, null, 2));
    }
  } catch { /* Preserve the original failure when a target has disappeared. */ }
  throw error;
} finally { workbench.ws.close(); webview.ws.close(); }
