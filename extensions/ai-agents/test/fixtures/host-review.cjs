// Extension Development Host only. The workspace and its contents are disposable.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

exports.run = async function run() {
  const root = await fs.realpath(process.env.AI_AGENTS_GUI_FIXTURE_ROOT || '');
  if (!root.startsWith('/private/tmp/ai-agents-gui-acceptance-')) throw new Error('Disposable host required');
  const receipt = JSON.parse(await fs.readFile(path.join(root, 'session.json'), 'utf8'));
  const cwd = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  if (receipt.sessionRoot !== root || cwd !== receipt.paths.workspace) throw new Error('Fixture workspace mismatch');
  const { sidebar } = await vscode.extensions.getExtension('y3162.ai-agents').activate();
  await vscode.commands.executeCommand('ai-agents.chat.focus');
  const end = Date.now() + 30000;
  while (!sidebar.isReady()) {
    if (Date.now() > end) throw new Error('Webview did not become ready');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await sidebar.openPanel('chat');
  const files = [path.join(cwd, 'review-first.txt'), path.join(cwd, 'review-second.txt')];
  const digest = text => createHash('sha256').update(text).digest('hex');
  const request = path.join(root, 'review-request.json');
  const response = path.join(root, 'review-result.json');
  await fs.writeFile(path.join(root, 'review-ready'), 'ready');
  let previous = '';
  while (true) {
    let raw = '';
    try { raw = await fs.readFile(request, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (raw && raw !== previous) {
      previous = raw;
      const { id, action } = JSON.parse(raw);
      if (action === 'stop') return;
      if (action === 'theme') {
        const { theme } = JSON.parse(raw);
        if (!['Dark Modern', 'Light Modern', 'Default High Contrast'].includes(theme)) throw Error('Unexpected theme');
        await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Workspace);
        await fs.writeFile(response, JSON.stringify({ id, theme }));
        continue;
      }
      if (['setup', 'dirty', 'symlink', 'rename', 'outside', 'missing-baseline', 'partial'].includes(action)) {
        const lockedDir = path.join(cwd, 'review-locked');
        await fs.chmod(lockedDir, 0o755).catch(error => { if (error.code !== 'ENOENT') throw error; });
        files[1] = path.join(cwd, 'review-second.txt');
        if (action === 'partial') {
          await fs.mkdir(lockedDir, { recursive: true });
          files[1] = path.join(lockedDir, 'review-second.txt');
        }
        for (const file of files) {
          const info = await fs.lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
          if (info?.isSymbolicLink()) await fs.rm(file);
        }
        await Promise.all(files.map((file, i) => fs.writeFile(file, `after ${i}\n`)));
        if (action === 'partial') await fs.chmod(lockedDir, 0o555);
        if (action === 'dirty') {
          const document = await vscode.workspace.openTextDocument(files[0]);
          const editor = await vscode.window.showTextDocument(document);
          await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'unsaved '));
        }
        if (action === 'symlink') {
          await fs.rm(files[0]);
          await fs.symlink(files[1], files[0]);
        }
        const state = sidebar.controller.snapshot();
        state.messages = [{ id: 'review-user', role: 'user', text: 'Review fixture', at: Date.now() }];
        state.changes = files.map((file, i) => ({ path: file, kind: 'update', previousText: `before ${i}\n`, observedDigest: digest(`after ${i}\n`) }));
        if (action === 'symlink') state.changes = [state.changes[0]];
        if (action === 'rename') state.changes[0] = { ...state.changes[0], kind: 'rename', oldPath: 'old.txt' };
        if (action === 'outside') state.changes[0].path = path.join(root, 'outside.txt');
        if (action === 'missing-baseline') delete state.changes[0].previousText;
        state.reviewAcceptance = undefined;
        sidebar.controller.restoreSnapshot(state);
      } else if (action === 'new-change') {
        const file = path.join(cwd, 'review-third.txt');
        await fs.writeFile(file, 'after third\n');
        const state = sidebar.controller.snapshot();
        state.changes.push({ path: file, kind: 'update', previousText: 'before third\n', observedDigest: digest('after third\n') });
        sidebar.controller.restoreSnapshot(state);
      } else if (action === 'flush' || action === 'reload') {
        await sidebar.flushHistory();
      } else if (action !== 'state') throw new Error('Unknown review fixture request');
      const state = sidebar.controller.snapshot();
      const contents = await Promise.all(files.map(file => fs.readFile(file, 'utf8')));
      await fs.writeFile(response, JSON.stringify({ id, changes: state.changes, acceptance: state.reviewAcceptance, contents }));
      if (action === 'reload') {
        await fs.rm(request, { force: true });
        await fs.rm(path.join(root, 'review-ready'), { force: true });
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
        return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
