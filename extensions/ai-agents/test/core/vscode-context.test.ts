import { createGitFixture } from '../support/git-fixture.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  activeFileToken, gitSummary, instructionSummary, problemsText, recentTerminalText, searchWorkspace, selectionBlock, watchTerminals, workspaceCommands,
} from '../../src/vscode-context.js';
import { DiagnosticSeverity, languages, RelativePattern, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';


function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ai-agents-context-'));
}

test('terminal watchers record shell commands and ignore an editor that has no shell integration', () => {
  resetVscode();
  assert.match(recentTerminalText(), /\(none yet\)/);
  const subscriptions: { dispose(): void }[] = [];
  window.onDidEndTerminalShellExecution = undefined;
  watchTerminals(subscriptions);
  assert.equal(subscriptions.length, 0);
  resetVscode();
  watchTerminals(subscriptions);
  assert.equal(subscriptions.length, 1);
  const fire = window.shellListeners[0];
  assert.ok(fire);
  fire({ exitCode: undefined, execution: { commandLine: '' } });
  fire({ exitCode: 0, execution: { commandLine: { value: '' } } });
  fire({ exitCode: 0, execution: { commandLine: { value: 'echo hi' } } });
  assert.match(recentTerminalText(), /echo hi \(exit 0\)/);
  fire({ exitCode: undefined, execution: { commandLine: 'whoami' } });
  assert.match(recentTerminalText(), /whoami \(exit unknown\)/);
  for (let index = 0; index < 21; index += 1) fire({ exitCode: index, execution: { commandLine: `cmd-${index}` } });
  const text = recentTerminalText();
  assert.match(text, /cmd-20 \(exit 20\)/);
  assert.doesNotMatch(text, /echo hi/);
  assert.doesNotMatch(text, /cmd-0 \(exit 0\)/);
  assert.ok(text.trim().split('\n').length <= 11);
});

