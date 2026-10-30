// Isolated development-host only: exercise actual controller permission promises
// and sidebar message handling without claiming CLI interactive approval support.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
exports.run = async () => {
  const root = await fs.realpath(process.env.AI_AGENTS_GUI_FIXTURE_ROOT || '');
  if (!root.startsWith('/private/tmp/ai-agents-gui-acceptance-')) throw Error('Disposable session required');
  const receipt = JSON.parse(await fs.readFile(path.join(root, 'session.json'), 'utf8'));
  if (await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath) !== receipt.paths.workspace) throw Error('Workspace mismatch');
  const { sidebar } = await vscode.extensions.getExtension('y3162.ai-agents').activate();
  await vscode.commands.executeCommand('ai-agents.chat.focus');
  const deadline = Date.now() + 30000;
  while (!sidebar.isReady()) {
    if (Date.now() > deadline) throw Error('Webview not ready');
    await new Promise(r => setTimeout(r, 50));
  }
  await sidebar.openPanel('chat');
  await fs.writeFile(path.join(root, 'interaction-ready'), 'ready');
  let previous = '';
  const firstKey = sidebar.registry.frontKey;
  const second = sidebar.makeController(sidebar.controller.snapshot().selection);
  sidebar.registry.add({key: 'interaction-b', controller: second, mode: 'agent'});
  let childEmit;
  let finishChildren;
  while (Date.now() < deadline + 1200000) {
    let raw = '';
    try { raw = await fs.readFile(path.join(root, 'interaction-request.json'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (raw && raw !== previous) {
      previous = raw;
      const { id, action = 'permission', kind = 'shell', title = 'Run fixture command', detail = 'printf fixture' } = JSON.parse(raw);
      const controller = sidebar.controller;
      if (action === 'layout') {
        await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
        await fs.writeFile(path.join(root, 'interaction-switch.json'), JSON.stringify({id}));
      } else if (action === 'switch') {
        sidebar.registry.focus(id === 'session-b' ? 'interaction-b' : firstKey);
        sidebar.flushNow();
        await fs.writeFile(path.join(root, 'interaction-switch.json'), JSON.stringify({id, front: sidebar.registry.frontKey}));
      } else if (action === 'sub-start') {
        void controller.send('WAIT_FOR_STOP');
        const end = Date.now() + 15000;
        while (!controller.currentTurn && Date.now() < end) await new Promise(r => setTimeout(r, 50));
        if (!controller.currentTurn) throw Error('Parent turn did not start');
        for (const child of ['alpha', 'beta']) controller.receiveUpdate(controller.currentTurn, {id: `child-${child}`, role: 'status', text: `${child} started`, meta: {type: 'subagent', subagent: {id: child, name: child, status: 'running', background: true}}});
        await fs.writeFile(path.join(root, 'interaction-subagent.json'), JSON.stringify({id, children: controller.snapshot().subagents}));
      } else if (action === 'sub-finish') {
        controller.receiveUpdate(controller.currentTurn, {id: 'child-alpha', role: 'status', text: 'alpha completed', meta: {type: 'subagent', subagent: {id: 'alpha', name: 'alpha', status: 'completed', background: false, resultPreview: 'fixture alpha result'}}});
        await fs.writeFile(path.join(root, 'interaction-subagent.json'), JSON.stringify({id, children: controller.snapshot().subagents}));
      } else if (action === 'plan') {
        controller.restorePlan({phase: 'ready', revisions: [], current: {id: 'fixture-plan', revision: 1, name: 'Fixture Plan', markdown: '## Steps\n- Implement fixture behavior', todos: [], source: 'assistant-text', createdAt: Date.now()}});
      } else if (action === 'visual-subagents') {
        controller.factory = async () => ({sessionId: 'fixture-children', async dispose() {}, async run(_prompt, signal, emit) { childEmit = emit; await new Promise(resolve => { finishChildren = resolve; signal.addEventListener('abort', resolve, {once: true}); }); }});
        void controller.send('Fixture parent run');
        const end = Date.now() + 15000;
        while (!childEmit && Date.now() < end) await new Promise(r => setTimeout(r, 50));
        if (!childEmit) throw Error('Parent run not started');
        for (const child of ['alpha', 'beta']) childEmit({id: `fixture-${child}`, role: 'status', text: child, meta: {type: 'subagent', subagent: {id: child, name: `Fixture ${child}`, status: 'running', background: false}}});
        await fs.writeFile(path.join(root, 'interaction-switch.json'), JSON.stringify({id}));
      } else if (action === 'approval-flow-setup') {
        controller.factory = async () => ({sessionId: 'fixture-approval-backend', async dispose() {}, async run(prompt, _signal, emit) {
          const flowId = prompt.includes('deny') ? 'approval-flow-deny' : 'approval-flow-allow';
          const decision = await controller.interactions.requestPermission({id: flowId, kind: 'shell', title: 'Run fixture command', detail: 'printf fixture\nfile: fixture.txt'});
          await fs.writeFile(path.join(root, 'interaction-result.json'), JSON.stringify({id: flowId, decision, token: controller.interactionTokens().permission}));
          if (decision !== 'deny') await fs.writeFile(path.join(receipt.paths.workspace, 'approval-command-effect.txt'), 'allowed\n');
          emit({id: `${flowId}-answer`, role: 'assistant', text: decision === 'deny' ? 'Fixture command denied' : 'Fixture command executed'});
          await fs.writeFile(path.join(root, `${flowId}.json`), JSON.stringify({decision, effect: decision !== 'deny'}));
        }});
        await fs.writeFile(path.join(root, 'interaction-switch.json'), JSON.stringify({id}));
      } else if (action === 'subagent-setup') {
        controller.factory = async () => ({
          sessionId: 'fixture-children', async dispose() {},
          async run(_prompt, signal, emit) {
            childEmit = emit;
            await new Promise(resolve => { finishChildren = resolve; signal.addEventListener('abort', resolve, { once: true }); });
          },
        });
        await fs.writeFile(path.join(root, 'interaction-result.json'), JSON.stringify({id, action}));
      } else if (action === 'subagent-event') {
        if (!childEmit) throw Error('Parent run not started');
        const { child, status } = JSON.parse(raw);
        if (child === 'wait') childEmit({ id: 'fixture-wait', role: 'status', text: '', meta: { type: 'subagentWait', subagentWait: { waiting: status === 'running' } } });
        else if (child === 'finish') finishChildren();
        else if (['alpha', 'beta', 'gamma'].includes(child) && ['running', 'completed', 'error', 'cancelled'].includes(status)) {
          childEmit({ id: `fixture-${child}`, role: 'status', text: child, meta: { type: 'subagent', subagent: {
            id: child, name: `Fixture ${child}`, status, background: false,
            ...(status === 'completed' ? { resultPreview: `${child} result` } : {}), ...(status === 'error' ? { error: 'fixture failure' } : {}),
          } } });
        } else throw Error('Invalid child event');
      } else controller.requestPermission({ id, kind, title, detail }).then(async decision => {
        await fs.writeFile(path.join(root, 'interaction-result.json'), JSON.stringify({id, decision, token: controller.interactionTokens().permission, status: controller.snapshot().status}));
      });
    }
    const state = sidebar.controller.snapshot();
    await fs.writeFile(path.join(root, 'interaction-state.json'), JSON.stringify({phase: state.plan.phase, busy: state.busy, status: state.status, provider: state.selection.provider, backend: sidebar.controls[state.selection.provider].backend, children: state.subagents, waiting: state.subagentWaiting, childReady: Boolean(childEmit)}));
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error('Interaction fixture timed out');
};
