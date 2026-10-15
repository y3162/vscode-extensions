#!/usr/bin/env node
// Real Codex SDK transport, deterministic agent output; no network credentials needed.
const fs = require('node:fs');
const path = require('node:path');
const cwdIndex = process.argv.indexOf('--cd');
if (cwdIndex >= 0) process.chdir(process.argv[cwdIndex + 1]);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const file = path.join(process.cwd(), 'invocations.json');
  const invocations = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  invocations.push({ args: process.argv.slice(2), prompt });
  fs.writeFileSync(file, JSON.stringify(invocations));
  emit({ type: 'thread.started', thread_id: 'fixture-thread' });
  emit({ type: 'turn.started' });
  if (prompt.includes('WAIT_FOR_STOP')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes('SIMULATE_ERROR')) {
    emit({ type: 'turn.failed', error: { message: 'fixture backend error' } });
    return;
  }
  emit({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'read fixture', aggregated_output: '', status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'read fixture', aggregated_output: 'fixture content', status: 'completed', exit_code: 0 } });
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: `fixture answer ${invocations.length}: ${prompt.trim()}` } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
});
