// Loaded only as an Extension Development Host test entry point, never by the VSIX.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');

exports.run = async function run() {
  const root = await fs.realpath(process.env.AI_AGENTS_GUI_FIXTURE_ROOT || '');
  if (!root.startsWith('/private/tmp/ai-agents-gui-acceptance-')) throw new Error('Fixture requires a disposable GUI session');
  const receipt = JSON.parse(await fs.readFile(path.join(root, 'session.json'), 'utf8'));
  const cwd = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  if (receipt.sessionRoot !== root || cwd !== receipt.paths.workspace) throw new Error('Fixture workspace mismatch');
  const extension = vscode.extensions.getExtension('y3162.ai-agents');
  const { sidebar } = await extension.activate();
  await vscode.commands.executeCommand('ai-agents.chat.focus');
  const deadline = Date.now() + 30000;
  while (!sidebar.isReady()) {
    if (Date.now() > deadline) throw new Error('Webview did not become ready');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const first = sidebar.controller;
  const firstKey = sidebar.registry.frontKey;
  const second = sidebar.makeController(first.snapshot().selection);
  sidebar.registry.add({ key: 'fixture-b', controller: second, mode: 'agent' });
  const controllers = { a: first, b: second };
  const keys = { a: firstKey, b: 'fixture-b' };
  const snapshots = { a: first.snapshot(), b: second.snapshot() };
  for (const session of ['a', 'b']) controllers[session].snapshot = () => structuredClone(snapshots[session]);
  await sidebar.openPanel('chat');
  const request = path.join(root, 'viewmodel-scenario.json');
  const response = path.join(root, 'viewmodel-result.json');
  let previous = '';
  await fs.writeFile(path.join(root, 'viewmodel-ready'), 'ready');
  const end = Date.now() + 1200000;
  while (Date.now() < end) {
    let raw = '';
    try { raw = await fs.readFile(request, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (raw && raw !== previous) {
      previous = raw;
      const { id, scenario, session = 'a' } = JSON.parse(raw);
      if (scenario === 'stop') return;
      if (!['T01', 'T02', 'T03', 'T04', 'T05', 'T06'].includes(scenario) || !['a', 'b'].includes(session)) throw new Error('Unknown fixture scenario');
      sidebar.registry.focus(keys[session]);
      const done = scenario === 'T05';
      const completed = ['T03', 'T04', 'T05'].includes(scenario);
      const now = Date.now();
      const current = snapshots[session] = { ...snapshots[session], busy: !done, status: done ? 'idle' : 'running', messages: [
        { id: 'fixture-user', role: 'user', text: 'Fixture scenario', at: now - 1000 },
        { id: 'fixture-thinking', role: 'assistant', text: scenario === 'T02' ? 'Fixture thinking updated' : 'Fixture thinking', turnId: 'fixture-user', at: now - 900, meta: { type: 'thinking', ...(completed ? { thinkingCompleted: true } : {}) } },
        ...(scenario === 'T04' ? [{ id: 'fixture-tool', role: 'tool', text: 'running: fixture tool', turnId: 'fixture-user', tool: { kind: 'shell', name: 'fixture tool', status: 'running' } }] : []),
        ...(done ? [{ id: 'fixture-answer', role: 'assistant', text: 'Fixture turn complete', turnId: 'fixture-user', final: true }] : []),
      ], turns: [{ id: 'fixture-user', startedAt: now - 1000, status: done ? 'completed' : 'running', waitMs: 0, mode: 'agent', model: '', intent: 'chat', ...(done ? { endedAt: now } : {}) }] };
      sidebar.flushNow();
      await fs.writeFile(response, JSON.stringify({ id, scenario, conversation: sidebar.registry.frontKey, busy: current.busy, at: new Date().toISOString() }));
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Fixture timed out');
};