test('searchWorkspace ranks workspace files and skips ignored directories', async () => {
  resetVscode();
  const cwd = tempDir();
  try {
    mkdirSync(path.join(cwd, 'src'));
    mkdirSync(path.join(cwd, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(path.join(cwd, '.git'));
    writeFileSync(path.join(cwd, 'src', 'app.ts'), 'export {}');
    writeFileSync(path.join(cwd, 'src', 'apple.ts'), 'export {}');
    writeFileSync(path.join(cwd, 'needle'), 'exact');
    writeFileSync(path.join(cwd, 'notes.txt'), 'note');
    workspace.findFilesResult = [
      Uri.file(path.join(cwd, 'src', 'app.ts')),
      Uri.file(path.join(cwd, 'src', 'apple.ts')),
      Uri.file(path.join(tmpdir(), 'outside.ts')),
      Uri.parse('untitled:scratch'),
    ];
    const ranked = await searchWorkspace(cwd, 'a*[pp');
    const call = workspace.findFilesCalls[0];
    assert.ok(call?.include instanceof RelativePattern);
    assert.equal(call.include.pattern, '**/*app*');
    assert.equal(call.max, 80);
    assert.match(String(call.exclude), /node_modules/);
    assert.deepEqual(ranked.map((item) => item.token), ['src/app.ts', 'src/apple.ts', 'src']);
    workspace.findFilesResult = [Uri.file(path.join(cwd, 'needle'))];
    assert.equal((await searchWorkspace(cwd, 'needle'))[0]?.token, 'needle');
    workspace.findFilesResult = [Uri.file(path.join(cwd, 'src', 'app.ts'))];
    const broad = await searchWorkspace(cwd, '');
    assert.equal(workspace.findFilesCalls.at(-1)?.max, 30);
    const tokens = broad.map((item) => item.token);
    assert.ok(tokens.includes('notes.txt'));
    assert.ok(tokens.includes('src/app.ts'));
    assert.equal(tokens.some((token) => token.includes('node_modules') || token.includes('.git')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace commands discover markdown commands and skills, then cache them', async () => {
  resetVscode();
  const cwd = tempDir();
  try {
    const commands = path.join(cwd, '.cursor', 'commands');
    mkdirSync(commands, { recursive: true });
    writeFileSync(path.join(commands, 'deploy.md'), '---\nname: AiAgentsUnitDeploy\ndescription: ship it\n---\nDo the deploy\n');
    writeFileSync(path.join(commands, 'clear.md'), '---\nname: clear\ndescription: not the builtin\n---\nnope\n');
    writeFileSync(path.join(commands, 'notes.txt'), 'ignore');
    writeFileSync(path.join(commands, 'bare.md'), 'No frontmatter.');
    mkdirSync(path.join(cwd, '.cursor', 'skills', 'reviewer'), { recursive: true });
    writeFileSync(path.join(cwd, '.cursor', 'skills', 'reviewer', 'SKILL.md'), '---\nname: AiAgentsUnitReviewer\ndescription: reviews\n---\nLook carefully\n');
    writeFileSync(path.join(cwd, '.cursor', 'skills', 'not-a-skill.txt'), 'skip');
    mkdirSync(path.join(cwd, '.cursor', 'skills-cursor', 'empty'), { recursive: true });
    writeFileSync(path.join(cwd, '.cursor', 'skills-cursor', 'empty', 'SKILL.md'), '');
    mkdirSync(path.join(cwd, '.codex', 'skills', 'ship'), { recursive: true });
    writeFileSync(path.join(cwd, '.codex', 'skills', 'ship', 'SKILL.md'), '# Ship\n');
    const first = await workspaceCommands(cwd);
    const deploy = first.find((command) => command.name === 'AiAgentsUnitDeploy');
    assert.equal(deploy?.description, 'ship it');
    assert.equal(deploy?.kind, 'command');
    assert.match(deploy?.body ?? '', /Do the deploy/);
    assert.equal(first.filter((command) => command.name === 'clear').length, 1);
    assert.equal(first.find((command) => command.name === 'clear')?.description, 'Start a new chat');
    assert.equal(first.find((command) => command.name === 'AiAgentsUnitReviewer')?.kind, 'skill');
    assert.equal(first.find((command) => command.name === 'ship')?.kind, 'skill');
    assert.deepEqual(first.find((command) => command.name === 'bare'), {
      name: 'bare', title: 'bare', description: 'workspace', kind: 'command', body: 'No frontmatter.',
    });
    writeFileSync(path.join(commands, 'deploy.md'), '---\nname: AiAgentsUnitDeploy\ndescription: changed\n---\n');
    const cached = await workspaceCommands(cwd);
    assert.equal(cached.find((command) => command.name === 'AiAgentsUnitDeploy')?.description, 'ship it');
    const other = tempDir();
    try {
      const elsewhere = await workspaceCommands(other);
      assert.equal(elsewhere.some((command) => command.name === 'AiAgentsUnitDeploy'), false);
      assert.ok(elsewhere.some((command) => command.name === 'diagnostics'));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('git summary reports status inside a repository and an empty result outside one', async () => {
  const repo = tempDir();
  const plain = tempDir();
  try {
    createGitFixture(repo);
    writeFileSync(path.join(repo, 'tracked.txt'), 'hello');
    const summary = await gitSummary(repo);
    assert.match(summary, /tracked\.txt/);
    assert.match(summary, /git status:/);
    assert.doesNotMatch(summary.split('git diff --stat:')[0] ?? '', /\(clean\)/);
    const empty = await gitSummary(plain);
    assert.match(empty, /\(clean\)/);
    assert.match(empty, /\(none\)/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test('problems, the active editor, and the selection stay inside the workspace', () => {
  resetVscode();
  const cwd = tempDir();
  try {
    const inside = Uri.file(path.join(cwd, 'a.ts'));
    const diagnostic = (message: string, severity: number, line = 0) => ({
      severity, message, range: { start: { line, character: 0 }, end: { line, character: 1 } },
    });
    languages.entries = [
      [Uri.parse('untitled:scratch'), [diagnostic('untitled', DiagnosticSeverity.Error)]],
      [Uri.file(path.join(tmpdir(), 'outside.ts')), [diagnostic('outside', DiagnosticSeverity.Error)]],
      [inside, [
        diagnostic('info', DiagnosticSeverity.Information),
        diagnostic('warn', DiagnosticSeverity.Warning, 1),
        ...Array.from({ length: 51 }, (_, index) => diagnostic(`problem-${index}`, DiagnosticSeverity.Error, index + 2)),
      ]],
    ];
    const text = problemsText(cwd);
    assert.match(text, /a\.ts:2: warning: warn/);
    assert.match(text, /problem-0/);
    assert.equal(text.split('\n').length, 50);
    assert.equal(text.includes('problem-49'), false);
    assert.equal(text.includes('info'), false);
    assert.equal(text.includes('outside'), false);
    assert.equal(text.includes('untitled'), false);
    languages.entries = [[inside, [diagnostic('single-warning', DiagnosticSeverity.Warning)]]];
    assert.equal(problemsText(cwd), 'a.ts:1: warning: single-warning');
    languages.entries = [];
    assert.equal(problemsText(cwd), 'No errors or warnings.');
    assert.equal(activeFileToken(cwd), undefined);
    assert.equal(selectionBlock(cwd), undefined);
    window.activeTextEditor = editor(Uri.parse('untitled:a.ts'), true);
    assert.equal(activeFileToken(cwd), undefined);
    assert.equal(selectionBlock(cwd), undefined);
    window.activeTextEditor = editor(Uri.file(path.join(tmpdir(), 'outside.ts')), false);
    assert.equal(activeFileToken(cwd), undefined);
    assert.equal(selectionBlock(cwd), undefined);
    window.activeTextEditor = editor(inside, true);
    assert.equal(activeFileToken(cwd), 'a.ts');
    assert.equal(selectionBlock(cwd), undefined);
    window.activeTextEditor = editor(inside, false);
    const block = selectionBlock(cwd);
    assert.match(block ?? '', /a\.ts:1-2/);
    assert.match(block ?? '', /selected text/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('instruction summary lists rules, skills, and MCP servers from the workspace', async () => {
  const cwd = tempDir();
  try {
    writeFileSync(path.join(cwd, 'AGENTS.md'), '# agents');
    writeFileSync(path.join(cwd, 'CLAUDE.md'), '# claude');
    mkdirSync(path.join(cwd, '.cursorrules'));
    mkdirSync(path.join(cwd, '.cursor', 'rules'), { recursive: true });
    writeFileSync(path.join(cwd, '.cursor', 'rules', 'a.md'), 'a');
    writeFileSync(path.join(cwd, '.cursor', 'mcp.json'), '{');
    mkdirSync(path.join(cwd, '.cursor', 'skills', 'reviewer'), { recursive: true });
    writeFileSync(path.join(cwd, '.cursor', 'skills', 'reviewer', 'SKILL.md'), '---\nname: AiAgentsUnitReviewer\ndescription: reviews\n---\nbody\n');
    const broken = await instructionSummary(cwd);
    assert.match(broken, /AGENTS\.md/);
    assert.match(broken, /CLAUDE\.md/);
    assert.match(broken, /\.cursorrules/);
    assert.match(broken, /\.cursor\/rules: a\.md/);
    assert.match(broken, /Skills: AiAgentsUnitReviewer/);
    assert.equal(broken.includes('ai-agents-unit-demo'), false);
    writeFileSync(path.join(cwd, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'ai-agents-unit-demo': {}, local: {} } }));
    const found = await instructionSummary(cwd);
    assert.match(found, /MCP \(\.cursor\): ai-agents-unit-demo, local/);
    writeFileSync(path.join(cwd, '.cursor', 'mcp.json'), '{}');
    assert.doesNotMatch(await instructionSummary(cwd), /MCP \(\.cursor\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function editor(uri: Uri, empty: boolean) {
  return {
    document: {
      uri,
      getText: () => 'selected text',
      lineCount: 4,
      lineAt: () => ({ text: 'selected text' }),
    },
    selection: {
      isEmpty: empty,
      start: { line: 0, character: 0 },
      end: { line: empty ? 0 : 1, character: empty ? 0 : 2 },
    },
  };
}
