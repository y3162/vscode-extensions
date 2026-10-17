import type { ChatMessage } from '../types.js';
function record(value: unknown): Record<string, any> { return value && typeof value === 'object' ? value as Record<string, any> : {}; }
/** Agent.messages.list returns persisted conversation turns, not SDK stream content blocks. */
export function cursorStoredMessages(rows: { uuid: string; message: unknown }[], runs: { id: string; createdAt?: number }[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  const sorted = [...runs].filter((run) => run.createdAt !== undefined).sort((a, b) => a.createdAt! - b.createdAt!);
  for (const row of rows) {
    const body = record(row.message);
    const union = record(body.turn);
    const turn = record(body.agentConversationTurn ?? (union.case === 'agentConversationTurn' ? union.value : undefined));
    const user = record(turn.userMessage);
    const at = Number(user.startedAtMs);
    const backendTurnId = Number.isFinite(at) ? sorted.filter((run) => run.createdAt! <= at).at(-1)?.id : undefined;
    const common = { ...(backendTurnId ? { backendTurnId } : {}), ...(Number.isFinite(at) ? { at } : {}) };
    if (typeof user.text === 'string') result.push({ ...common, id: `${row.uuid}:user`, role: 'user', text: user.text });
    let assistant = 0;
    for (const [index, raw] of (Array.isArray(turn.steps) ? turn.steps : []).entries()) {
      const message = record(record(raw).message);
      const step = message.case ? { [message.case]: message.value } : record(raw); const id = `${row.uuid}:step-${index}`;
      if (typeof record(step.assistantMessage).text === 'string') result.push({ ...common, id, backendId: `assistant-${++assistant}`, role: 'assistant', text: step.assistantMessage.text });
      else if (typeof record(step.thinkingMessage).text === 'string') result.push({ ...common, id, role: 'status', text: step.thinkingMessage.text, meta: { type: 'thinking' } });
      else if (step.toolCall) result.push({ ...common, id, role: 'tool', text: JSON.stringify(step.toolCall, null, 2), tool: { kind: 'other', name: Object.keys(record(step.toolCall))[0] ?? 'tool', status: 'completed' } });
    }
    const last = result.filter((message) => message.id.startsWith(`${row.uuid}:`) && message.role === 'assistant').at(-1); if (last) last.final = true;
  }
  return result;
}
