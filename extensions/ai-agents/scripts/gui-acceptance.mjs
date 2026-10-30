// Isolated development-host acceptance runner. A fixture result is never a full
// acceptance result: scenarios requiring real host actions remain explicit failures.
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const selected = args.find(a => a.startsWith('--scenario='))?.split('=')[1];
if (selected && !/^T(?:0[1-9]|1[0-9]|20)$/.test(selected)) throw new Error('Expected --scenario=T01 through T20');
const ids = selected ? [selected] : Array.from({length: 20}, (_, i) => `T${String(i + 1).padStart(2, '0')}`);
const output = resolve(process.env.AI_AGENTS_GUI_EVIDENCE || `/private/tmp/ai-agents-gui-evidence-${Date.now()}`);
await mkdir(output, {recursive: true});
const results = [];
let root;
let hostKind;
let hostSequence = 0;
function run(cmd, cmdArgs, env = {}, timeout = 180000) {
  return new Promise((done) => {
    const child = spawn(cmd, cmdArgs, {cwd: base, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    child.on('error', error => { clearTimeout(timer); done({code: null, stdout, stderr: `${stderr}\n${error}`, kind: 'launch'}); });
    child.on('close', code => { clearTimeout(timer); done({code, stdout, stderr, kind: timedOut ? 'timeout' : code === 0 ? 'ok' : 'failure'}); });
  });
}
async function waitFile(path, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { await access(path); return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for ${path}`);
}
async function capture(id, step, ...options) {
  const result = await run(process.execPath, ['scripts/gui-cdp-capture.mjs', root, join(output, id, step), ...options], {}, 30000);
  await mkdir(join(output, id, step), {recursive: true});
  await writeFile(join(output, id, step, 'runner.json'), JSON.stringify(result, null, 2));
  if (result.code !== 0) throw new Error(`${result.kind}: ${result.stderr || result.stdout}`);
}
async function startHost(kind) {
  const attempt = `${String(++hostSequence).padStart(3, '0')}-${kind}`;
  const env = {AI_AGENTS_GUI_CDP: '1', ...(kind === 'viewmodel' ? {AI_AGENTS_GUI_VIEWMODEL_FIXTURE: '1'} : kind === 'review'
    ? {AI_AGENTS_GUI_FIXTURE_ENTRY: 'host-review.cjs', AI_AGENTS_GUI_FIXTURE_EXTENSION: '1'}
    : kind === 'restore' ? {AI_AGENTS_GUI_FIXTURE_ENTRY: 'host-interaction.cjs', AI_AGENTS_GUI_FIXTURE_EXTENSION: '1'}
    : kind === 'subagent' ? {AI_AGENTS_GUI_FIXTURE_ENTRY: 'host-subagent-restore.cjs', AI_AGENTS_GUI_FIXTURE_EXTENSION: '1'}
    : kind === 'planrestore' ? {AI_AGENTS_GUI_FIXTURE_ENTRY: 'host-plan-restore.cjs', AI_AGENTS_GUI_FIXTURE_EXTENSION: '1'}
    : {AI_AGENTS_GUI_FIXTURE_ENTRY: kind === 'visual' ? 'host-visual.cjs' : kind === 'plan' ? 'host-plan-flow.cjs' : 'host-interaction.cjs'})};
  const launch = await run(process.execPath, ['scripts/gui-session.mjs', 'start'], env, 180000);
  await writeFile(join(output, `launch-${attempt}.json`), JSON.stringify(launch, null, 2));
  root = launch.stdout.match(/GUI_SESSION_STARTED (.+)/)?.[1];
  if (launch.code !== 0 || !root) throw new Error(`Isolated host launch failed: ${launch.stderr || launch.stdout}`);
  await waitFile(join(root, 'profile/user-data/DevToolsActivePort'));
  const trusted = await run(process.execPath, ['scripts/gui-trust.mjs', root], {}, 40000);
  await writeFile(join(output, `trust-${attempt}.json`), JSON.stringify(trusted, null, 2));
  if (trusted.code !== 0) throw new Error(`Disposable workspace trust failed: ${trusted.stderr || trusted.stdout}`);
  await waitFile(join(root, kind === 'viewmodel' ? 'viewmodel-ready' : kind === 'review' ? 'review-ready' : kind === 'plan' ? 'plan-flow-ready' : kind === 'planrestore' ? 'plan-restore-ready' : kind === 'subagent' ? 'subagent-restore-ready' : 'interaction-ready'));
  hostKind = kind;
}
async function stopHost() {
  if (!root) return;
  const stoppedRoot = root;
  const stop = await run(process.execPath, ['scripts/gui-session.mjs', 'stop', stoppedRoot]);
  await writeFile(join(output, `stop-${stoppedRoot.split('/').pop()}.json`), JSON.stringify(stop, null, 2));
  if (stop.code !== 0) throw new Error(`Host stop failed: ${stop.stderr}`);
  const receipt = JSON.parse(await readFile(join(stoppedRoot, 'session.json'), 'utf8'));
  // Electron and the extension host can take longer to complete their normal
  // shutdown under load. Never substitute a signal for a graceful quit.
  const end = Date.now() + 120000;
  let running = true;
  while (Date.now() < end) {
    try { process.kill(-receipt.processId, 0); } catch (error) { if (error.code === 'ESRCH') { running = false; break; } if (error.code !== 'EPERM') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (running) throw new Error(`Isolated host process group ${receipt.processId} did not exit after Quit; session retained`);
  // Keep the receipt, profile, workspace and evidence; the disposable app copy
  // is large and is no longer needed after its process group has exited.
  const cache = join(stoppedRoot, 'vscode-cache');
  if (receipt.paths?.cache === cache && receipt.paths?.appBundle?.startsWith(`${cache}/`)) await rm(cache, {recursive: true, force: true});
  root = undefined;
  hostKind = undefined;
}
async function mockThinking(id) {
  await capture(id, 'mock-start', '--send-thinking');
  if (id === 'T01') return;
  await capture(id, 'mock-close', '--close-thinking');
  await capture(id, 'mock-update', '--update-thinking');
  if (id === 'T02') return;
  await capture(id, 'mock-complete', '--complete-thinking');
  if (id === 'T03') return;
  await capture(id, 'mock-tool', '--start-tool');
  if (id === 'T04') return;
  await capture(id, 'mock-ready', '--release-thinking');
}
async function permission(scenario = 'T15') {
  await capture(scenario, 'unsupported', '--approval-unsupported');
  for (const [id, decision] of [['approval-1', 'allow-once'], ['approval-2', 'deny'], ['approval-3', 'allow-session']]) {
    await capture(scenario, `${decision}-request`, `--permission-request=${id}`);
    await capture(scenario, decision, `--permission-decision=${decision}`);
  }
  await writeFile(join(root, 'interaction-request.json'), JSON.stringify({id:'session-b', action:'switch'}));
  const deadline = Date.now() + 15000;
  let switched = false;
  while (Date.now() < deadline) {
    try { switched = JSON.parse(await readFile(join(root, 'interaction-switch.json'), 'utf8')).id === 'session-b'; if (switched) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!switched) throw new Error('Timeout switching permission session');
  await capture(scenario, 'session-b-request', '--permission-request=approval-b');
  await capture(scenario, 'session-b-deny', '--permission-decision=deny');
  const flowId = crypto.randomUUID();
  await writeFile(join(root, 'interaction-request.json'), JSON.stringify({id:flowId, action:'approval-flow-setup'}));
  const flowDeadline = Date.now() + 15000;
  let flowReady = false;
  while (Date.now() < flowDeadline) {
    try { flowReady = JSON.parse(await readFile(join(root, 'interaction-switch.json'), 'utf8')).id === flowId; if (flowReady) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!flowReady) throw new Error('Timeout preparing permission backend');
  for (const [kind, decision] of [['deny', 'deny'], ['allow', 'allow-once']]) {
    await capture(scenario, `backend-${kind}-waiting`, `--approval-flow-start=${kind}`);
    await capture(scenario, `backend-${kind}-decision`, `--permission-decision=${decision}`);
    await capture(scenario, `backend-${kind}-finished`, `--approval-flow-finish=${kind}`);
  }
}
async function fixture(id) {
  // Each case establishes its own starting state. These prove rendering only.
  if (id === 'T01') return capture(id, 'start', '--scenario=T01');
  if (id === 'T02') {
    await capture(id, 'start', '--scenario=T06', '--ensure-open', '--expect-open');
    await capture(id, 'close', '--close-thinking');
    return capture(id, 'update', '--scenario=T02');
  }
  if (id === 'T03' || id === 'T04' || id === 'T05') {
    await capture(id, 'start', '--scenario=T06', '--ensure-open', '--expect-open');
    await capture(id, 'close', '--close-thinking');
    return capture(id, 'state', `--scenario=${id}`);
  }
  if (id === 'T06') {
    await capture(id, 'session-a', '--scenario=T06', '--ensure-open', '--expect-open');
    await capture(id, 'session-b', '--scenario=T06', '--session-b', '--ensure-open', '--expect-open');
    await capture(id, 'close-b', '--close-thinking');
    await capture(id, 'return-a', '--scenario=T06', '--expect-open');
    return capture(id, 'return-b', '--scenario=T06', '--session-b', '--expect-closed');
  }
}
try {
  const build = await run('npm', ['run', 'build']);
  await writeFile(join(output, 'build.json'), JSON.stringify(build, null, 2));
  if (build.code !== 0) throw new Error(`Production build failed: ${build.stderr}`);
  if (ids.some(id => Number(id.slice(1)) <= 6)) {
    await startHost('viewmodel');
  }
  for (const id of ids) {
    if (id === 'T20') {
      try {
        await stopHost(); await startHost('interaction'); await mockThinking(id);
        await stopHost(); await startHost('restore');
        const history = await run(process.execPath, ['scripts/gui-restore-acceptance.mjs', root, join(output, id, 'history'), '--keep-after-restore'], {}, 120000);
        if (history.code !== 0) throw new Error(`History ${history.kind}: ${history.stderr || history.stdout}`);
        await stopHost(); await startHost('review');
        const review = await run(process.execPath, ['scripts/gui-review.mjs', root, join(output, id, 'review')], {}, 90000);
        if (review.code !== 0) throw new Error(`Review ${review.kind}: ${review.stderr || review.stdout}`);
        await stopHost(); await startHost('plan');
        const plan = await run(process.execPath, ['scripts/gui-plan-flow.mjs', root, join(output, id, 'plan')], {}, 90000);
        if (plan.code !== 0) throw new Error(`Plan ${plan.kind}: ${plan.stderr || plan.stdout}`);
        await stopHost(); await startHost('visual'); await permission(id);
        results.push({id, status:'PASS', layer:2, reason:'Thinking, history/reload, file review, Plan and permission exercised in isolated Hosts', evidence:join(output,id)});
      } catch (error) { results.push({id,status:'FAIL',layer:2,reason:String(error),evidence:join(output,id)}); }
      continue;
    }
    if (['T07', 'T08', 'T17', 'T18'].includes(id)) {
      try {
        await stopHost();
        await startHost('restore');
        const restored = await run(process.execPath, ['scripts/gui-restore-acceptance.mjs', root, join(output, id)], {}, 120000);
        await writeFile(join(output, `${id}-restore-runner.json`), JSON.stringify(restored, null, 2));
        if (restored.code !== 0) throw new Error(`${restored.kind}: ${restored.stderr || restored.stdout}`);
        if (id === 'T17' || id === 'T18') {
          await stopHost();
          await startHost('restore');
          const abnormal = await run(process.execPath, ['scripts/gui-restore-abnormal.mjs', root, join(output, id, 'abnormal')], {}, 120000);
          await writeFile(join(output, `${id}-abnormal-runner.json`), JSON.stringify(abnormal, null, 2));
          if (abnormal.code !== 0) throw new Error(`${abnormal.kind}: ${abnormal.stderr || abnormal.stdout}`);
        }
        results.push({id, status: 'PASS', layer: 2, reason: 'History selection and Reload verified through GUI and mock CLI', evidence: join(output, id)});
      } catch (error) { results.push({id, status: 'FAIL', layer: 2, reason: String(error), evidence: join(output, id)}); }
      continue;
    }
    if (id === 'T16') {
      try {
        await stopHost();
        await startHost('interaction');
        for (const stage of ['start', 'alpha:running', 'beta:running', 'wait:running', 'alpha:completed', 'beta:error', 'gamma:running', 'gamma:cancelled', 'wait:completed', 'finish:completed']) {
          await capture(id, stage.replace(':', '-'), `--subagent=${stage}`);
        }
        await stopHost();
        await startHost('subagent');
        const restored = await run(process.execPath, ['scripts/gui-subagent-restore.mjs', root, join(output, id, 'restore')], {}, 120000);
        await writeFile(join(output, `${id}-restore-runner.json`), JSON.stringify(restored, null, 2));
        if (restored.code !== 0) throw new Error(`${restored.kind}: ${restored.stderr || restored.stdout}`);
        results.push({id, status: 'PASS', layer: 2, reason: 'Parent, child transitions, detail, isolation and reload verified through controller and GUI', evidence: join(output, id)});
      } catch (error) { results.push({id, status: 'FAIL', layer: 2, reason: String(error), evidence: join(output, id)}); }
      continue;
    }
    if (id === 'T13' || id === 'T14') {
      try {
        await stopHost();
        await startHost('interaction');
        await capture(id, 'ready', '--plan-ready');
        await capture(id, 'view', '--plan-view');
        if (id === 'T14') await capture(id, 'build', '--plan-build');
        await stopHost();
        await startHost('plan');
        const flow = await run(process.execPath, ['scripts/gui-plan-flow.mjs', root, join(output, id, 'flow')], {}, 90000);
        await writeFile(join(output, `${id}-flow-runner.json`), JSON.stringify(flow, null, 2));
        // Keep the reload assertion independent of the width-dependent flow.
        // Both results remain mandatory for the scenario to pass.
        await stopHost();
        await startHost('planrestore');
        const restored = await run(process.execPath, ['scripts/gui-plan-restore.mjs', root, join(output, id, 'restore')], {}, 120000);
        await writeFile(join(output, `${id}-restore-runner.json`), JSON.stringify(restored, null, 2));
        if (flow.code !== 0) throw new Error(`Plan flow ${flow.kind}: ${flow.stderr || flow.stdout}; restore ${restored.code === 0 ? 'PASS' : `${restored.kind}: ${restored.stderr || restored.stdout}`}`);
        if (restored.code !== 0) throw new Error(`${restored.kind}: ${restored.stderr || restored.stdout}`);
        results.push({id, status: 'PASS', layer: 2, reason: 'Plan input, revision, Build, Stop, failure, model and reload verified', evidence: join(output, id)});
      } catch (error) { results.push({id, status: 'FAIL', layer: 2, reason: String(error), evidence: join(output, id)}); }
      continue;
    }
    if (['T09', 'T10', 'T11', 'T12'].includes(id)) {
      try {
        await stopHost();
        await startHost('review');
        const review = await run(process.execPath, ['scripts/gui-review.mjs', root, join(output, id)], {}, 90000);
        await writeFile(join(output, `${id}-review-runner.json`), JSON.stringify(review, null, 2));
        if (review.code !== 0) throw new Error(`${review.kind}: ${review.stderr || review.stdout}`);
        if (id === 'T10') {
          await stopHost();
          await startHost('review');
          const keep = await run(process.execPath, ['scripts/gui-review.mjs', root, join(output, id, 'keep-before-reload'), '--keep-only'], {}, 90000);
          if (keep.code !== 0) throw new Error(`Keep setup ${keep.kind}: ${keep.stderr || keep.stdout}`);
          const reload = await run(process.execPath, ['scripts/gui-review-reload.mjs', root, join(output, id, 'reload')], {}, 90000);
          await writeFile(join(output, `${id}-reload-runner.json`), JSON.stringify(reload, null, 2));
          if (reload.code !== 0) throw new Error(`Keep reload ${reload.kind}: ${reload.stderr || reload.stdout}`);
        }
        results.push({id, status: 'PASS', layer: 2, reason: 'Real files, GUI, controller state and applicable safety checks verified', evidence: join(output, id)});
      } catch (error) { results.push({id, status: 'FAIL', layer: 2, reason: String(error), evidence: join(output, id)}); }
      continue;
    }
    if (id === 'T19') {
      try {
        await stopHost();
        await startHost('viewmodel');
        const requestId = crypto.randomUUID();
        await writeFile(join(root, 'viewmodel-scenario.json'), JSON.stringify({id: requestId, scenario: 'layout'}));
        const deadline = Date.now() + 15000;
        let response;
        while (Date.now() < deadline) {
          try { response = JSON.parse(await readFile(join(root, 'viewmodel-result.json'), 'utf8')); if (response.id === requestId) break; } catch {}
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (response?.id !== requestId) throw new Error('Layout preparation timed out');
        const layout = await run(process.execPath, ['scripts/gui-layout-matrix.mjs', root, join(output, id)], {}, 180000);
        await writeFile(join(output, 'layout-runner.json'), JSON.stringify(layout, null, 2));
        if (layout.code !== 0) throw new Error(`${layout.kind}: ${layout.stderr || layout.stdout}`);
        await stopHost();
        await startHost('visual');
        const components = await run(process.execPath, ['scripts/gui-interaction-widths.mjs', root, join(output, id, 'components')], {}, 90000);
        await writeFile(join(output, 'components-runner.json'), JSON.stringify(components, null, 2));
        if (components.code !== 0) throw new Error(`${components.kind}: ${components.stderr || components.stdout}`);
        await stopHost();
        await startHost('review');
        const reviewWidths = await run(process.execPath, ['scripts/gui-review-width.mjs', root, join(output, id, 'review')], {}, 90000);
        await writeFile(join(output, 'review-width-runner.json'), JSON.stringify(reviewWidths, null, 2));
        if (reviewWidths.code !== 0) throw new Error(`${reviewWidths.kind}: ${reviewWidths.stderr || reviewWidths.stdout}`);
        results.push({id, status: 'PASS', layer: 1, reason: '12 actual-width/theme measurements and 390/1000 component layouts verified', evidence: join(output, id)});
      } catch (error) { results.push({id, status: 'FAIL', layer: 1, reason: String(error), evidence: join(output, id)}); }
      continue;
    }
    if (id === 'T15') {
      try {
        await stopHost();
        await startHost('visual');
        await permission();
        results.push({id, status: 'PASS', layer: 2, reason: 'Permission decisions, duplicate prevention and session isolation verified through GUI and controller', evidence: join(output, id)});
      } catch (error) { results.push({id, status: 'FAIL', layer: 2, fixture: 'FAIL', reason: String(error), evidence: join(output, id)}); }
      continue;
    }
    if (Number(id.slice(1)) > 6) {
      results.push({id, status: 'NOT STARTED', layer: null, reason: 'Required host operations and assertions are not implemented'});
      continue;
    }
    try {
      if (hostKind !== 'viewmodel') { await stopHost(); await startHost('viewmodel'); }
      await fixture(id);
      if (id !== 'T06') {
        await stopHost(); await startHost('interaction'); await mockThinking(id);
      }
      results.push({id, status: 'PASS', layer: id === 'T06' ? 1 : 2, reason: id === 'T06' ? 'Separate conversation state verified in isolated Host' : 'Production Webview and mock CLI lifecycle verified', evidence: join(output, id)});
    } catch (error) {
      results.push({id, status: 'FAIL', layer: 1, fixture: 'FAIL', reason: String(error), evidence: join(output, id)});
    }
  }
} catch (error) {
  for (const id of ids.filter(id => !results.some(r => r.id === id))) results.push({id, status: 'BLOCKED', reason: String(error)});
} finally {
  try { await stopHost(); } catch (error) { results.push({id: 'HOST_CLEANUP', status: 'FAIL', reason: String(error)}); }
  await writeFile(join(output, 'results.json'), JSON.stringify({createdAt: new Date().toISOString(), output, sessionRoot: root ?? null, results}, null, 2));
}
console.log(JSON.stringify({output, results}, null, 2));
if (results.some(r => r.status !== 'PASS')) process.exitCode = 1;
