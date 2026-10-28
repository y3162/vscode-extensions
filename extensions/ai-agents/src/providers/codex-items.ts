export type ThreadItem =
  | { id: string; type: 'agent_message' | 'reasoning'; text: string }
  | { id: string; type: 'error'; message: string }
  | { id: string; type: 'command_execution'; command: string; aggregated_output: string; status: string; exit_code?: number }
  | { id: string; type: 'file_change'; status: string; changes: { path: string; kind: string }[] }
  | { id: string; type: 'mcp_tool_call'; server: string; tool: string; status: string; arguments?: unknown; result?: unknown; error?: { message: string } }
  | { id: string; type: 'web_search'; query: string }
  | { id: string; type: 'todo_list'; items: { text: string; completed: boolean }[] };
