import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackgroundTerminalViews } from '../../src/background-terminal.js';
import type { AgentSession, TerminalRecord } from '../../src/types.js';
import { resetVscode, TerminalLocation, ThemeIcon, window, type Terminal } from '../support/vscode-stub.js';
import { waitFor } from '../support/vscode-harness.js';

function session(extra: Partial<AgentSession> = {}): AgentSession {
  return {
    subscribeBackgroundUpdates: () => () => {},
    listBackgroundTerminals: async () => [],
    ...extra,
  } as AgentSession;
}

function row(processId: string, command = 'npm test'): TerminalRecord {
  return { processId, command, output: 'hello' };
}

function asTerminal(terminal: ReturnType<BackgroundTerminalViews['open']>): Terminal {
  return terminal as unknown as Terminal;
}

function ptyOf(terminal: Terminal) {
  return (terminal.options as {
    pty: {
      onDidWrite: (listener: (text: string) => void) => { dispose(): void };
      open: () => void;
      close: () => void;
      handleInput: (data: string) => void;
    };
    location: number;
    isTransient: boolean;
    iconPath: ThemeIcon;
  }).pty;
}

test('opening the same process reuses the terminal until close drops it', async () => {
  resetVscode();
  const views = new BackgroundTerminalViews();
  const owner = session({
    listBackgroundTerminals: async () => [{ processId: 'p1', command: 'x'.repeat(200), output: 'hello', status: 'running' }],
  });
  const first = asTerminal(views.open(owner, row('p1', 'x'.repeat(200)), true));
  const options = first.options as { location: number; isTransient: boolean; iconPath: ThemeIcon; name: string };
  assert.equal(options.location, TerminalLocation.Panel);
  assert.equal(options.isTransient, true);
  assert.ok(options.iconPath instanceof ThemeIcon);
  assert.ok(first.name.startsWith('AI Agents:'));
  assert.ok(first.name.length <= 100);
  assert.equal(first.shown, 1);
  const again = asTerminal(views.open(owner, row('p1'), false));
  assert.equal(again, first);
  assert.equal(window.terminals.length, 1);
  assert.equal(first.shown, 2);
  const chunks: string[] = [];
  ptyOf(first).onDidWrite((text) => chunks.push(text));
  ptyOf(first).open();
  await waitFor(() => chunks.join('').includes('hello'), 'terminal output');
  assert.doesNotMatch(chunks.join(''), /接続しました|x{10}/);
  ptyOf(first).handleInput('\x03');
  await waitFor(() => chunks.join('').includes('割り込みに対応していません'), 'interrupt error');
  ptyOf(first).close();
  ptyOf(first).handleInput('\x03');
  window.fireCloseTerminal(window.createTerminal('unrelated'));
  assert.equal(views.open(owner, row('p1'), false), first);
  window.fireCloseTerminal(first);
  const reopened = asTerminal(views.open(owner, row('p1'), false));
  assert.notEqual(reopened, first);
  const other = asTerminal(views.open(session(), row('p1'), false));
  assert.notEqual(other, reopened);
  views.dispose();
  views.dispose();
  assert.equal(reopened.disposed, 1);
  assert.equal(other.disposed, 1);
  assert.equal(first.disposed, 0);
});

test('dispose closes every open terminal once', () => {
  resetVscode();
  const views = new BackgroundTerminalViews();
  const owner = session();
  const first = asTerminal(views.open(owner, row('p1'), false));
  const second = asTerminal(views.open(owner, row('p2', ''), false));
  assert.match(second.name, /p2/);
  views.dispose();
  views.dispose();
  assert.equal(first.disposed, 1);
  assert.equal(second.disposed, 1);
});
