#!/usr/bin/env node
// Deterministic CLI output and model catalog; no network credentials needed.
const fs = require('node:fs');
const path = require('node:path');
const cwdIndex = process.argv.indexOf('-C');
if (cwdIndex >= 0) process.chdir(process.argv[cwdIndex + 1]);
// Persist only synthetic data in the disposable workspace so a fresh app-server
// process can answer the same public history requests as the real CLI.
const historyFile = path.join(process.cwd(), 'fixture-history.json');
const readHistory = () => fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : {};
const saveHistory = (history) => fs.writeFileSync(historyFile, JSON.stringify(history));
let recordEvent = () => {};
const emit = (event) => { recordEvent(event); process.stdout.write(`${JSON.stringify(event)}\n`); };
if (process.argv.includes('app-server')) {
  const modeFile = path.join(process.cwd(), 'model-mode.txt');
  const mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : '';
  let initialized = false;
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') emit({ id: request.id, result: { userAgent: 'fixture' } });
    if (request.method === 'initialized') initialized = true;
    const history = readHistory();
    if (request.method === 'thread/resume') {
      const id = request.params.threadId;
      if (fs.existsSync(path.join(process.cwd(), 'fixture-resume-failure')) || !history[id]) {
        emit({ id: request.id, error: { message: 'fixture history unavailable' } });
      } else emit({ id: request.id, result: { thread: { id, historyMode: 'paginated' } } });
      return;
    }
    if (request.method === 'thread/turns/list') {
      const turns = history[request.params.threadId]?.turns;
      if (!turns) emit({ id: request.id, error: { message: 'fixture thread not found' } });
      else if (fs.existsSync(path.join(process.cwd(), 'fixture-history-incomplete'))) emit({ id: request.id, result: {} });
      else emit({ id: request.id, result: { data: turns, nextCursor: null } });
      return;
    }
    if (request.method === 'thread/list') {
      emit({ id: request.id, result: { data: Object.entries(history).map(([id, thread]) => ({ id, title: thread.title, updatedAt: thread.updatedAt })) } });
      return;
    }
    if (request.method === 'thread/backgroundTerminals/list') { emit({ id: request.id, result: { data: [], nextCursor: null } }); return; }
    if (request.method !== 'model/list') return;
    if (!initialized) { emit({ id: request.id, error: { message: 'Not initialized' } }); return; }
    if (mode === 'wait') return;
    if (mode === 'exit') { process.exit(7); }
    if (mode === 'error') { emit({ id: request.id, error: { message: 'fixture model catalog unavailable' } }); return; }
    if (mode === 'malformed') { process.stdout.write('not-json\n'); return; }
    emit({ id: request.id, result: request.params.cursor ? {
      data: [
        { id: 'different-picker-id', model: 'fixture-second', displayName: 'Second Model' },
        { model: 'fixture-hidden', displayName: 'Hidden', hidden: true },
        { model: 'fixture-model', displayName: 'Fixture Model' },
      ], nextCursor: null,
    } : {
      data: [{ model: 'fixture-model', displayName: 'Fixture Model', description: 'Discovered through model/list', isDefault: true,
        defaultReasoningEffort: 'medium', supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Faster response' },
          { reasoningEffort: 'medium', description: 'Balanced response' },
          { reasoningEffort: 'high', description: 'More reasoning' },
        ],
      }], nextCursor: 'page-2',
    } });
  });
} else {
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const file = path.join(process.cwd(), 'invocations.json');
  const invocations = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  invocations.push({ args: process.argv.slice(2), prompt });
  fs.writeFileSync(file, JSON.stringify(invocations));
  const resumeIndex = process.argv.indexOf('resume');
  const history = readHistory();
  const threadId = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : `fixture-thread-${Object.keys(history).length + 1}`;
  if (resumeIndex >= 0 && !history[threadId]) { emit({ type: 'error', message: 'fixture thread not found' }); process.exitCode = 1; return; }
  const thread = history[threadId] ??= { title: prompt.trim().slice(0, 80), updatedAt: new Date().toISOString(), turns: [] };
  const turn = { id: `${threadId}-turn-${thread.turns.length + 1}`, status: 'inProgress', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: prompt }] }] };
  thread.turns.push(turn);
  saveHistory(history);
  recordEvent = (event) => {
    if (event.type.startsWith('item.') && event.item) {
      const item = event.item;
      const types = { agent_message: 'agentMessage', command_execution: 'commandExecution', file_change: 'fileChange' };
      const converted = { ...item, type: types[item.type] || item.type,
        ...(item.aggregated_output !== undefined ? { aggregatedOutput: item.aggregated_output } : {}),
        ...(item.exit_code !== undefined ? { exitCode: item.exit_code } : {}),
        ...(item.type === 'agent_message' ? { phase: 'final_answer' } : {}) };
      const index = turn.items.findIndex((entry) => entry.id === item.id);
      // Some completion notifications omit reasoning text; keep its last body.
      if (index >= 0) turn.items[index] = { ...turn.items[index], ...converted, ...(item.type === 'reasoning' && !item.text ? { text: turn.items[index].text } : {}) };
      else turn.items.push(converted);
    }
    if (event.type === 'turn.completed') turn.status = 'completed';
    if (event.type === 'turn.failed') { turn.status = 'failed'; turn.error = event.error; }
    thread.updatedAt = new Date().toISOString();
    saveHistory(history);
  };
  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'turn.started' });
  if (prompt.includes('WAIT_FOR_STOP')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes('SIMULATE_ERROR')) {
    emit({ type: 'turn.failed', error: { message: 'fixture backend error' } });
    return;
  }
  if (prompt.includes('GUI_THINKING_GATE')) {
    const trace = (stage, id = 'fixture_thinking') => fs.appendFileSync(path.join(process.cwd(), 'gui-thinking-trace.jsonl'), JSON.stringify({ at: new Date().toISOString(), stage, id, pid: process.pid, cwd: process.cwd() }) + '\n');
    trace('gate-start');
    process.once('exit', (code) => trace(`process-exit:${code}`));
    trace('item.started');
    emit({ type: 'item.started', item: { id: 'fixture_thinking', type: 'reasoning', text: 'Synthetic thinking for GUI acceptance' } });
    trace('item.updated');
    emit({ type: 'item.updated', item: { id: 'fixture_thinking', type: 'reasoning', text: 'Synthetic thinking for GUI acceptance' } });
    let updated = false;
    let completed = false;
    let toolStarted = false;
    const timer = setInterval(() => {
      if (!updated && fs.existsSync(path.join(process.cwd(), 'gui-update-thinking'))) {
        updated = true;
        trace('item.updated:additional');
        emit({ type: 'item.updated', item: { id: 'fixture_thinking', type: 'reasoning', text: 'Synthetic thinking for GUI acceptance updated' } });
      }
      if (!completed && (fs.existsSync(path.join(process.cwd(), 'gui-complete-thinking')) || fs.existsSync(path.join(process.cwd(), 'gui-release-thinking')))) {
        completed = true;
        trace('item.completed');
        emit({ type: 'item.completed', item: { id: 'fixture_thinking', type: 'reasoning', text: '' } });
      }
      if (completed && !toolStarted && fs.existsSync(path.join(process.cwd(), 'gui-start-tool'))) {
        toolStarted = true;
        trace('tool.started', 'fixture_tool');
        emit({ type: 'item.started', item: { id: 'fixture_tool', type: 'command_execution', command: 'fixture tool', aggregated_output: '', status: 'in_progress' } });
      }
      if (!fs.existsSync(path.join(process.cwd(), 'gui-release-thinking'))) return;
      clearInterval(timer);
      trace('gate-released');
      if (toolStarted) emit({ type: 'item.completed', item: { id: 'fixture_tool', type: 'command_execution', command: 'fixture tool', aggregated_output: 'done', status: 'completed', exit_code: 0 } });
      emit({ type: 'item.completed', item: { id: 'fixture_answer', type: 'agent_message', text: 'Synthetic thinking complete' } });
      trace('turn.completed');
      emit({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
    }, 50);
    return;
  }
  if (prompt.includes('EMIT_DIFF')) {
    const file = prompt.match(/EMIT_DIFF\s+(\S+)/)?.[1] || 'note.txt';
    emit({ type: 'item.completed', item: { id: 'item_diff', type: 'file_change', status: 'completed', changes: [{ kind: 'update', path: file, previousText: 'original\n' }] } });
  }
  emit({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'read fixture', aggregated_output: '', status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'read fixture', aggregated_output: 'fixture content', status: 'completed', exit_code: 0 } });
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: `fixture answer ${invocations.length}: ${prompt.trim()}` } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
});
}
