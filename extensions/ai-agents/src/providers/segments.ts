import { mergeStreamText } from './stream-text.js';

// Splits assistant text so text before a tool call is not the same message as the final answer.
export class AssistantSegments {
  private sequence = 0;
  private accumulated = '';
  private base = '';
  private id = '';
  private open = false;

  constructor(private readonly strictDeltas = false) {}

  interrupt(): void {
    this.open = false;
    this.base = this.accumulated;
  }

  fullText(): string {
    return this.accumulated;
  }

  push(incoming: string, kind: 'delta' | 'snapshot' = 'delta'): { id: string; text: string } | undefined {
    if (!incoming) return undefined;
    if (!this.open) {
      this.sequence += 1;
      this.id = `assistant-${this.sequence}`;
      this.base = this.accumulated;
      this.open = true;
    }
    this.accumulated = kind === 'snapshot' ? incoming
      : this.strictDeltas ? this.accumulated + incoming : mergeStreamText(this.accumulated, incoming);
    const segment = this.accumulated.startsWith(this.base)
      ? this.accumulated.slice(this.base.length).replace(/^\n+/, '')
      : this.accumulated;
    if (!segment) return undefined;
    return { id: this.id, text: segment };
  }
}
